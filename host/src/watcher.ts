import { watch, type FSWatcher, type ChokidarOptions } from "chokidar"
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
  private flushing?: Promise<void>
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
    watcher.on("ready", () => onEvent?.({ type: "started" }))
    watcher.on("change", (path) => this.enqueue(path))
    watcher.on("add", (path) => this.enqueue(path))
    watcher.on("unlink", (path) => this.enqueue(path))
    watcher.on("error", (error) => onEvent?.({ type: "error", error }))
    return watcher
  }

  setBindings(bindings: Iterable<EntryBinding>) {
    this.bindings.clear()
    for (const item of bindings) this.bindings.set(item.entryId, item)
  }

  private enqueue(path: string) {
    if (this.closed) return
    this.pending.add(path)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.debounceMs)
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
    if (this.closed && !this.watcher && !this.flushing) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    const watcher = this.watcher
    this.watcher = undefined
    if (watcher) await watcher.close()
    await this.flushing
    this.options.onEvent?.({ type: "closed" })
  }

  async dispose() {
    await this.close()
  }
}
