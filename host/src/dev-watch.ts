// Dev-mode watcher orchestration (issue #11, P1/P4).
//
// Owns the mapping between watched file events and Cordis loader Entries, the
// per-entry reload queue, and the debounced include-config refresh. It is
// dev-only (explicitly gated by the caller) and deliberately thin:
//
//   - File watching itself lives in HostWatcher (host/src/watcher.ts).
//   - Canonical path mapping lives in watch-path.ts.
//   - One reload transaction lives in dev-reload.ts (reloadPluginEntry).
//
// Boundary rules (see host/WATCHER.md):
//   - This module never manages the host process. `restart-required` outcomes
//     are surfaced through `onState` so the caller can decide whether to ask
//     the Rust-owned shell for a restart (existing stdio/exit-51 path).
//   - Include refresh happens on the Include EntryTree, never by rewriting
//     cordis.yml from here.

import { watch } from "chokidar"
import { realpath } from "node:fs/promises"
import { dirname, relative, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Context } from "cordis"
import type { Entry, EntryTree } from "@cordisjs/plugin-loader"
import { canonicalPath } from "./watch-path"
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
  /** Watched root directories (defaults to the include config's dir + plugin dirs). */
  roots?: string[]
  debounceMs?: number
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
}

type ReloadQueueEntry = {
  dirty: boolean
  running: Promise<void> | null
  pendingPaths: Set<string>
}

export class DevWatch {
  private readonly include: IncludeTree
  private readonly configFile: string
  private readonly devMap: Map<string, string[]>
  private readonly onState?: (event: DevWatchEvent) => void
  private readonly onRestartRequired?: (info: { entryId: string; error?: unknown }) => void
  private readonly debounceMs: number
  private readonly timeoutMs?: number
  private chokidar?: ReturnType<typeof watch>
  private queues = new Map<string, ReloadQueueEntry>()
  private configTimer?: ReturnType<typeof setTimeout>
  private fsTimer?: ReturnType<typeof setTimeout>
  private fsPending = new Map<string, "add" | "change" | "unlink">()
  private closed = false
  private configContentHash?: string
  /** entryId -> [entry, roots] */
  private bindings = new Map<string, { entry: Entry; roots: string[] }>()

  constructor(options: DevWatchOptions) {
    this.include = options.include
    this.configFile = options.configFile
    this.devMap = new Map(Object.entries(options.devMap ?? {}))
    this.onState = options.onState
    this.onRestartRequired = options.onRestartRequired
    this.timeoutMs = options.timeoutMs
    // 250ms trailing debounce: Windows chokidar often emits a second
    // (delayed) event for the same atomic-save rename; a single logical save
    // must map to a single reload.
    this.debounceMs = options.debounceMs ?? 250
  }

  /** entryId for an Entry, stable across include-tree renames. */
  private entryId(entry: Entry): string {
    return entry.id
  }

  /** Build the roots for an entry: explicit devMap roots + the entry's own file. */
  private entryRoots(entry: Entry): string[] {
    const id = this.entryId(entry)
    const explicit = this.devMap.get(id) ?? []
    const name = entry.options.name
    const own = name.startsWith(".")
      ? fileURLToPath(new URL(name, entry.parent.tree.ctx.baseUrl))
      : name
    const roots = new Set<string>([canonicalPath(own), ...explicit.map((p) => canonicalPath(p))])
    return [...roots]
  }

