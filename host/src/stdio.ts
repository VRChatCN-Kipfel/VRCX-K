import { RPCChannel, type RPCMessage, type Transport } from "kkrpc"
import { nodeStdioTransport } from "kkrpc/stdio"
import { HOST_RESTART_EXIT, hostWsAPI } from "./api"
import { gracefulStopWithTimeout, stopOnStdinLoss } from "./lifecycle"
import { stdinIsPeerChannel } from "./stdin-watch"
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
 * Plugin access goes through the `ctx.shell` capability mirror (capability.ts),
 * which rebuilds these namespaces as cordis `Service`s so every call is
 * attributable; `ctx.notify`/`ctx.dialog`/`ctx.window`/`ctx.os` are the curated
 * equivalents. Adding a method here does not expose it by itself — the mirror
 * spec in capability.ts must list it too.
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

/**
 * The host's stdio transport.
 *
 * Two peer-death channels exist and they are deliberately BOTH wired, because
 * they have different side effects:
 *
 *   `onDone` (this pump)  — fires on stdin EOF. Does NOT touch kkrpc's channel
 *                           state, so an in-flight `shell.ready(...)` survives
 *                           it. This is the one that stops the host.
 *   `onClose` (kkrpc)     — fires from the transport's lifecycle and DELIVERS a
 *                           `reason`, distinguishing a clean peer exit
 *                           (`undefined`) from a broken pipe. But kkrpc's
 *                           `handleTransportClose` first REJECTS every pending
 *                           request — including a `shell.ready` still in flight
 *                           during bootstrap, which would escape to the fatal
 *                           handler and exit 1. So this one only observes.
 *
 * Why the old shape could not deliver `onClose` at all (measured exhaustively in
 * `.temp/recon-stdio/probes-h6/FINDINGS.md`):
 *
 *   1. `lifecycle` alone never unpauses stdin. `process.stdin` is a paused
 *      `ReadStream`; `on("end")`/`on("close")`/`on("error")` — exactly what
 *      kkrpc's `lifecycle` attaches — leave `readableFlowing === null`. Only
 *      `on("data")` resumes it, and a paused stdin never emits end/close.
 *   2. Holding `Bun.stdin.stream().getReader()` locks the SAME native readable
 *      (`process.stdin !== Bun.stdin.stream()`, but coupled natively), so every
 *      rescue route — including `process.stdin.resume()` — THROWS
 *      `ERR_INVALID_STATE: ReadableStream is locked`.
 *
 * `nodeStdioTransport()` avoids both (it uses `process.stdin` directly, and
 * `RPCChannel` subscribes internally, which is what resumes it). We keep the
 * bare-`process.stdin` readable and re-add the pump only as an EOF observer,
 * which cannot lock the native stream.
 *
 * Do NOT reintroduce a `Bun.stdin.stream()` reader here. `watchStdinClose()` in
 * stdin-watch.ts takes that reader for the shell-less case, and the two are
 * mutually exclusive in BOTH orderings (measured).
 */
function bunStdioTransport(onDone?: () => void) {
  const base = nodeStdioTransport()
  if (!onDone) return base
  // Observe EOF without taking a reader: `process.stdin` is already resumed by
  // the channel's own `subscribe()` (an `on("data")` attach), so plain event
  // listeners are enough and cost us nothing.
  //
  // `end` and `close` BOTH fire for one teardown (bun emits end, then close),
  // and the two are not distinguishable here. Latch so a single peer death
  // produces exactly one stop, matching what the old pump delivered.
  let fired = false
  const mark = () => {
    if (fired) return
    fired = true
    onDone()
  }
  process.stdin.on("end", mark)
  process.stdin.on("close", mark)
  process.stdin.on("error", mark)
  return base
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
  // #33: EOF on the shell's stdin channel means the shell is gone. Its
  // ProcessTree Job Object would hard-reap us anyway — this turns that into the
  // same graceful teardown the stop RPC uses. Only a peer channel (pipe on
  // Windows, socketpair on POSIX — see stdin-watch.ts) carries that meaning; a
  // test-supplied transport owns unrelated streams, so both hooks below are
  // wired for the default transport only.
  //
  // Two hooks, deliberately: `onDone` (inside `bunStdioTransport`) STOPS the
  // host and `onClose` REPORTS the reason. See `bunStdioTransport`'s doc for why
  // they are split rather than both wired to `stopOnStdinLoss`.
  const usesDefaultTransport = options.transport === undefined
  const watchStdinLoss = usesDefaultTransport && stdinIsPeerChannel()
  const onStdinLost = watchStdinLoss ? () => void stopOnStdinLoss(ctx, "shell") : undefined
  const channel = new RPCChannel<HostStdioAPI, ShellSysAPI>(options.transport ?? bunStdioTransport(onStdinLost), {
    onClose: watchStdinLoss
      ? (reason) => {
          // Observability only. `reason === undefined` is a clean peer exit;
          // an Error means the pipe broke. Both are already handled by the stop
          // path — this exists so a crash is distinguishable from a normal quit
          // in the logs, which the old `onDone` (a bare `() => void`) could not
          // express.
          //
          // ⚠ Do NOT call `stopOnStdinLoss` here: kkrpc rejects every pending
          // request immediately before invoking `onClose`, so a
          // bootstrap-time `shell.ready` rejection would race the stop path and
          // could decide the exit code (measured: exit 1 instead of 0).
          console.error(
            reason
              ? `[host] shell stdio broke (${reason.name}: ${reason.message})`
              : "[host] shell closed its stdio cleanly",
          )
        }
      : undefined,
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
