import { RPCChannel, type RPCMessage, type Transport } from "kkrpc"
import {
  stdioJsonTransport,
  type ReadableLike,
  type WritableLike,
} from "kkrpc/stdio"
import { HOST_RESTART_EXIT, hostWsAPI } from "./api"
import { gracefulStopWithTimeout } from "./lifecycle"
import type { Context } from "cordis"
import type { HostWsReady } from "./ws"
import type { TrayMenuSnapshot } from "./tray-contract.generated"

/** Result of `shell.tray.setSnapshot` (mirrors src-tauri/src/shell_sys.rs). */
export type TraySetSnapshotResult = {
  ok: boolean
  revision: number
  error?: string
}

/** Payload of the shell → host `tray.action` notification. */
export type TrayActionEvent = {
  id: string
  command: string
  args: unknown[]
}

/**
 * Result of `shell.shortcut.register` / `unregister` (mirrors
 * `src-tauri/src/shortcut.rs#ShortcutRegistration`).
 *
 * `accelerator` is the CANONICAL spelling the shell produced
 * (`shift+control+KeyK`). Callers must match `shortcut.pressed` events against
 * this string rather than re-parsing their own input: chord identity has one
 * implementation (the plugin's parser, in Rust).
 */
export type ShortcutRegistration = {
  ok: boolean
  accelerator?: string
  error?: string
}

/** Payload of the shell → host `shortcut.pressed` notification. */
export type ShortcutPressEvent = {
  /** Canonical spelling of the chord that was pressed. */
  accelerator: string
  /** Plugin hotkey id: `(modifiers.bits() << 16) | key`. */
  id: number
}

/** Host API exposed to the Rust shell (LocalAPI). */
export type HostStdioAPI = {
  ping(): Promise<string>
  stop(): Promise<boolean>
  restart(): Promise<boolean>
  /** Shell → host tray notifications. */
  tray: {
    /** A host/plugin-owned tray item was clicked. */
    action(action: TrayActionEvent): boolean
  }
  /** Shell → host global shortcut notifications (issue #6 callback). */
  shortcut: {
    /** A chord the host registered was pressed (key-down edge only). */
    pressed(event: ShortcutPressEvent): boolean
  }
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
      register(accelerator: string): Promise<ShortcutRegistration>
      unregister(accelerator: string): Promise<ShortcutRegistration>
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
    /**
     * Tray ingress (host → shell). `shell.tray.setSnapshot` mirrors
     * `src-tauri/src/shell_sys.rs`; the payload is the `TrayMenuSnapshot` from
     * contracts/tray-menu.schema.json and may only contain host/plugin-owned
     * groups.
     */
    tray: {
      setSnapshot(snapshot: TrayMenuSnapshot): Promise<TraySetSnapshotResult>
    }
  }
}

/**
 * Host-facing view of the shell bridge.
 *
 * `tray.setSnapshot` is the same remote `shell.tray.setSnapshot` call, exposed
 * as a host-side namespace so the tray service has one dependency; `onAction`
 * is a purely local registration (the shell → host `tray.action` notification
 * arrives on the exposed API, not through the remote proxy).
 */
export type ShellTrayBridge = {
  setSnapshot(snapshot: TrayMenuSnapshot): Promise<TraySetSnapshotResult>
  onAction(handler: (action: TrayActionEvent) => void): () => void
}

/**
 * Host-facing view of the shortcut side of the shell bridge.
 *
 * `register`/`unregister` are the same remote `shell.shortcut.*` calls (so a
 * caller can drive them without holding the whole proxy); `onPress` is a purely
 * local registration — the shell → host `shortcut.pressed` notification arrives
 * on the exposed API, not through the remote proxy.
 */
export type ShellShortcutBridge = {
  register(accelerator: string): Promise<ShortcutRegistration>
  unregister(accelerator: string): Promise<ShortcutRegistration>
  onPress(handler: (event: ShortcutPressEvent) => void): () => void
}

