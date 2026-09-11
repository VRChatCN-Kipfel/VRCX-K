import { Service, symbols, type Context } from "cordis"
import type {
  AppInfo,
  PathKind,
  ShellStdioBridge,
  ShellSysAPI,
} from "./stdio"

type ShellApi = ShellSysAPI["shell"]

export type CapabilityAudit = (line: string) => void

/**
 * Calling plugin's fiber name, or null when the host itself is the caller.
 *
 * `fiber.name` is used (not `fiber.entry`): a bare `ctx.plugin()` has no loader
 * Entry (`hasEntry:false`, docs/cordis-runtime-findings.md §1.12), so the audit
 * must not depend on one. `self` is undefined when a caller destructures the
 * method (`const { notify } = ctx.shell`), in which case there is no `this` to
 * read the caller from — fall back to null rather than throwing.
 */
export function callerName(self: unknown): string | null {
  if (self == null) return null
  const caller = (self as Record<PropertyKey, unknown>)[symbols.caller] as
    | { fiber?: { name?: string } }
    | undefined
  return caller?.fiber?.name ?? null
}

/**
 * Shared, mutable handle to the shell bridge.
 *
 * It is created before any plugin loads (plugins may inject the capability
 * services during load) and the shell attaches later, so every method reads
 * `handle.shell` lazily and reports "no shell" until then.
 */
export class ShellHandle {
  bridge?: ShellStdioBridge
  constructor(private readonly audit: CapabilityAudit) {}

  attach(bridge: ShellStdioBridge): void {
    this.bridge = bridge
  }

  detach(): void {
    this.bridge = undefined
  }

  get shell(): ShellApi | undefined {
    return this.bridge?.shell
  }

