import type { Context } from "cordis"
import { RPCChannel, type RPCMessage, type Transport } from "kkrpc"
import { nodeStdioTransport } from "kkrpc/stdio"
import { HOST_RESTART_EXIT, hostWsAPI } from "./api"
import { gracefulStopWithTimeout, stopOnStdinLoss } from "./lifecycle"
import { stdinIsPeerChannel } from "./stdin-watch"
import type { TrayMenuSnapshot } from "./tray-contract.generated"
import type { HostWsReady } from "./ws"

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
  /**
   * Whether a write to the shell has already failed (EPIPE). See
   * `withWriteFailureObserver` for why the sending-side signal needs its own
   * detector. Always `false` for a test-supplied transport, which owns its
   * streams and has no real pipe to break.
   */
  sawWriteFailure: () => boolean
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
 * The host's stdio transport — the upstream one, unmodified.
 *
 * kkrpc's `nodeStdioTransport()` uses `process.stdin` directly as the readable
 * and auto-wires `lifecycle` to it. That is the whole point: `RPCChannel`
 * subscribes internally (`readable.on("data")`), which is what resumes stdin,
 * and only a flowing stdin emits `end`/`close` — so `onClose` actually fires.
 *
 * Why the previous hand-rolled shape could never deliver `onClose` (measured
 * exhaustively; see `docs/probes/stdio-lifecycle/FINDINGS.md`):
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
 * Do NOT reintroduce a `Bun.stdin.stream()` reader here. `watchStdinClose()` in
 * stdin-watch.ts takes that reader for the shell-less case, and the two are
 * mutually exclusive in BOTH orderings (measured).
 *
 * ASYMMETRY worth knowing before reading `connectShellStdio`: this transport
 * takes stdin's reader UNCONDITIONALLY once constructed — `RPCChannel`
 * subscribes on construction, and that subscription (`readable.on("data")`) is
 * precisely what puts stdin into flowing mode at all. Only the STOP is gated, on
 * `stdinIsPeerChannel()`. So a `VRCXK_SHELL=1` host whose fd 0 is not a pipe
 * (the null device, a TTY, a redirected file) still has no self-stop path: the
 * transport holds the reader and nothing acts on the close. That is unchanged
 * from before this transport swap — the old pump's `onDone` sat behind the
 * identical guard — so it is a pre-existing limitation, not a regression. It is
 * simply sharper now that the reader is always taken.
 *
 * The transport's `onClose` is wired to the stop path in `connectShellStdio`.
 * It first REJECTS every pending request (`handleTransportClose`), which is why
 * `bootstrap` treats a failed `shell.ready` as an expected outcome rather than a
 * fatal error — see the comment there.
 */
function bunStdioTransport() {
  return nodeStdioTransport()
}

/**
 * A transport that RECORDS write failures and otherwise behaves identically.
 *
 * WHY THIS EXISTS: kkrpc reports "the peer is gone" through two independent
 * paths, and the official transport only surfaces the first:
 *
 *   1. the read side ends  -> `handleTransportClose` rejects pending calls with
 *      `RPCTransportClosedError`, and `onClose` fires (probe 15, cells A–D);
 *   2. a WRITE fails (EPIPE) -> `handleWriteFailure` rejects the matching call
 *      with the raw write error, and `onClose` does NOT fire, because the read
 *      side is still healthy and nothing ended it (probe 16, cell E — measured).
 *
 * Case 2 is the same physical event seen from the sending side, and it is the
 * one that matters at startup: `ready` is the FIRST frame the host writes, so a
 * shell that dies just before/while we announce ourselves can only be noticed
 * this way.
 *
 * The observer is deliberately PASSIVE: it re-throws unchanged, so kkrpc still
 * rejects the pending call and the existing control flow is untouched. Swallowing
 * the error here would convert a fast failure into a 30-second timeout, which is
 * strictly worse. Verified: the call still rejects with the same plain Error and
 * a healthy transport records nothing (probe 18).
 *
 * Detecting EPIPE is safe to read as "peer gone": a write to a pipe whose reader
 * is alive-but-idle blocks or buffers rather than failing, so the error only
 * appears once every read end is closed (measured — probe 18).
 */