export type ShellStdioBridge = ShellSysAPI & {
  tray: ShellTrayBridge
  shortcut: ShellShortcutBridge
}

/**
 * A local handler set for a shell → host notification.
 *
 * `tray.action` and `shortcut.pressed` both arrive on the exposed API and must
 * fan out to every local subscriber without one throwing handler breaking the
 * RPC channel. One implementation, so the two cannot drift apart.
 */
function fanout<T>(label: string) {
  const handlers = new Set<(value: T) => void>()
  return {
    on(handler: (value: T) => void): () => void {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    emit(value: T): void {
      for (const handler of [...handlers]) {
        try {
          handler(value)
        } catch (error) {
          console.error(`[host] ${label} handler error`, error)
        }
      }
    },
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
 * `expose` is the host API the shell can call (ping/stop/restart + the
 * `tray.action` and `shortcut.pressed` notifications); the returned bridge is
 * the shell's API the host can call (ready + shell.*, plus the local
 * `tray.onAction` / `shortcut.onPress` registrations).
 *
 * stop/restart run a real graceful fiber teardown before exiting — M1-3
 * issue #8: dispose fibers in reverse order, then exit 0 (stop) or 51
 * (restart).
 *
 * `options.transport` exists for tests (an in-memory transport pair); the
 * default is the real bun stdio transport.
 */
export function connectShellStdio(ctx: Context, options: { transport?: Transport<RPCMessage> } = {}): ShellStdioBridge {
  const trayActions = fanout<TrayActionEvent>("tray.action")
  const shortcutPresses = fanout<ShortcutPressEvent>("shortcut.pressed")
  const channel = new RPCChannel<HostStdioAPI, ShellSysAPI>(options.transport ?? bunStdioTransport(), {
    expose: {
      ping: () => hostWsAPI.ping(),
      stop: async () => {
        console.error("[host] stop requested — graceful shutdown")
        const acquired = await gracefulStopWithTimeout(ctx, "stop")
        if (!acquired) {
          // A shutdown is already in progress (e.g. dev-watch restart
          // requester); the first trigger owns the exit. Do not exit 0 here —
          // the process is already leaving (0 or 51).
          return true
        }
        setTimeout(() => process.exit(0), 10)
        return true
      },
      restart: async () => {
        console.error("[host] restart requested — graceful shutdown then exit 51")
        const acquired = await gracefulStopWithTimeout(ctx, "restart")
        if (!acquired) {
          // Already shutting down; the first trigger owns the exit.
          return true
        }
        setTimeout(() => process.exit(HOST_RESTART_EXIT), 10)
        return true
      },
      tray: {
        // `tray.action` (shell → host): fan out to every registered handler.
        // A handler throwing must never break the RPC channel.
        action: (action: TrayActionEvent) => {
          trayActions.emit(action)
          return true
        },
      },
      shortcut: {
        // `shortcut.pressed` (shell → host, issue #6 callback): the shell
        // already filtered to registered chords and key-down edges.
        pressed: (event: ShortcutPressEvent) => {
          shortcutPresses.emit(event)
          return true
        },
      },
    },
  })
  const remote = channel.getAPI()
  // Build the bridge explicitly. The remote proxy is function-shaped and its
  // `set` trap turns property assignment into an RPC, so own properties must
  // NOT be added on top of it (Object.create(remote) + `bridge.tray = ...`
  // silently sends a "set" frame and leaves `tray` undefined).
  return {
    ready: (info) => remote.ready(info),
    shell: remote.shell,
    tray: {
      setSnapshot: (snapshot) => remote.shell.tray.setSnapshot(snapshot),
      onAction: (handler) => trayActions.on(handler),
    },
    shortcut: {
      register: (accelerator) => remote.shell.shortcut.register(accelerator),
      unregister: (accelerator) => remote.shell.shortcut.unregister(accelerator),
      onPress: (handler) => shortcutPresses.on(handler),
    },
  }
}
