// Pure logic for the capability smoke panel (face side, dev only).
//
// Split out of `capabilitySmokePanel.tsx` so the request descriptors, wire
// validation, result formatting, press matching and the log-capacity policy can
// be unit-tested with `bun test` without a React/DOM/Tauri harness. This module
// must stay free of React and Tauri imports.

/**
 * PINNED SOURCE: `src-tauri/src/smoke.rs`
 *
 * The shell's `SmokeAction` enum is `#[serde(tag = "action", rename_all =
 * "camelCase")]`, so the tags below are a wire contract: a misspelling is
 * rejected by `parse_action` (deliberately — see the Rust tests) instead of
 * being silently ignored. The Rust test
 * `parse_action_rejects_unknown_or_misspelled_requests` pins the same strings
 * from the other side.
 *
 * Deliberately duplicated rather than imported: a type-only import of the Rust
 * module is impossible, and importing anything from `host/` drags the whole
 * host module graph into the frontend `tsc` program.
 */
export type SmokeActionTag =
  | "notify"
  | "dialogMessage"
  | "dialogAsk"
  | "dialogPickFile"
  | "trayRender"
  | "trayDispatch"
  | "shortcutRegister"
  | "shortcutUnregister"
  | "secondInstance"

/** The five system capabilities issue #6 covers. */
export type Capability = "tray" | "single-instance" | "shortcut" | "notification" | "dialog"

export const CAPABILITIES: Capability[] = [
  "tray",
  "single-instance",
  "shortcut",
  "notification",
  "dialog",
]

export const CAPABILITY_LABEL: Record<Capability, string> = {
  tray: "托盘",
  "single-instance": "单实例",
  shortcut: "全局快捷键",
  notification: "原生通知",
  dialog: "文件对话框",
}

/** Default chord the panel registers. `CommandOrControl` resolves per platform. */
export const DEFAULT_SHORTCUT = "CommandOrControl+Shift+K"

/** Presses kept in the log (they arrive per key press). */
export const MAX_PRESSES = 5

export type SmokeButton = {
  id: string
  capability: Capability
  label: string
  /** The `{ action: ... }` payload sent to the `capability_smoke` command. */
  request: Record<string, unknown>
  /**
   * What the developer must confirm BY EYE after clicking. These are the parts
   * that cannot be automated (a tray icon is visible or it is not, a toast
   * appears or it does not) — stated honestly instead of pretended away.
   */
  manual?: string
}

/**
 * Every button the panel renders.
 *
 * Tray dispatch ids mirror `src-tauri/src/tray.rs#is_smoke_safe_tray_id`: only
 * non-destructive core window/webview items. `core.app.quit.force` and
 * `core.host.*` are deliberately absent — a smoke button must never be able to
 * quit the app or stop the host, and the shell rejects them anyway.
 */
