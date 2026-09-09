// Dev-mode watcher orchestration (issue #11, P1/P4).
//
// Owns the mapping between watched file events and Cordis loader Entries, the
// per-entry reload queue, and the debounced include-config refresh. It is
// dev-only (explicitly gated by the caller) and deliberately thin:
//
//   - File watching itself lives in HostWatcher (host/src/watcher.ts).
//   - Canonical path mapping lives in watch-path.ts (single source of truth:
//     DevWatch no longer carries its own copy of the matcher).
//   - One reload transaction lives in dev-reload.ts (reloadPluginEntry).
//
// Boundary rules (see host/WATCHER.md):
//   - This module never manages the host process. `restart-required` outcomes
//     are surfaced through `onState` so the caller can decide whether to ask
//     the Rust-owned shell for a restart (existing stdio/exit-51 path).
//   - Include refresh happens on the Include EntryTree, never by rewriting
//     cordis.yml from here.
//   - Once shutdown has begun (`isStopping()` / `ctx.signal.stopping`) no new
//     reload is started; `close()` is the only thing that awaits in-flight
//     reloads, so the caller MUST return its promise from the disposer
//     (`attachDevWatch` does exactly that).

import { watch } from "chokidar"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Context } from "cordis"
import type { Entry, EntryTree } from "@cordisjs/plugin-loader"
import {
  binding,
  canonicalExistingPath,
  canonicalPath,
  mapPath,
  type EntryBinding,
} from "./watch-path"
import { reloadPluginEntry, type ReloadResult } from "./dev-reload"

export type DevWatchEvent =
  | { type: "started"; roots: string[] }
  | { type: "config-refreshed"; entries: string[] }
  | { type: "config-error"; error: unknown }
  | { type: "change"; path: string; entryIds: string[] }
  | { type: "unowned"; path: string }
  | { type: "ambiguous"; path: string; entryIds: string[] }
  | { type: "reload"; entryId: string; result: ReloadResult }
  | { type: "watcher-error"; error: unknown }
  | { type: "closed" }

export type IncludeTree = EntryTree & {
  refresh(): Promise<void>
  await?(): Promise<void>
}

export type DevWatchOptions = {
  /** The Include EntryTree that owns the plugin entries (from its loader Entry's `.subtree`). */
  include: IncludeTree
  /** Absolute path of the cordis.yml file. */
  configFile: string
  /**
   * Optional per-entry explicit roots: entryId -> list of directories (or a
   * single entry file). A changed file inside one of these roots reloads that
   * entry; without an explicit root the entry's own file is the only root.
   */
  devMap?: Record<string, string[]>
  /**
   * Explicit additional watch roots (dev override). These directories (or a
   * file, in which case its directory) are always watched, whether or not an
   * entry maps to them; they do NOT by themselves map a change to an entry —
   * use `devMap` for that.
   */
  roots?: string[]
  debounceMs?: number
  /**
   * Upper bound on how long a continuous write burst may postpone the trailing
   * debounce flush (default `max(debounceMs * 4, 1000)`). Without it a save
   * every < debounceMs postpones the flush forever.
   */
  maxWaitMs?: number
  /** Per-reload timeout (default 10s, see dev-reload). */
  timeoutMs?: number
  /** Called for every structured dev-watch event. */
  onState?: (event: DevWatchEvent) => void
  /**
   * Called when a reload failed so badly that a whole-host restart is the
   * only safe recovery (status `restart-required`). The host never restarts
   * itself from here — the caller decides (e.g. reuse the stdio exit-51 path
   * when a shell is attached). Rate-limited per entry by the caller.
   */
  onRestartRequired?: (info: { entryId: string; error?: unknown }) => void
  /**
   * Shutdown gate. Once it returns true no file event is routed and no reload
   * is enqueued (root disposables run last in gracefulStop, so `closed` alone
   * is too late). `attachDevWatch` wires it to `ctx.signal.stopping`.
   */
  isStopping?: () => boolean
}

type ReloadQueueEntry = {
  running: Promise<void> | null
  pendingPaths: Set<string>
}

type BoundEntry = {
  entry: Entry
  binding: EntryBinding
}
export class DevWatch {
  private readonly include: IncludeTree
  private readonly configFile: string
  private readonly devMap: Map<string, string[]>
  private readonly extraRoots: string[]
  private readonly onState?: (event: DevWatchEvent) => void
  private readonly onRestartRequired?: (info: { entryId: string; error?: unknown }) => void
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly timeoutMs?: number
  private isStopping: () => boolean
  private chokidar?: ReturnType<typeof watch>
  private queues = new Map<string, ReloadQueueEntry>()
  private configTimer?: ReturnType<typeof setTimeout>
  private fsTimer?: ReturnType<typeof setTimeout>
  private fsPending = new Map<string, "add" | "change" | "unlink">()
  private fsFirstPendingAt = 0
  private closed = false
  private configContentHash?: string
  private watchRoots = new Set<string>()
  /** entryId -> (entry, canonical binding) */
  private bindings = new Map<string, BoundEntry>()

