import { watch, type FSWatcher, type ChokidarOptions } from "chokidar"
import { statSync } from "node:fs"
import { isAbsolute, resolve, sep } from "node:path"
import type { EntryBinding, MappingResult } from "./watch-path"
import { canonicalPath, mapPath } from "./watch-path"

export type WatcherEvent = {
  type: "started" | "change" | "unowned" | "ambiguous" | "error" | "closed"
  path?: string
  mapping?: MappingResult
  error?: unknown
}

export type HostWatcherOptions = ChokidarOptions & {
  roots: string[]
  debounceMs?: number
  bindings?: Iterable<EntryBinding>
  onEvent?: (event: WatcherEvent) => void
  onChange?: (path: string, mapping: MappingResult) => Promise<void> | void
}

/** Thin lifecycle-owned Chokidar adapter; Cordis reload policy stays outside. */
export class HostWatcher {
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private pending = new Set<string>()
  private closed = false
  private ready = false
  private readyAtMs = 0
  private flushing?: Promise<void>
  private closing?: Promise<void>
  private closedEventEmitted = false
  private readonly bindings = new Map<string, EntryBinding>()
  private readonly debounceMs: number

  constructor(private readonly options: HostWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 100
    for (const binding of options.bindings ?? []) this.bindings.set(binding.entryId, binding)
  }

  async start() {
    if (this.watcher || this.closed) return
    const { roots, onEvent, onChange: _onChange, bindings: _bindings, debounceMs: _debounceMs, ...watchOptions } = this.options
    const watchRoots = roots.map((root) => isAbsolute(root) ? root : resolve(root))
    const watcher = watch(watchRoots, {
      ignoreInitial: true,
      atomic: 100,
      followSymlinks: false,
      ...watchOptions,
      ignored: watchOptions.ignored ?? ((path) => {
        const normalized = canonicalPath(path)
        return normalized.includes(`${sep}node_modules${sep}`)
          || normalized.includes(`${sep}.git${sep}`)
          || normalized.includes(`${sep}dist${sep}`)
      }),
    })
    this.watcher = watcher
    watcher.on("ready", () => {
      this.ready = true
      this.readyAtMs = Date.now()
      onEvent?.({ type: "started" })
    })
    watcher.on("change", (path) => this.enqueue(path, "change"))
    watcher.on("add", (path) => this.enqueue(path, "add"))
    watcher.on("unlink", (path) => this.enqueue(path, "unlink"))
    watcher.on("error", (error) => onEvent?.({ type: "error", error }))
    return watcher
  }

  setBindings(bindings: Iterable<EntryBinding>) {
    this.bindings.clear()
    for (const item of bindings) this.bindings.set(item.entryId, item)
  }

  private enqueue(path: string, kind: "add" | "change" | "unlink" = "change") {
    if (this.closed) return
    // Gate on the initial scan: chokidar's `ignoreInitial` covers add events
    // but on some platforms (macOS symlinked tmpdirs) initial adds can be
    // replayed after `ready` as ordinary change events. Any event arriving
    // before `ready` is part of the initial scan, not an edit, so it must not
    // route (a pre-existing entry's file would otherwise trigger a spurious
    // reload/onChange).
    if (!this.ready) return
    // Baseline filter: a `change` for a file whose mtime predates `ready`
    // cannot be a real edit (edits bump mtime). On macOS FSEvents the initial
    // scan can replay an already-present file as a change after ready; the
    // mtime tells the two apart without a time window or swallowing a genuine
    // first edit (which updates mtime past readyAtMs).
    if (kind === "change" && this.isInitialReplay(path)) return
    this.pending.add(path)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.debounceMs)
  }

  /** True when the file existed before the initial scan finished. */
  private isInitialReplay(path: string): boolean {
    try {
      return statSync(path).mtimeMs < this.readyAtMs
    } catch {
      return false // missing file = real add/unlink signal, not a replay
    }
  }

  private async flush() {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      this.timer = undefined
      const paths = [...this.pending]
      this.pending.clear()
      for (const path of paths) {
        if (this.closed) return
        const mapping = mapPath(path, this.bindings.values())
        const type = mapping.kind === "matched" ? "change" : mapping.kind
        this.options.onEvent?.({ type, path, mapping })
        if (mapping.kind === "matched") {
          try {
            await this.options.onChange?.(path, mapping)
          } catch (error) {
            this.options.onEvent?.({ type: "error", path, mapping, error })
          }
        }
      }
    })().finally(() => {
      this.flushing = undefined
      if (!this.closed && this.pending.size > 0 && !this.timer) {
        this.timer = setTimeout(() => void this.flush(), this.debounceMs)
      }
    })
    return this.flushing
  }

  getWatched(): Record<string, string[]> {
    return this.watcher?.getWatched() ?? {}
  }

  async close() {
    if (this.closing) return this.closing
    if (this.closed && !this.watcher && !this.flushing) return
    this.closing = (async () => {
      this.closed = true
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.pending.clear()
      const watcher = this.watcher
      this.watcher = undefined
      if (watcher) await watcher.close()
      await this.flushing
      if (!this.closedEventEmitted) {
        this.closedEventEmitted = true
        this.options.onEvent?.({ type: "closed" })
      }
    })()
    try {
      await this.closing
    } finally {
      this.closing = undefined
    }
  }

  async dispose() {
    await this.close()
  }
}
