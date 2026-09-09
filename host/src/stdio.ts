import { RPCChannel } from "kkrpc"
import {
  stdioJsonTransport,
  type ReadableLike,
  type WritableLike,
} from "kkrpc/stdio"
import { HOST_RESTART_EXIT, hostWsAPI } from "./api"
import { gracefulStopWithTimeout } from "./lifecycle"
import type { Context } from "cordis"
import type { HostWsReady } from "./ws"

/** Host API exposed to the Rust shell (LocalAPI). */
export type HostStdioAPI = {
  ping(): Promise<string>
  stop(): Promise<boolean>
  restart(): Promise<boolean>
}

/** Dialog options for message/ask. */
export type DialogOptions = {
  title?: string
  kind?: "info" | "warning" | "error"
  buttons?: "ok" | "okCancel" | "yesNo" | "yesNoCancel"
}

/** Pick-file options. */
export type PickFileOptions = {
  multiple?: boolean
  directory?: boolean
  save?: boolean
}

/** App metadata returned by `shell.app.info()`. */
export type AppInfo = {
  name: string
  version: string
  identifier: string
}

/** Well-known directory kinds for `shell.path.resolve`. */
export type PathKind = "config" | "data" | "cache" | "temp" | "home"

/**
 * Dev-watch event pushed host → shell → face (issue #11 wiring). This is a
 * #11-owned event shape (not a #7 lifecycle DTO): plain camelCase JSON, errors
 * reduced to strings so kkrpc JSON transport never sees Error objects.
 */
export type DevWatchPush = {
  type: string
  entryId?: string
  path?: string
  status?: string
  error?: string
  entries?: string[]
}

/**
 * Shell (Rust) API exposed to the host — the system capability surface.
 * Mirrors `src-tauri/src/shell_sys.rs` exactly; each nested member maps to a
 * dot-namespaced kkrpc method on the Rust side.
 *
 * 前瞻性：能力面尽量完整，host 业务插件以后直接 `ctx.shell.*` 调用，不必
 * 再等壳补 handler。
 */
export type ShellSysAPI = {
  ready(info: HostWsReady): Promise<void>
  shell: {
    notify(title: string, body: string): Promise<boolean>
    dialog: {
      message(text: string, opts?: DialogOptions): Promise<boolean>
      ask(text: string, opts?: DialogOptions): Promise<string>
      pickFile(opts?: PickFileOptions): Promise<string | string[] | null>
    }
    openUrl(url: string): Promise<boolean>
    openPath(path: string): Promise<boolean>
    reveal(path: string): Promise<boolean>
    shortcut: {
      register(accelerator: string): Promise<boolean>
      unregister(accelerator: string): Promise<boolean>
      isRegistered(accelerator: string): Promise<boolean>
    }
    window: {
      show(): Promise<boolean>
      hide(): Promise<boolean>
      minimize(): Promise<boolean>
      maximize(): Promise<boolean>
      unmaximize(): Promise<boolean>
      focus(): Promise<boolean>
      close(): Promise<boolean>
    }
    app: {
      info(): Promise<AppInfo>
      exit(code?: number): Promise<boolean>
    }
    path: {
      dir(): Promise<Record<PathKind, string>>
      resolve(kind: PathKind): Promise<string>
    }
    /** Fire-and-forget dev-watch event relay to the shell (which emits `dev-watch` to the face). */
    devWatchEvent(event: DevWatchPush): Promise<boolean>
  }
}

class ReadableStreamLike implements ReadableLike {
  private listeners = new Set<(chunk: Uint8Array | string) => void>()

  constructor(stream: ReadableStream<Uint8Array>) {
    void this.pump(stream)
  }

  on(event: "data", listener: (chunk: Uint8Array | string) => void) {
    if (event === "data") this.listeners.add(listener)
    return this
  }

  off(event: "data", listener: (chunk: Uint8Array | string) => void) {
    if (event === "data") this.listeners.delete(listener)
    return this
  }

  private async pump(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) return
        for (const listener of this.listeners) listener(result.value)
      }
    } finally {
      reader.releaseLock()
    }
  }
}

function bunWritable(): WritableLike {
  return {
    write(chunk, callback) {
      void Bun.write(Bun.stdout, chunk).then(
        () => callback?.(),
        (error) => callback?.(error instanceof Error ? error : new Error(String(error))),
      )
    },
  }
}

function bunStdioTransport() {
  return stdioJsonTransport({
    readable: new ReadableStreamLike(Bun.stdin.stream()),
    writable: bunWritable(),
    lifecycle: process.stdin,
  })
}

/**
 * Connect the host to the Rust shell over kkrpc/stdio.
 *
 * `expose` is the host API the shell can call (ping/stop/restart); the
 * returned proxy is the shell's API the host can call (ready + shell.*).
 *
 * stop/restart run a real graceful fiber teardown before exiting — M1-3
 * issue #8: dispose fibers in reverse order, then exit 0 (stop) or 51
 * (restart).
 */
export function connectShellStdio(ctx: Context) {
  const channel = new RPCChannel<HostStdioAPI, ShellSysAPI>(bunStdioTransport(), {
    expose: {
      ping: () => hostWsAPI.ping(),
      stop: async () => {
        console.error("[host] stop requested — graceful shutdown")
        await gracefulStopWithTimeout(ctx, "stop")
        setTimeout(() => process.exit(0), 10)
        return true
      },
      restart: async () => {
        console.error("[host] restart requested — graceful shutdown then exit 51")
        await gracefulStopWithTimeout(ctx, "restart")
        setTimeout(() => process.exit(HOST_RESTART_EXIT), 10)
        return true
      },
    },
  })
  return channel.getAPI()
}
