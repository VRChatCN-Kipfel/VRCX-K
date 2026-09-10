// Dev-mode per-entry plugin reload (issue #11, P2/P3).
//
// Scope and boundaries (see host/WATCHER.md and .temp/issue-11-plan.md):
//  - This module performs *plugin-level* reloads entirely inside the Cordis
//    runtime: dispose the old fiber (suppressing Loader's unload==disable
//    write-back), drop the entry's require.cache keys, re-import the entry
//    module, and rebuild a fiber on the entry's own context so Loader links
//    `fiber.entry` again. It never spawns, supervises, or exits the host.
//  - Failure handling is layered (never a fake transaction):
//      Phase A (import/validation)  -> strong rollback, old fiber untouched.
//      Phase B (apply/init)         -> best-effort restore of the old module,
//                                       otherwise restart-required.
//  - `restart-required` is *reported* only. The caller decides how to surface
//    it (structured event / Rust-owned facade / exit 51) — never automatic
//    here, and never on every save.
//  - Single reload timeout is 10s (below the 25s host stop hard cap).

import { realpathSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import type { Entry } from "@cordisjs/plugin-loader"

export const RELOAD_TIMEOUT_MS = 10_000

export type ReloadStatus =
  | "reloaded"          // new fiber is active
  | "kept-old"          // Phase A failed before old fiber was touched
  | "restored-old"      // Phase B failed, old module was rebuilt
  | "restart-required"  // could not restore; caller decides next step
  | "timeout"           // a swap/await phase timed out: the live state is unknown
  | "skipped"           // no fiber / entry disabled / nothing to do

export type ReloadResult = {
  status: ReloadStatus
  entryId: string
  phase?: "prepare" | "import" | "swap" | "restore"
  error?: unknown
  durationMs: number
}

export type ReloadLogger = (line: string) => void

const noopLog: ReloadLogger = () => {}

/**
 * A phase exceeded `timeoutMs`. Distinguished from an ordinary plugin error
 * because a timed-out phase leaves the *live* state unknown (the abandoned
 * promise may still complete later), which is what makes the `timeout`
 * ReloadStatus reachable.
 */
export class ReloadTimeoutError extends Error {
  readonly label: string
  readonly timeoutMs: number

  constructor(label: string, timeoutMs: number) {
    super(`reload ${label} timed out after ${timeoutMs}ms`)
    this.name = "ReloadTimeoutError"
    this.label = label
    this.timeoutMs = timeoutMs
  }
}

function isTimeout(error: unknown): error is ReloadTimeoutError {
  return error instanceof ReloadTimeoutError
}

/**
 * Module cache used for invalidation.
 *
 * `require.cache` is a CJS-interop binding, not a global: referencing it as a
 * default argument throws when this module is imported in a pure ESM context
 * (no lexical `require`). Resolve it lazily, preferring an existing global
 * `require`, then the ESM `createRequire` bridge (Bun/Node expose the same
 * object), and degrade to an empty cache instead of crashing.
 */
let esmRequire: ReturnType<typeof createRequire> | undefined

export function moduleCache(): Record<string, unknown> {
  const globalRequire = (globalThis as { require?: { cache?: Record<string, unknown> } }).require
  if (globalRequire?.cache) return globalRequire.cache
  try {
    esmRequire ??= createRequire(import.meta.url)
    return esmRequire.cache ?? {}
  } catch {
    return {}
  }
}

/**
 * Resolve the longest existing path prefix via realpathSync (never throws).
 * A cache key may be spelled lexically (`/var/...`) while the binding root is
 * real (`/private/var/...`) or vice versa; both keys must collapse to the same
 * comparison space. Non-existent tails stay lexical; total failure returns the
 * input unchanged.
 */
function realPath(input: string): string {
  const tail: string[] = []
  let cursor = input
  for (;;) {
    try {
      const real = realpathSync(cursor)
      return tail.length ? real + "/" + tail.reverse().join("/") : real
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return input
      tail.push(cursor.slice(parent.length + 1))
      cursor = parent
    }
  }
}

/** Fold a path to a lowercase, `/`-separated comparison key. */
function fold(input: string): string {
  return input.replaceAll("\\", "/").toLowerCase()
}

/**
 * Collect the require.cache keys that belong to the given directory roots.
 * On Bun the keys are absolute filesystem paths (not file: URLs). Only keys
 * under an explicit root are dropped — host/Cordis/node_modules never are.
 *
 * Both sides are matched in the realpath key space AND the lexical key space:
 * a cache key may be spelled `/private/var/...` where the root is `/var/...`
 * (macOS tmpdir symlink) or `C:\Users\RUNNER~1\...` vs `C:\Users\runneradmin\...`
 * (Windows 8.3 short name). Matching either spelling keeps the old module
 * from surviving a reload on those platforms.
 */
export function collectCacheKeysUnderRoots(
  roots: string[],
  cache: Record<string, unknown> = moduleCache(),
): string[] {
  const lexicalRoots = roots.map(fold)
  const realRoots = roots.map((root) => fold(realPath(root)))
  const keys: string[] = []
  for (const key of Object.keys(cache)) {
    const lexical = fold(key)
    const real = fold(realPath(key))
    const inSpace = (space: string[], probe: string) =>
      space.some((root) => probe.startsWith(root + "/") || probe === root)
    if (inSpace(lexicalRoots, lexical) || inSpace(realRoots, real)) {
      keys.push(key)
    }
  }
  return keys
}

/** Drop module cache entries under `roots`. Returns the number of dropped keys. */
export function invalidateCache(roots: string[], cache: Record<string, unknown> = moduleCache()): number {
  const keys = collectCacheKeysUnderRoots(roots, cache)
  for (const key of keys) delete cache[key]
  return keys.length
}

export type ReloadDeps = {
  /** Import a fresh copy of the entry module through the owning tree. */
  loadEntryModule: (entry: Entry) => Promise<unknown>
  /** Create a new fiber for `plugin` on the entry's context. */
  pluginOnEntryCtx: (entry: Entry, plugin: unknown, config: unknown) => Promise<unknown>
  /** Absolute file: base URL used to resolve relative entry names. Defaults to the tree ctx's baseUrl. */
  baseUrl?: string
  /** Module cache to invalidate (defaults to the runtime `require.cache`). */
  cache?: Record<string, unknown>
  log?: ReloadLogger
  timeoutMs?: number
}

function isPlugin(value: unknown): boolean {
  if (typeof value === "function") return true
  if (value && typeof value === "object" && typeof (value as { apply?: unknown }).apply === "function") return true
  return false
}

/**
 * Reload one Cordis Entry's code.
 *
 * Returns a ReloadResult describing what happened. This function never throws
 * for plugin-authored failures — they are folded into the result status.
 */
export async function reloadPluginEntry(entry: Entry, roots: string[], deps: ReloadDeps): Promise<ReloadResult> {
  const log = deps.log ?? noopLog
  const timeoutMs = deps.timeoutMs ?? RELOAD_TIMEOUT_MS
  const started = performance.now()
  const entryId = entry.id
  const oldFiber = entry.fiber
  const config = entry.options.config ?? {}

  if (!oldFiber || oldFiber.uid === null) {
    return { status: "skipped", entryId, phase: "prepare", durationMs: performance.now() - started }
  }

  // Snapshot the old plugin callback so we can restore it if the new apply fails.
  const oldCallback = (oldFiber as unknown as { runtime?: { callback?: unknown } }).runtime?.callback

  // The entry's own module file (lexical, absolute) is always part of the
  // invalidation set; `roots` covers imported siblings/helpers.
  const baseUrl = deps.baseUrl ?? (entry.parent.tree.ctx as unknown as { baseUrl?: string }).baseUrl
  const entryFile = entry.options.name.startsWith(".") && baseUrl
    ? fileURLToPath(new URL(entry.options.name, baseUrl))
    : entry.options.name
  const cache = deps.cache ?? moduleCache()
  const invalidationSet = new Set<string>(collectCacheKeysUnderRoots(roots, cache))
  invalidationSet.add(entryFile)

  // Snapshot the current cache entries for those keys so we can restore them
  // on a Phase A failure (strong rollback).
  const cacheSnapshot = new Map<string, unknown>()
  for (const key of invalidationSet) {
    const existing = cache[key]
    if (existing !== undefined) cacheSnapshot.set(key, existing)
    delete cache[key]
  }

  // ── Phase A: import the replacement module (fresh) ──────────────────────
  let newModule: unknown
  try {
    newModule = await withTimeout(deps.loadEntryModule(entry), timeoutMs, "import")
  } catch (error) {
    // Strong rollback: restore the cache exactly as it was; old fiber untouched.
    for (const [key, value] of cacheSnapshot) {
      cache[key] = value
    }
    log(`[dev-watch] ${entryId}: import failed — keeping old fiber`)
    // Even when the import TIMED OUT the old module is fully restored here, so
    // the live state is known → kept-old (never "timeout").
    return { status: "kept-old", entryId, phase: "import", error, durationMs: performance.now() - started }
  }
  if (!isPlugin(newModule)) {
    for (const [key, value] of cacheSnapshot) {
      cache[key] = value
    }
    return {
      status: "kept-old",
      entryId,
      phase: "import",
      error: new TypeError(`module does not export a plugin (got ${typeof newModule})`),
      durationMs: performance.now() - started,
    }
  }

  // ── Phase B: swap — dispose old, drop cache, rebuild on the entry ctx ───
  // Suppress Loader's `internal/plugin` unload handler, which would mark the
  // entry disabled and write it back to cordis.yml (unload == disable
  // semantics). lifecycle.ts uses the same lever.
  const wasDisabled = entry.options.disabled
  entry.options.disabled = true
  let disposeError: unknown
  try {
    try {
      await withTimeout(oldFiber.dispose(), timeoutMs, "dispose")
    } catch (error) {
      disposeError = error
    }
  } finally {
    entry.options.disabled = wasDisabled
  }
  if (disposeError) {
    // Old fiber failed to dispose; the entry may be half-torn. Do not rebuild
    // over it. A *timeout* means the abandoned disposer may still be running,
    // so we genuinely do not know the live state → `timeout`; any other error
    // is a real failure → `restart-required`.
    return {
      status: isTimeout(disposeError) ? "timeout" : "restart-required",
      entryId,
      phase: "swap",
      error: disposeError,
      durationMs: performance.now() - started,
    }
  }

  // Rebuild the fiber on the entry's context so Loader links entry.fiber.
  let newFiber: unknown
  try {
    newFiber = await withTimeout(deps.pluginOnEntryCtx(entry, newModule, config), timeoutMs, "swap")
  } catch (error) {
    log(`[dev-watch] ${entryId}: new fiber failed (${String(error)}) — attempting restore`)
    const restored = await tryRestoreOld(entry, oldCallback, config, deps, timeoutMs, log)
    if (restored) {
      return { status: "restored-old", entryId, phase: "swap", error, durationMs: performance.now() - started }
    }
    // Restore failed. If the swap itself timed out, the abandoned fiber may
    // still come up: the live state is unknown → `timeout`.
    return {
      status: isTimeout(error) ? "timeout" : "restart-required",
      entryId,
      phase: "swap",
      error,
      durationMs: performance.now() - started,
    }
  }

  // Link the new fiber back to the entry.
  ;(entry as unknown as { fiber?: unknown }).fiber = newFiber
  try {
    await withTimeout((newFiber as { await(): Promise<unknown> }).await(), timeoutMs, "await")
  } catch (error) {
    log(`[dev-watch] ${entryId}: new fiber await failed — attempting restore`)
    const restored = await tryRestoreOld(entry, oldCallback, config, deps, timeoutMs, log)
    if (restored) {
      return { status: "restored-old", entryId, phase: "swap", error, durationMs: performance.now() - started }
    }
    // Same reasoning as the swap branch: an await timeout leaves the new fiber
    // in an unknown state, so report `timeout` rather than a definite failure.
    return {
      status: isTimeout(error) ? "timeout" : "restart-required",
      entryId,
      phase: "swap",
      error,
      durationMs: performance.now() - started,
    }
  }

  return { status: "reloaded", entryId, durationMs: performance.now() - started }
}

/** Best-effort restore: rebuild a fiber from the old callback + old config. */
async function tryRestoreOld(
  entry: Entry,
  oldCallback: unknown,
  config: unknown,
  deps: ReloadDeps,
  timeoutMs: number,
  log: ReloadLogger,
): Promise<boolean> {
  const entryId = entry.id
  if (!oldCallback) {
    log(`[dev-watch] ${entryId}: no old callback to restore`)
    return false
  }
  try {
    const fiber = await withTimeout(deps.pluginOnEntryCtx(entry, oldCallback, config), timeoutMs, "restore")
    ;(entry as unknown as { fiber?: unknown }).fiber = fiber
    await withTimeout((fiber as { await(): Promise<unknown> }).await(), timeoutMs, "restore-await")
    log(`[dev-watch] ${entryId}: restored old plugin`)
    return true
  } catch (error) {
    log(`[dev-watch] ${entryId}: restore failed — restart-required (${String(error)})`)
    return false
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReloadTimeoutError(label, ms)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