  constructor(options: DevWatchOptions) {
    this.include = options.include
    this.configFile = options.configFile
    this.devMap = new Map(Object.entries(options.devMap ?? {}))
    this.extraRoots = [...(options.roots ?? [])]
    this.onState = options.onState
    this.onRestartRequired = options.onRestartRequired
    this.timeoutMs = options.timeoutMs
    this.isStopping = options.isStopping ?? (() => false)
    // 250ms trailing debounce: Windows chokidar often emits a second
    // (delayed) event for the same atomic-save rename; a single logical save
    // must map to a single reload.
    this.debounceMs = options.debounceMs ?? 250
    this.maxWaitMs = options.maxWaitMs ?? Math.max(this.debounceMs * 4, 1000)
  }

  /** Replace the shutdown gate (see `isStopping`). */
  setStoppingGate(isStopping: () => boolean): void {
    this.isStopping = isStopping
  }

  /** entryId for an Entry, stable across include-tree renames. */
  private entryId(entry: Entry): string {
    return entry.id
  }

  /**
   * Build the canonical binding for an entry: its own module file (exact match
   * wins) plus the explicit devMap roots (longest root wins).
   */
  private entryBinding(entry: Entry): EntryBinding | undefined {
    const id = this.entryId(entry)
    const explicit = this.devMap.get(id) ?? []
    const name = entry.options.name
    try {
      const own = name.startsWith(".")
        ? fileURLToPath(new URL(name, entry.parent.tree.ctx.baseUrl))
        : name
      return binding(id, own, explicit)
    } catch (error) {
      // A non-file entry name (e.g. a bare module specifier) cannot be
      // watched; skip it instead of poisoning every path mapping.
      this.log(`entry ${id}: unwatchable name "${name}" (${String(error)})`)
      return undefined
    }
  }

  /** Refresh the entry→binding index from the current include tree. */
  private rebuildBindings(): string[] {
    this.bindings.clear()
    const entryIds: string[] = []
    for (const entry of this.include.entries()) {
      // Skip group entries and disabled entries.
      if ((entry as unknown as { options?: { group?: boolean } }).options?.group) continue
      if ((entry as unknown as { disabled?: boolean }).disabled) continue
      const id = this.entryId(entry)
      const bound = this.entryBinding(entry)
      if (!bound) continue
      this.bindings.set(id, { entry, binding: bound })
      entryIds.push(id)
    }
    return entryIds
  }

  /** Absolute canonical path of the config file (for the include watcher). */
  get configPath(): string {
    return canonicalPath(this.configFile)
  }

  get activeEntryIds(): string[] {
    return [...this.bindings.keys()]
  }

  /** Root directories currently handed to chokidar. */
  get watchedRoots(): string[] {
    return [...this.watchRoots]
  }