export const SMOKE_BUTTONS: SmokeButton[] = [
  {
    id: "tray.render",
    capability: "tray",
    label: "重渲染托盘",
    request: { action: "trayRender" },
    manual: "看托盘图标是否出现；左键点图标应显示主窗口，右键应弹出菜单",
  },
  {
    id: "tray.show",
    capability: "tray",
    label: "派发 window.show",
    request: { action: "trayDispatch", id: "core.window.show" },
    manual: "主窗口应被显示并聚焦（与托盘 Show 菜单项同一路由）",
  },
  {
    id: "tray.close",
    capability: "tray",
    label: "派发 window.close",
    request: { action: "trayDispatch", id: "core.window.close" },
    manual: "主窗口应被隐藏而不是退出（托盘常驻语义）",
  },
  {
    id: "tray.reload",
    capability: "tray",
    label: "派发 webview.reload",
    request: { action: "trayDispatch", id: "core.webview.reload" },
    manual: "WebView 应重新加载",
  },
  {
    id: "single.launch",
    capability: "single-instance",
    label: "再启动一个实例",
    request: { action: "secondInstance" },
    manual:
      "会真的启动第二个 vrcx-k 进程：它应通知本实例聚焦主窗口后自行退出（任务管理器里看不到它是正常的——它应该已经退出）；下方应出现一次「重定向到达」记录",
  },
  {
    id: "shortcut.register",
    capability: "shortcut",
    label: `注册 ${DEFAULT_SHORTCUT}`,
    request: { action: "shortcutRegister", accelerator: DEFAULT_SHORTCUT },
    manual: "注册后按下该组合键（窗口失焦也应生效），下方应出现一次按键记录",
  },
  {
    id: "shortcut.unregister",
    capability: "shortcut",
    label: "反注册快捷键",
    request: { action: "shortcutUnregister", accelerator: DEFAULT_SHORTCUT },
    manual: "反注册后再按该组合键不应再出现记录",
  },
  {
    id: "notify.simple",
    capability: "notification",
    label: "发送系统通知",
    request: { action: "notify" },
    manual:
      "应出现一条系统通知。**开发态（未安装）** Windows 会把 toast 归因到 PowerShell——这是 winrt-notification 对「未注册 AUMID」的既定回退，安装后（安装包会注册 AUMID）才显示为 VRCX-K",
  },
  {
    id: "dialog.message",
    capability: "dialog",
    label: "消息框",
    request: { action: "dialogMessage", kind: "info" },
    manual: "应弹出原生消息框，点 OK 后返回 confirmed",
  },
  {
    id: "dialog.ask",
    capability: "dialog",
    label: "询问框",
    request: { action: "dialogAsk", buttons: "yesNo" },
    manual: "应弹出 Yes/No 原生询问框，返回值应为 yes/no",
  },
  {
    id: "dialog.pick",
    capability: "dialog",
    label: "选择文件",
    request: { action: "dialogPickFile" },
    manual: "应弹出原生打开文件对话框，选中的路径应回显",
  },
  {
    id: "dialog.save",
    capability: "dialog",
    label: "保存文件",
    request: { action: "dialogPickFile", save: true },
    manual: "应弹出原生保存文件对话框，选中的路径应回显",
  },
]

/** Rust `SmokeReport` as it crosses the Tauri IPC boundary. */
export type SmokeReport = {
  capability: string
  ok: boolean
  detail: string
  value?: unknown
  error?: string
}

/**
 * PINNED SOURCE: `src-tauri/src/shortcut.rs#Delivery`
 *
 * Three outcomes, not a boolean: "no host process" and "the host pipe is gone"
 * have different fixes, and collapsing them made the 2026-09 acceptance run
 * undiagnosable ("未投递 host" could mean either).
 */
export type DeliveryCode = "delivered" | "no-host" | "write-failed"

/** PINNED SOURCE: `src-tauri/src/shortcut.rs#host_view` (camelCase `HostSnapshot` fields). */
export type HostView = {
  phase: string
  pid: number | null
  lastError: string | null
}

/** Payload of the shell's `shortcut-pressed` Tauri event. */
export type ShortcutPress = {
  accelerator: string
  id: number
  delivery: DeliveryCode
  /** Write failure text, when `delivery` is `write-failed`. */
  detail: string | null
  /** Host lifecycle state at press time, when the shell could read it. */
  host: HostView | null
}

/**
 * Payload of the shell's `single-instance-redirect` Tauri event.
 *
 * Emitted when a second launch is redirected into this instance. Its ABSENCE is
 * meaningful: the plugin only notifies when it finds this instance's window
 * (`tauri-plugin-single-instance` windows.rs), so "nothing arrived" points at
 * the redirect, while "arrived but focused=false" points at this window.
 */
export type RedirectEvent = {
  focused: boolean
  error?: string
  args?: string[]
  cwd?: string
}

/** One press kept in the panel log. */
export type PressLogEntry = ShortcutPress & {
  seq: number
  at: Date
  /** The press matched the chord this panel registered. */
  matched: boolean
}

export type SmokeView = {
  /** Latest result per capability. */
  results: Partial<Record<Capability, SmokeReport>>
  /** Most recent presses, newest last. */
  presses: PressLogEntry[]
  /** Most recent single-instance redirects, newest last. */
  redirects: RedirectEvent[]
  /** Canonical spelling the shell returned for this panel's registration. */
  boundShortcut: string | null
  seq: number
}