  /** Refresh the entry→bindings index from the current include tree. */
  private rebuildBindings(): string[] {
    this.bindings.clear()
    const entryIds: string[] = []
    for (const entry of this.include.entries()) {
      // Skip group entries and disabled entries.
      if ((entry as unknown as { options?: { group?: boolean } }).options?.group) continue
      if ((entry as unknown as { disabled?: boolean }).disabled) continue
      const id = this.entryId(entry)
      this.bindings.set(id, { entry, roots: this.entryRoots(entry) })
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

  private log(line: string) {
    console.error(`[dev-watch] ${line}`)
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.chokidar || this.closed) return
    this.rebuildBindings()

    // Watch roots: config dir (for cordis.yml) + every binding root's directory.
    const watchRoots = new Set<string>()
    watchRoots.add(dirname(this.configFile))
    for (const { roots } of this.bindings.values()) {
      for (const root of roots) {
        // root may be a file → watch its directory.
        watchRoots.add(isAbsolute(root) ? (await isDir(root) ? root : dirname(root)) : resolve(dirname(this.configFile), root))
      }
    }
    this.chokidar = watch([...watchRoots], {
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
      this.onState?.({ type: "started", roots: [...watchRoots] })
      // Prime config content hash so we don't react to our own initial read.
      void this.readConfigHash()
    })
    this.chokidar.on("error", (error) => this.onState?.({ type: "watcher-error", error }))
    for (const event of ["add", "change", "unlink"] as const) {
      this.chokidar.on(event, (path: string) => this.handleFsEvent(event, path))
    }
  }

  async close(): Promise<void> {
    if (this.closed && !this.chokidar) return
    this.closed = true
    if (this.configTimer) clearTimeout(this.configTimer)
    this.configTimer = undefined
    if (this.fsTimer) clearTimeout(this.fsTimer)
    this.fsTimer = undefined
    this.fsPending.clear()
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
    if (this.closed) return
    // Config file changes go to the debounced include-refresh channel.
    if (canonicalPath(path) === this.configPath) {
      this.scheduleConfigRefresh()
      return
    }
    // Everything else is trailing-debounced: a single logical save often
    // produces several chokidar events (Windows atomic-rename double events,
    // add+change pairs). Collect them for `debounceMs` of quiet, then route
    // the unique set once.
    this.fsPending.set(path, kind)
    if (this.fsTimer) clearTimeout(this.fsTimer)
    this.fsTimer = setTimeout(() => void this.flushFs(), this.debounceMs)
  }

  private async flushFs(): Promise<void> {
    this.fsTimer = undefined
    if (this.closed) return
    const pending = [...this.fsPending.keys()]
    this.fsPending.clear()
    for (const raw of pending) {
      const canonical = await canonicalExistingOrLexical(raw)
      const matches = this.matchEntry(canonical)
      if (!matches) {
        this.onState?.({ type: "unowned", path: canonical })
        continue
      }
      if (matches.length > 1) {
        this.onState?.({ type: "ambiguous", path: canonical, entryIds: matches })
      }
      this.onState?.({ type: "change", path: canonical, entryIds: matches })
      for (const entryId of matches) {
        this.enqueueReload(entryId, canonical)
      }
    }
  }

  /** Map a canonical file path to entryIds (exact entry file, else longest root). */
  private matchEntry(canonicalPathValue: string): string[] | null {
    let bestLength = -1
    let matches: string[] = []
    for (const [id, { entry, roots }] of this.bindings) {
      const entryFile = canonicalPath(
        entry.options.name.startsWith(".")
          ? fileURLToPath(new URL(entry.options.name, entry.parent.tree.ctx.baseUrl))
          : entry.options.name,
      )
      if (entryFile === canonicalPathValue) {
        return [id] // exact entry file wins
      }
      for (const root of roots) {
        const rel = relative(root, canonicalPathValue)
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue
        if (root.length > bestLength) {
          bestLength = root.length
          matches = [id]
        } else if (root.length === bestLength) {
          matches.push(id)
        }
      }
    }
    return matches.length ? [...new Set(matches)] : null
  }

  // ── per-entry reload queue (P2) ─────────────────────────────────────────

  private enqueueReload(entryId: string, path: string): void {
    let q = this.queues.get(entryId)
    if (!q) {
      q = { dirty: false, running: null, pendingPaths: new Set() }
      this.queues.set(entryId, q)
    }
    q.pendingPaths.add(path)
    if (!q.running) {
      q.running = this.runQueue(entryId, q).finally(() => {
        q.running = null
        if (q.pendingPaths.size && !this.closed) void this.runQueue(entryId, q)
      })
    } else {
      q.dirty = true
    }
  }

  private async runQueue(entryId: string, q: ReloadQueueEntry): Promise<void> {
    const bindingEntry = this.bindings.get(entryId)
    if (!bindingEntry) return
    while (q.pendingPaths.size && !this.closed) {
      q.dirty = false
      const paths = [...q.pendingPaths]
      q.pendingPaths.clear()
      const result = await this.reloadOnce(entryId, bindingEntry.entry, bindingEntry.roots, paths)
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
      void this.refreshConfig()
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
    if (this.closed) return
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
    // Rebuild bindings after the include tree settled.
    await this.include.await?.().catch(() => {})
    const ids = this.rebuildBindings()
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

async function canonicalExistingOrLexical(path: string): Promise<string> {
  try {
    return canonicalPath(await realpath(path))
  } catch {
    return canonicalPath(path)
  }
}

/**
 * Create and start the dev watcher for a live context.
 *
 * @param ctx          the root Cordis context
 * @param includeEntry the loader Entry whose `.subtree` is the Include tree
 * @param options      config path / dev map / roots / callbacks
 */
export function startDevWatch(ctx: Context, includeEntry: Entry, options: Omit<DevWatchOptions, "include"> & { configFile: string }): DevWatch {
  const include = includeEntry.subtree as IncludeTree | undefined
  if (!include) throw new Error("include entry has no subtree yet — start dev watch after include init")
  void ctx
  const watch = new DevWatch({ ...options, include })
  void watch.start()
  return watch
}