  private log(line: string) {
    console.error(`[dev-watch] ${line}`)
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /**
   * Watch roots: config dir (for cordis.yml) + every binding root's directory
   * + explicit `roots` overrides.
   */
  private async computeWatchRoots(): Promise<string[]> {
    const roots = new Set<string>()
    roots.add(dirname(this.configFile))
    for (const extra of this.extraRoots) {
      roots.add(await dirWatchRoot(isAbsolute(extra) ? extra : resolve(extra)))
    }
    for (const { binding: bound } of this.bindings.values()) {
      // The entry's own file (or dir) plus every explicit root; a file root is
      // watched through its directory.
      roots.add(await dirWatchRoot(fileURLToPath(bound.entryUrl)))
      for (const root of bound.roots) roots.add(await dirWatchRoot(root))
    }
    return [...roots]
  }

  async start(): Promise<void> {
    if (this.chokidar || this.closed) return
    this.rebuildBindings()

    const watchRoots = await this.computeWatchRoots()
    // close() may have run during the async root scan; do not leak a watcher.
    if (this.closed) return
    for (const root of watchRoots) this.watchRoots.add(root)
    this.chokidar = watch(watchRoots, {
      ignoreInitial: true,
      atomic: 100,
      followSymlinks: false,
      ignored: (p: string) => {
        const norm = p.replaceAll("\\", "/")
        if (norm.includes("/node_modules/") || norm.includes("/.git/") || norm.includes("/dist/")) return true
        // Editor temp/swap artifacts (incl. Include's own temp+rename writes).
        const base = norm.slice(norm.lastIndexOf("/") + 1)
        return base.endsWith(".tmp") || base.startsWith(".#") || base.endsWith(".swp") || base.startsWith("~$")
      },
    })
    this.chokidar.on("ready", () => {
      this.onState?.({ type: "started", roots: [...this.watchRoots] })
      // Prime config content hash so we don't react to our own initial read.
      void this.readConfigHash()
    })
    this.chokidar.on("error", (error) => this.onState?.({ type: "watcher-error", error }))
    for (const event of ["add", "change", "unlink"] as const) {
      this.chokidar.on(event, (path: string) => this.handleFsEvent(event, path))
    }
  }

  /**
   * Watch roots added since the last scan (new include entries may live in
   * directories that were not watched at start()).
   */
  private async addNewWatchRoots(): Promise<string[]> {
    const next = await this.computeWatchRoots()
    const added = next.filter((root) => !this.watchRoots.has(root))
    if (!added.length) return added
    for (const root of added) this.watchRoots.add(root)
    // chokidar 4 supports incremental `add`; without it a cordis.yml that
    // introduces a new plugin directory would never be watched.
    this.chokidar?.add(added)
    this.log(`now watching new root(s): ${added.join(", ")}`)
    return added
  }

  async close(): Promise<void> {
    if (this.closed && !this.chokidar) return
    this.closed = true
    if (this.configTimer) clearTimeout(this.configTimer)
    this.configTimer = undefined
    if (this.fsTimer) clearTimeout(this.fsTimer)
    this.fsTimer = undefined
    this.fsPending.clear()
    this.fsFirstPendingAt = 0
    const watcher = this.chokidar
    this.chokidar = undefined
    if (watcher) await watcher.close()
    // Wait for in-flight reloads (bounded by their own timeout).
    await Promise.allSettled([...this.queues.values()].map((q) => q.running).filter((p): p is Promise<void> => !!p))
    this.queues.clear()
    this.onState?.({ type: "closed" })
  }

  // ── file event routing ──────────────────────────────────────────────────

  private handleFsEvent(kind: "add" | "change" | "unlink", path: string): void {
    // No routing once shutdown began: a reload started now would race the
    // fiber teardown (and its close() would not be awaited by anything).
    if (this.closed || this.isStopping()) return
    // Config file changes go to the debounced include-refresh channel.
    if (canonicalPath(path) === this.configPath) {
      this.scheduleConfigRefresh()
      return
    }
    // Everything else is trailing-debounced: a single logical save often
    // produces several chokidar events (Windows atomic-rename double events,
    // add+change pairs). Collect them for `debounceMs` of quiet, then route
    // the unique set once — but never postpone the flush beyond maxWaitMs.
    const now = Date.now()
    if (this.fsPending.size === 0) this.fsFirstPendingAt = now
    this.fsPending.set(path, kind)
    if (this.fsTimer) clearTimeout(this.fsTimer)
    const waited = now - this.fsFirstPendingAt
    const delay = waited >= this.maxWaitMs ? 0 : Math.min(this.debounceMs, this.maxWaitMs - waited)
    this.fsTimer = setTimeout(() => {
      void this.flushFs().catch((error) => this.onState?.({ type: "watcher-error", error }))
    }, delay)
  }

  private async flushFs(): Promise<void> {
    this.fsTimer = undefined
    this.fsFirstPendingAt = 0
    if (this.closed || this.isStopping()) return
    const pending = [...this.fsPending.keys()]
    this.fsPending.clear()
    const bindings = [...this.bindings.values()].map((item) => item.binding)
    for (const raw of pending) {
      try {
        const canonical = await canonicalExistingPath(raw)
        const mapping = mapPath(canonical, bindings)
        if (mapping.kind === "unowned") {
          this.onState?.({ type: "unowned", path: canonical })
          continue
        }
        if (mapping.kind === "ambiguous") {
          this.onState?.({ type: "ambiguous", path: canonical, entryIds: mapping.entryIds })
        }
        this.onState?.({ type: "change", path: canonical, entryIds: mapping.entryIds })
        for (const entryId of mapping.entryIds) {
          this.enqueueReload(entryId, canonical)
        }
      } catch (error) {
        // A path that cannot be canonicalized/mapped must never take down
        // routing for the remaining paths (flushFs runs detached).
        this.onState?.({ type: "watcher-error", error })
      }
    }
  }

  // ── per-entry reload queue (P2) ─────────────────────────────────────────

  private enqueueReload(entryId: string, path: string): void {
    if (this.closed || this.isStopping()) return
    let q = this.queues.get(entryId)
    if (!q) {
      q = { running: null, pendingPaths: new Set() }
      this.queues.set(entryId, q)
    }
    q.pendingPaths.add(path)
    this.kickQueue(entryId, q)
  }

  /**
   * At most one queue run per entry. `runQueue` drains `pendingPaths` itself,
   * so a path added while a run is in flight is picked up by that run; the
   * post-run re-kick only covers the window between the run's final empty
   * check and the settle callback.
   */
  private kickQueue(entryId: string, q: ReloadQueueEntry): void {
    if (q.running || this.closed || this.isStopping()) return
    const run = this.runQueue(entryId, q).finally(() => {
      q.running = null
      if (q.pendingPaths.size) this.kickQueue(entryId, q)
    })
    q.running = run
  }

  private async runQueue(entryId: string, q: ReloadQueueEntry): Promise<void> {
    const bound = this.bindings.get(entryId)
    if (!bound) return
    while (q.pendingPaths.size && !this.closed && !this.isStopping()) {
      const paths = [...q.pendingPaths]
      q.pendingPaths.clear()
      const result = await this.reloadOnce(entryId, bound.entry, bound.binding.roots, paths)
      this.onState?.({ type: "reload", entryId, result })
      if (result.status === "restart-required") {
        // A whole-host restart is the only safe recovery; surface it to the
        // caller (which may reuse the stdio exit-51 path when a shell is
        // attached). Never exit from inside the watcher.
        this.onRestartRequired?.({ entryId, error: result.error })
      }
    }
  }

  private async reloadOnce(entryId: string, entry: Entry, roots: string[], paths: string[]): Promise<ReloadResult> {
    // De-duplicate: if the entry was removed or disabled meanwhile, skip.
    const current = this.bindings.get(entryId)
    if (!current || current.entry !== entry) {
      return { status: "skipped", entryId, phase: "prepare", durationMs: 0 }
    }
    this.log(`reload ${entryId} (${paths.join(", ")})`)
    return reloadPluginEntry(entry, roots, {
      loadEntryModule: async (e) => {
        const exports = await e.parent.tree.import(e.options.name, e.getOuterStack)
        const loader = (e as unknown as { loader?: { unwrapExports(exports: unknown): unknown } }).loader
        return loader ? loader.unwrapExports(exports) : exports
      },
      pluginOnEntryCtx: async (e, plugin, config) => {
        const fiber = await (e.ctx as Context).plugin(plugin as never, config as never)
        return fiber
      },
      log: (line) => this.log(line),
      timeoutMs: this.timeoutMs,
    })
  }

  // ── include config refresh (P4) ─────────────────────────────────────────

  private scheduleConfigRefresh(): void {
    if (this.configTimer) clearTimeout(this.configTimer)
    this.configTimer = setTimeout(() => {
      this.configTimer = undefined
      void this.refreshConfig().catch((error) => this.onState?.({ type: "config-error", error }))
    }, this.debounceMs * 2)
  }

  private async readConfigHash(): Promise<string | undefined> {
    try {
      const content = await Bun.file(this.configFile).text()
      const hash = await Bun.hash(content).toString()
      this.configContentHash = hash
      return hash
    } catch {
      return undefined
    }
  }

  private async refreshConfig(): Promise<void> {
    if (this.closed || this.isStopping()) return
    const before = this.configContentHash
    const now = await this.readConfigHash()
    if (now && before === now) return // no content change (e.g. our own temp rename)
    try {
      await this.include.refresh()
    } catch (error) {
      this.log(`config refresh failed: ${String(error)}`)
      this.onState?.({ type: "config-error", error })
      return // keep current tree; retry on next change
    }
    // Rebuild bindings after the include tree settled, then make sure any new
    // entry directory is actually watched (D: the root set is not frozen).
    await this.include.await?.().catch(() => {})
    const ids = this.rebuildBindings()
    await this.addNewWatchRoots()
    this.onState?.({ type: "config-refreshed", entries: ids })
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Bun.file(path).stat()).isDirectory()
  } catch {
    return false
  }
}

/** A watch root is a directory; for a file root we watch its directory. */
async function dirWatchRoot(path: string): Promise<string> {
  return (await isDir(path)) ? path : dirname(path)
}

/**
 * Register a DevWatch with the host lifecycle:
 *
 *   - the shutdown gate is `ctx.signal.stopping`, so no file event is routed
 *     and no reload is enqueued once graceful stop began;
 *   - the disposer RETURNS `close()`'s promise. `gracefulStop` awaits disposer
 *     return values (lifecycle.ts), and `close()` is the only place that waits
 *     for in-flight reloads — returning `undefined` (as index.ts used to)
 *     silently dropped that wait.
 */
export function attachDevWatch(ctx: Context, watch: DevWatch): void {
  watch.setStoppingGate(() => (ctx as Context & { signal?: { stopping?: boolean } }).signal?.stopping === true)
  ctx.effect(() => () => watch.close())
}