export type SmokeViewAction =
  | { kind: "report"; report: SmokeReport }
  | { kind: "press"; press: ShortcutPress }
  | { kind: "redirect"; event: RedirectEvent }
  | { kind: "bound"; accelerator: string | null }
  | { kind: "reset" }

export function initialSmokeView(): SmokeView {
  return { results: {}, presses: [], redirects: [], boundShortcut: null, seq: 0 }
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as string[]).includes(value)
}

function isDeliveryCode(value: unknown): value is DeliveryCode {
  return value === "delivered" || value === "no-host" || value === "write-failed"
}

/**
 * Validate a `capability_smoke` reply.
 *
 * A malformed reply is dropped rather than rendered: showing "undefined" in a
 * status row would look like a capability result when it is not one.
 */
export function parseSmokeReport(raw: unknown): SmokeReport | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const candidate = raw as Partial<SmokeReport>
  if (!isCapability(candidate.capability)) return undefined
  if (typeof candidate.ok !== "boolean") return undefined
  if (typeof candidate.detail !== "string") return undefined
  return {
    capability: candidate.capability,
    ok: candidate.ok,
    detail: candidate.detail,
    value: candidate.value,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
  }
}

function parseHostView(raw: unknown): HostView | null {
  if (!raw || typeof raw !== "object") return null
  const candidate = raw as Partial<HostView>
  if (typeof candidate.phase !== "string") return null
  return {
    phase: candidate.phase,
    pid: typeof candidate.pid === "number" ? candidate.pid : null,
    lastError: typeof candidate.lastError === "string" ? candidate.lastError : null,
  }
}

/** Validate a `shortcut-pressed` event payload. */
export function parseShortcutPress(raw: unknown): ShortcutPress | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const candidate = raw as Partial<ShortcutPress>
  if (typeof candidate.accelerator !== "string" || candidate.accelerator.length === 0) {
    return undefined
  }
  if (typeof candidate.id !== "number" || !Number.isInteger(candidate.id)) return undefined
  // A press without a delivery verdict cannot be reported honestly: this panel
  // exists to tell "callback fired" from "host received it".
  if (!isDeliveryCode(candidate.delivery)) return undefined
  return {
    accelerator: candidate.accelerator,
    id: candidate.id,
    delivery: candidate.delivery,
    detail: typeof candidate.detail === "string" ? candidate.detail : null,
    host: parseHostView(candidate.host),
  }
}

/** Validate a `single-instance-redirect` event payload. */
export function parseRedirectEvent(raw: unknown): RedirectEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const candidate = raw as Partial<RedirectEvent>
  if (typeof candidate.focused !== "boolean") return undefined
  return {
    focused: candidate.focused,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
    args: Array.isArray(candidate.args)
      ? candidate.args.filter((arg): arg is string => typeof arg === "string")
      : undefined,
    cwd: typeof candidate.cwd === "string" ? candidate.cwd : undefined,
  }
}

/**
 * Read the canonical spelling out of a successful registration reply.
 *
 * The shell canonicalises (`shift+control+KeyK`); the panel never parses an
 * accelerator itself, it only remembers what the shell called the chord.
 */
export function registeredAccelerator(report: SmokeReport): string | null {
  if (!report.ok) return null
  const value = report.value
  if (!value || typeof value !== "object") return null
  const accelerator = (value as { accelerator?: unknown }).accelerator
  return typeof accelerator === "string" && accelerator.length > 0 ? accelerator : null
}