export function withWriteFailureObserver(inner: Transport<RPCMessage>) {
  const state = { failed: false }
  // Derive the parameter list from the interface rather than naming
  // `Transferable` directly: that type lives in the DOM lib, which the host's
  // tsconfig (correctly) does not include.
  type SendArgs = Parameters<NonNullable<Transport<RPCMessage>["send"]>>
  const transport: Transport<RPCMessage> = {
    ...inner,
    send(...args: SendArgs) {
      const result = inner.send?.(...args)
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          state.failed = true
          throw error
        })
      }
      return result
    },
  }
  return { transport, state }
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
export function connectShellStdio(
  ctx: Context,
  options: { transport?: Transport<RPCMessage> } = {},
): ShellStdioBridge {
  const trayActions = fanout<TrayActionEvent>("tray.action")
  const shortcutPresses = fanout<ShortcutPressEvent>("shortcut.pressed")
  // #33: EOF on the shell's stdin channel means the shell is gone. Its
  // ProcessTree Job Object would hard-reap us anyway — this turns that into the
  // same graceful teardown the stop RPC uses. Only a peer channel (pipe on
  // Windows, socketpair on POSIX — see stdin-watch.ts) carries that meaning; a
  // test-supplied transport owns unrelated streams.
  //
  // `onClose` is the sole peer-death trigger for the shell-attached path. It
  // carries a `reason`, but read that as OBSERVABILITY ONLY — it is not a
  // behaviour switch:
  //
  //   - The ternary below only picks a log line; nothing branches on it.
  //   - kkrpc maps a stream `error` to the error object, but that arm has never
  //     been observed here. On Windows a clean exit (FIN) and an abrupt one
  //     (RST) are INDISTINGUISHABLE at the reader, so in practice `reason` is
  //     always `undefined` (measured, both teardowns — FINDINGS.md §3.3). Do not
  //     build "the shell crashed vs exited" logic on it.
  //
  // It is still a real improvement over the old boolean callback: one signal
  // instead of two, and it can in principle say why.
  const usesDefaultTransport = options.transport === undefined
  const watchStdinLoss = usesDefaultTransport && stdinIsPeerChannel()
  // Wrap the real transport so a WRITE failure is observable. Without this the
  // sending-side death signal (EPIPE) is invisible: `onClose` watches the read
  // side and stays silent, so the only trace would be a bare rejection from
  // `shell.ready` that nothing distinguishes from a genuine startup error.
  // A test-supplied transport is used as-is — it owns its streams.
  const observed = usesDefaultTransport ? withWriteFailureObserver(bunStdioTransport()) : undefined
  // Narrow once, so neither consumer below needs a non-null assertion: either we
  // built the observed wrapper (default transport) or the caller supplied one.
  // The guard is a real check, not a formality — a caller that passes an
  // explicit `undefined` would otherwise reach RPCChannel with no transport.
  const transport = observed ? observed.transport : options.transport
  if (!transport) {
    throw new TypeError("host stdio: no transport available (neither default nor supplied)")
  }
  const channel = new RPCChannel<HostStdioAPI, ShellSysAPI>(transport, {
    onClose: watchStdinLoss
      ? (reason) => {
          console.error(
            reason
              ? `[host] shell stdio broke (${reason.name}: ${reason.message}) — graceful shutdown`
              : "[host] shell closed its stdio — graceful shutdown",
          )
          void stopOnStdinLoss(ctx, "shell")
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
    /**
     * Whether a write to the shell has already failed. Bootstrap consults this
     * when `ready` rejects: a rejection that coincides with a failed write is
     * the sending-side "shell is gone" signal (exit 52), NOT a startup fault.
     */
    sawWriteFailure: () => observed?.state.failed ?? false,
  }
}