  /** Transparent call record: one line per capability call, with its caller. */
  record(self: unknown, method: string, args: unknown[]): void {
    const who = callerName(self) ?? "<host>"
    const detail = args.length > 0 ? ` ${args.map(describe).join(", ")}` : ""
    this.audit(`[cap] ${who} -> ${method}${detail}`)
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}...` : value)
  }
  if (value === null || typeof value !== "object") return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  return "{...}"
}

/**
 * A capability namespace node.
 *
 * Every node must be a cordis `Service` instance: only then does cordis wrap
 * each method with a per-caller shadow and expose `this[symbols.caller]`
 * (docs/cordis-runtime-findings.md §1.7). A plain object property would
 * silently lose the caller.
 */
class CapabilityNode extends Service {}

type CapabilityMethod = (shell: ShellApi | undefined, ...args: any[]) => unknown
type CapabilitySpec = { [key: string]: CapabilityMethod | CapabilitySpec }

function buildNode(
  ctx: Context,
  name: string,
  handle: ShellHandle,
  spec: CapabilitySpec,
): CapabilityNode {
  const node = new CapabilityNode(ctx, name)
  for (const [key, entry] of Object.entries(spec)) {
    if (typeof entry === "function") {
      const method = entry
      // A normal function (NOT an arrow) so cordis's shadow rewrite can hand it
      // the calling plugin's context; the arrow form would drop attribution.
      Object.defineProperty(node, key, {
        configurable: true,
        value: function (this: unknown, ...args: unknown[]) {
          handle.record(this, `${name}.${key}`, args)
          return method(handle.shell, ...args)
        },
      })
    } else {
      Object.defineProperty(node, key, {
        configurable: true,
        value: buildNode(ctx, `${name}.${key}`, handle, entry),
      })
    }
  }
  return node
}

const DIALOG_SPEC: CapabilitySpec = {
  message: (s, text, opts) => (s ? s.dialog.message(text, opts) : Promise.resolve(false)),
  ask: (s, text, opts) => (s ? s.dialog.ask(text, opts) : Promise.resolve("")),
  pickFile: (s, opts) => (s ? s.dialog.pickFile(opts) : Promise.resolve(null)),
}

const WINDOW_SPEC: CapabilitySpec = {
  show: (s) => (s ? s.window.show() : Promise.resolve(false)),
  hide: (s) => (s ? s.window.hide() : Promise.resolve(false)),
  minimize: (s) => (s ? s.window.minimize() : Promise.resolve(false)),
  maximize: (s) => (s ? s.window.maximize() : Promise.resolve(false)),
  unmaximize: (s) => (s ? s.window.unmaximize() : Promise.resolve(false)),
  focus: (s) => (s ? s.window.focus() : Promise.resolve(false)),
  close: (s) => (s ? s.window.close() : Promise.resolve(false)),
}

const NOTIFY_SPEC: CapabilitySpec = {
  send: (s, title, body) => (s ? s.notify(title, body) : Promise.resolve(false)),
}

const OS_SPEC: CapabilitySpec = {
  openUrl: (s, url) => (s ? s.openUrl(url) : Promise.resolve(false)),
  openPath: (s, path) => (s ? s.openPath(path) : Promise.resolve(false)),
  reveal: (s, path) => (s ? s.reveal(path) : Promise.resolve(false)),
  appInfo: (s) => (s ? s.app.info() : Promise.resolve(null)),
  appExit: (s, code) => (s ? s.app.exit(code) : Promise.resolve(false)),
  pathDir: (s) => (s ? s.path.dir() : Promise.resolve(null)),
  pathResolve: (s, kind) => (s ? s.path.resolve(kind) : Promise.resolve("")),
}

/**
 * Raw escape hatch: mirrors the shell API one-for-one. Kept deliberately thin
 * so a plugin is never blocked on the host adding a curated method — but every
 * call is audited, and the curated services below are what SDK templates use.
 */
const RAW_SHELL: CapabilitySpec = {
  notify: (s, title, body) => (s ? s.notify(title, body) : Promise.resolve(false)),
  openUrl: (s, url) => (s ? s.openUrl(url) : Promise.resolve(false)),
  openPath: (s, path) => (s ? s.openPath(path) : Promise.resolve(false)),
  reveal: (s, path) => (s ? s.reveal(path) : Promise.resolve(false)),
  dialog: DIALOG_SPEC,
  window: WINDOW_SPEC,
  shortcut: {
    register: (s, accelerator) =>
      s ? s.shortcut.register(accelerator) : Promise.resolve({ ok: false, error: "no-shell" }),
    unregister: (s, accelerator) =>
      s ? s.shortcut.unregister(accelerator) : Promise.resolve({ ok: false, error: "no-shell" }),
    isRegistered: (s, accelerator) => (s ? s.shortcut.isRegistered(accelerator) : Promise.resolve(false)),
  },
  app: {
    info: (s) => (s ? s.app.info() : Promise.resolve(null)),
    exit: (s, code) => (s ? s.app.exit(code) : Promise.resolve(false)),
  },
  path: {
    dir: (s) => (s ? s.path.dir() : Promise.resolve(null)),
    resolve: (s, kind) => (s ? s.path.resolve(kind) : Promise.resolve("")),
  },
  devWatchEvent: (s, event) => (s ? s.devWatchEvent(event) : Promise.resolve(false)),
  tray: {
    setSnapshot: (s, snapshot) =>
      s ? s.tray.setSnapshot(snapshot) : Promise.resolve({ ok: false, revision: 0, error: "no-shell" }),
  },
}

export type NotifyCapability = {
  send(title: string, body: string): Promise<boolean>
}

export type OsCapability = {
  openUrl(url: string): Promise<boolean>
  openPath(path: string): Promise<boolean>
  reveal(path: string): Promise<boolean>
  appInfo(): Promise<AppInfo | null>
  appExit(code?: number): Promise<boolean>
  pathDir(): Promise<Record<PathKind, string> | null>
  pathResolve(kind: PathKind): Promise<string>
}

/**
 * Register the capability services on `ctx`.
 *
 * Two layers, both attributable: the raw `ctx.shell` mirror and the curated
 * `ctx.notify`/`ctx.dialog`/`ctx.window`/`ctx.os` domain services. Must run
 * before plugins load (they may inject these).
 */
export function createShellCapabilities(ctx: Context, handle: ShellHandle): void {
  buildNode(ctx, "shell", handle, RAW_SHELL)
  buildNode(ctx, "notify", handle, NOTIFY_SPEC)
  buildNode(ctx, "dialog", handle, DIALOG_SPEC)
  buildNode(ctx, "window", handle, WINDOW_SPEC)
  buildNode(ctx, "os", handle, OS_SPEC)
}

declare module "cordis" {
  interface Context {
    /**
     * Raw shell surface (M2-1). Mirrors `ShellSysAPI["shell"]`; every call is
     * audited with the calling plugin. Prefer the curated services below, which
     * exist so SDK templates have one stable, typed entry point.
     */
    shell: ShellSysAPI["shell"]
    notify: NotifyCapability
    dialog: ShellSysAPI["shell"]["dialog"]
    window: ShellSysAPI["shell"]["window"]
    os: OsCapability
  }
}