export function reduceSmoke(view: SmokeView, action: SmokeViewAction): SmokeView {
  switch (action.kind) {
    case "reset":
      return initialSmokeView()
    case "report": {
      if (!isCapability(action.report.capability)) return view
      const capability = action.report.capability
      return { ...view, results: { ...view.results, [capability]: action.report } }
    }
    case "bound":
      return { ...view, boundShortcut: action.accelerator }
    case "press": {
      const seq = view.seq + 1
      const entry: PressLogEntry = {
        ...action.press,
        seq,
        at: new Date(),
        matched: view.boundShortcut !== null && view.boundShortcut === action.press.accelerator,
      }
      const presses = [...view.presses, entry].slice(-MAX_PRESSES)
      return { ...view, presses, seq }
    }
    case "redirect": {
      const seq = view.seq + 1
      return { ...view, redirects: [...view.redirects, action.event].slice(-MAX_PRESSES), seq }
    }
  }
}

/** One status line for a capability row. */
export function summarizeCapability(view: SmokeView, capability: Capability): string {
  const result = view.results[capability]
  if (!result) return "尚未运行"
  return `${result.ok ? "✔" : "✘"} ${result.detail}`
}

/** Human-readable value tail of a report (paths, pid, counts), or "". */
export function describeValue(report: SmokeReport): string {
  if (report.value === undefined || report.value === null) return ""
  try {
    return JSON.stringify(report.value)
  } catch {
    return ""
  }
}

/** One press log line, e.g. `#3 shift+control+KeyK → 已投递 host（ready, pid 42）`. */
export function formatPress(entry: PressLogEntry): string {
  const match = entry.matched ? "匹配本面板注册的组合键" : "不是本面板注册的组合键"
  return `#${entry.seq} ${entry.accelerator} → ${describeDelivery(entry)}；${match}`
}

/**
 * Delivery verdict in words, including WHY and the host state at that moment.
 *
 * The host phase is the part that turns "未投递 host" into an actionable
 * sentence: `no-host` with `phase: backoff` blames the supervisor's launch,
 * while `write-failed` blames a dead pipe.
 */
export function describeDelivery(press: ShortcutPress): string {
  const host = press.host
  const hostSuffix = host ? `（host ${host.phase}${host.pid ? `, pid ${host.pid}` : ""}）` : ""
  const errorSuffix = host?.lastError ? `；host 最后一次错误：${host.lastError}` : ""
  switch (press.delivery) {
    case "delivered":
      return `已投递 host${hostSuffix}`
    case "no-host":
      return `未投递：没有宿主进程在运行${hostSuffix}${errorSuffix}`
    case "write-failed":
      return `未投递：宿主管道写入失败${press.detail ? `（${press.detail}）` : ""}${hostSuffix}`
  }
}

/** One single-instance redirect line. */
export function formatRedirect(event: RedirectEvent, index: number): string {
  if (event.focused) return `#${index} 第二个实例已到达，主窗口已聚焦`
  return `#${index} 第二个实例已到达，但聚焦失败：${event.error ?? "未知原因"}`
}

/**
 * The hint under the shortcut row.
 *
 * It distinguishes the states a developer can actually be in, because an empty
 * log after clicking a button has more than one cause and only one of them is a
 * bug in the callback.
 */
export function shortcutHint(view: SmokeView): string {
  if (!view.boundShortcut) return "尚未注册：先点「注册」再按键"
  const latest = view.presses[view.presses.length - 1]
  if (!latest) return `已注册 ${view.boundShortcut}：按一次试试（窗口失焦也应生效）`
  if (!latest.matched) return `已注册 ${view.boundShortcut}，但最近一次按键是 ${latest.accelerator}`
  if (latest.delivery !== "delivered") return describeDelivery(latest)
  return "组合键 → 壳 → host 的完整链路已跑通"
}

/**
 * The hint under the single-instance row.
 *
 * The button spawns a REAL second process that must exit by itself, so "no new
 * process in Task Manager" is the expected outcome — saying so avoids reading a
 * success as a failure.
 */
export function singleInstanceHint(view: SmokeView): string {
  const latest = view.redirects[view.redirects.length - 1]
  if (!latest) {
    return "尚未收到重定向：点上面的按钮后，本实例应收到一次重定向（第二个进程会自行退出，属正常）"
  }
  if (!latest.focused) return `重定向已到达但聚焦失败：${latest.error ?? "未知原因"}`
  return "第二个实例已到达并聚焦主窗口：单实例链路已跑通"
}
