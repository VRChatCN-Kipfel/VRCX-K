// Unit tests for the capability-smoke panel core (issue #6).
//
// The panel itself needs a Tauri runtime (a real window, real OS dialogs), so
// everything that can be decided without one lives in `capabilitySmokeCore.ts`
// and is pinned here: the descriptor table, the wire validation, the result
// state machine, press delivery reporting and the redirect state.
import { describe, expect, test } from "bun:test"
import {
  CAPABILITIES,
  DEFAULT_SHORTCUT,
  MAX_PRESSES,
  SMOKE_BUTTONS,
  describeDelivery,
  describeValue,
  formatPress,
  formatRedirect,
  initialSmokeView,
  parseRedirectEvent,
  parseShortcutPress,
  parseSmokeReport,
  reduceSmoke,
  registeredAccelerator,
  shortcutHint,
  singleInstanceHint,
  summarizeCapability,
  type ShortcutPress,
  type SmokeReport,
} from "./capabilitySmokeCore"

const CANONICAL = "shift+control+KeyK"

/** `Array.prototype.at` is outside this program's lib; keep the intent explicit. */
function last<T>(items: T[]): T | undefined {
  return items[items.length - 1]
}

function report(overrides: Partial<SmokeReport> = {}): SmokeReport {
  return { capability: "tray", ok: true, detail: "ok", ...overrides }
}

function press(overrides: Partial<ShortcutPress> = {}): ShortcutPress {
  return {
    accelerator: CANONICAL,
    id: 7,
    delivery: "delivered",
    detail: null,
    host: { phase: "ready", pid: 4242, lastError: null },
    ...overrides,
  }
}

describe("smoke descriptors", () => {
  // PINNED SOURCE: src-tauri/src/smoke.rs `SmokeAction`
  // (`#[serde(tag = "action", rename_all = "camelCase")]`) — the Rust test
  // `parse_action_rejects_unknown_or_misspelled_requests` asserts the shell
  // rejects anything outside this set.
  const RUST_TAGS = new Set([
    "notify",
    "dialogMessage",
    "dialogAsk",
    "dialogPickFile",
    "trayRender",
    "trayDispatch",
    "shortcutRegister",
    "shortcutUnregister",
    "secondInstance",
  ])

  test("every button sends a tag the shell accepts", () => {
    for (const button of SMOKE_BUTTONS) {
      const tag = button.request.action
      expect(typeof tag).toBe("string")
      expect(RUST_TAGS.has(tag as string)).toBe(true)
    }
  })

  test("every capability has at least one button", () => {
    for (const capability of CAPABILITIES) {
      expect(SMOKE_BUTTONS.some((button) => button.capability === capability)).toBe(true)
    }
  })

  test("every tray dispatch id is one of the shell's smoke-safe ids", () => {
    // PINNED SOURCE: src-tauri/src/tray.rs#is_smoke_safe_tray_id. The shell
    // rejects anything else, so a panel entry outside this set would only ever
    // produce an error row.
    const allowed = new Set(["core.window.show", "core.window.close", "core.webview.reload"])
    const dispatched = SMOKE_BUTTONS.filter((button) => button.request.action === "trayDispatch")
    expect(dispatched.length).toBeGreaterThan(0)
    for (const button of dispatched) {
      expect(allowed.has(String(button.request.id))).toBe(true)
    }
    // Destructive core items must never be reachable from a smoke button.
    for (const forbidden of [
      "core.app.quit.force",
      "core.host.stop.graceful",
      "core.app.restart.graceful",
    ]) {
      expect(dispatched.some((button) => button.request.id === forbidden)).toBe(false)
    }
  })

  test("the manual step is stated wherever a human must look", () => {
    for (const button of SMOKE_BUTTONS) {
      // Every button has an observable outcome; stating it is what turns the
      // panel into a checklist instead of a set of mystery buttons.
      expect(typeof button.manual).toBe("string")
      expect((button.manual ?? "").length).toBeGreaterThan(0)
    }
  })

  test("the notification hint explains the dev-state PowerShell attribution", () => {
    // The acceptance run reported "toast says PowerShell": that is the upstream
    // fallback for an unregistered AUMID, so the checklist must say so instead
    // of letting it read as our bug.
    const notify = SMOKE_BUTTONS.find((button) => button.id === "notify.simple")
    expect(notify?.manual).toContain("PowerShell")
    expect(notify?.manual).toContain("安装")
  })

  test("the single-instance hint says the second process exits by itself", () => {
    const single = SMOKE_BUTTONS.find((button) => button.id === "single.launch")
    expect(single?.manual).toContain("退出")
  })

  test("button ids are unique", () => {
    const ids = SMOKE_BUTTONS.map((button) => button.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("the default shortcut is a real accelerator the shell can parse", () => {
    // Shape only — the authoritative parser is Rust (`parse_accelerator`), and
    // the panel never parses a chord for identity.
    expect(DEFAULT_SHORTCUT).toContain("+")
    expect(DEFAULT_SHORTCUT).toMatch(/\+[A-Z0-9]$/)
  })
})

describe("wire validation", () => {
  test("parseSmokeReport keeps well-formed replies", () => {
    expect(parseSmokeReport({ capability: "tray", ok: true, detail: "d" })).toEqual({
      capability: "tray",
      ok: true,
      detail: "d",
      value: undefined,
      error: undefined,
    })
    expect(
      parseSmokeReport({ capability: "shortcut", ok: false, detail: "d", error: "e" })?.error,
    ).toBe("e")
  })

  test("parseSmokeReport drops anything malformed", () => {
    for (const raw of [
      null,
      "tray",
      {},
      { capability: "tray" },
      { capability: "tray", ok: "yes", detail: "d" },
      { capability: "nope", ok: true, detail: "d" },
      { capability: "tray", ok: true },
      // A capability the shell never reports (e.g. a future tag) is not shown
      // in a row that exists today.
      { capability: "unknown", ok: false, detail: "d" },
    ]) {
      expect(parseSmokeReport(raw)).toBeUndefined()
    }
  })

  test("parseShortcutPress requires a full shell event shape", () => {
    const payload: ShortcutPress = {
      accelerator: CANONICAL,
      id: 7,
      delivery: "delivered",
      detail: null,
      host: { phase: "ready", pid: 42, lastError: null },
    }
    expect(parseShortcutPress(payload)).toEqual(payload)

    for (const raw of [
      null,
      { accelerator: CANONICAL, id: 7 },
      { accelerator: "", id: 7, delivery: "delivered" },
      { accelerator: CANONICAL, id: 1.5, delivery: "delivered" },
      { accelerator: CANONICAL, id: "7", delivery: "delivered" },
      // The delivery verdict is mandatory: without it the panel cannot tell
      // "callback fired" from "host received it".
      { accelerator: CANONICAL, id: 7, delivery: true },
      { accelerator: CANONICAL, id: 7, delivery: "sent" },
    ]) {
      expect(parseShortcutPress(raw)).toBeUndefined()
    }
  })

  test("parseShortcutPress tolerates a missing host view but keeps a real one", () => {
    const withoutHost = parseShortcutPress({
      accelerator: CANONICAL,
      id: 7,
      delivery: "no-host",
      detail: null,
      host: null,
    })
    expect(withoutHost?.host).toBeNull()

    // A host view without a usable phase is dropped rather than half-rendered.
    const junkHost = parseShortcutPress({
      accelerator: CANONICAL,
      id: 7,
      delivery: "no-host",
      host: { pid: 1 },
    })
    expect(junkHost?.host).toBeNull()

    // Unknown extra fields do not break parsing; missing pid/lastError are fine.
    const partial = parseShortcutPress({
      accelerator: CANONICAL,
      id: 7,
      delivery: "no-host",
      host: { phase: "backoff" },
    })
    expect(partial?.host).toEqual({ phase: "backoff", pid: null, lastError: null })
  })

  test("parseRedirectEvent requires the focus verdict", () => {
    expect(parseRedirectEvent({ focused: true })).toEqual({
      focused: true,
      error: undefined,
      args: undefined,
      cwd: undefined,
    })
    expect(parseRedirectEvent({ focused: false, error: "no window" })).toEqual({
      focused: false,
      error: "no window",
      args: undefined,
      cwd: undefined,
    })
    // A payload without the verdict is not a redirect report.
    expect(parseRedirectEvent({ error: "x" })).toBeUndefined()
    expect(parseRedirectEvent(null)).toBeUndefined()
    // Non-string args are filtered out instead of leaking into the display.
    expect(parseRedirectEvent({ focused: true, args: ["a", 1, null] })?.args).toEqual(["a"])
  })

  test("registeredAccelerator reads the canonical spelling only from a success", () => {
    expect(
      registeredAccelerator(report({ capability: "shortcut", value: { accelerator: CANONICAL } })),
    ).toBe(CANONICAL)
    // A failure never yields a chord, even if it carries one.
    expect(
      registeredAccelerator(
        report({ capability: "shortcut", ok: false, value: { accelerator: CANONICAL } }),
      ),
    ).toBeNull()
    expect(registeredAccelerator(report({ capability: "shortcut", value: {} }))).toBeNull()
    expect(registeredAccelerator(report({ capability: "shortcut", value: null }))).toBeNull()
    expect(
      registeredAccelerator(report({ capability: "shortcut", value: { accelerator: "" } })),
    ).toBeNull()
  })
})

describe("panel state", () => {
  test("a report replaces only its own capability's row", () => {
    let view = initialSmokeView()
    view = reduceSmoke(view, {
      kind: "report",
      report: report({ capability: "tray", detail: "tray-ok" }),
    })
    view = reduceSmoke(view, {
      kind: "report",
      report: report({ capability: "dialog", ok: false, detail: "boom" }),
    })
    expect(summarizeCapability(view, "tray")).toBe("✔ tray-ok")
    expect(summarizeCapability(view, "dialog")).toBe("✘ boom")
    // Untouched capabilities stay untouched: a later row never inherits an
    // earlier row's verdict.
    expect(summarizeCapability(view, "shortcut")).toBe("尚未运行")
  })

  test("a report for an unknown capability is ignored, not stored", () => {
    const view = reduceSmoke(initialSmokeView(), {
      kind: "report",
      report: report({ capability: "nope" }),
    })
    expect(Object.keys(view.results)).toHaveLength(0)
  })

  test("presses are capped, newest last, sequence monotonic", () => {
    let view = initialSmokeView()
    view = reduceSmoke(view, { kind: "bound", accelerator: CANONICAL })
    for (let i = 0; i < MAX_PRESSES + 3; i += 1) {
      view = reduceSmoke(view, { kind: "press", press: press({ id: i }) })
    }
    expect(view.presses).toHaveLength(MAX_PRESSES)
    // The oldest entries were dropped, the newest is last.
    expect(last(view.presses)?.id).toBe(MAX_PRESSES + 2)
    expect(view.presses.map((entry) => entry.seq)).toEqual(
      [...view.presses.map((entry) => entry.seq)].sort((a, b) => a - b),
    )
  })

  test("a press is matched only against the chord this panel registered", () => {
    const bound = reduceSmoke(initialSmokeView(), { kind: "bound", accelerator: CANONICAL })
    const match = reduceSmoke(bound, { kind: "press", press: press() })
    expect(last(match.presses)?.matched).toBe(true)

    const other = reduceSmoke(match, {
      kind: "press",
      press: press({ accelerator: "shift+control+KeyJ", id: 2 }),
    })
    expect(last(other.presses)?.matched).toBe(false)

    // With nothing bound, no press can be "matched".
    const unbound = reduceSmoke(initialSmokeView(), { kind: "press", press: press({ id: 3 }) })
    expect(last(unbound.presses)?.matched).toBe(false)

    // A non-canonical spelling is never treated as the registered chord.
    const lexical = reduceSmoke(bound, {
      kind: "press",
      press: press({ accelerator: "Ctrl+Shift+K", id: 4 }),
    })
    expect(last(lexical.presses)?.matched).toBe(false)
  })

  test("redirects are appended, capped and share the sequence counter", () => {
    let view = reduceSmoke(initialSmokeView(), {
      kind: "press",
      press: press({ id: 1 }),
    })
    const pressesSeq = view.seq
    view = reduceSmoke(view, { kind: "redirect", event: { focused: true } })
    expect(view.redirects).toHaveLength(1)
    // A redirect must not renumber or drop the press log.
    expect(view.presses).toHaveLength(1)
    expect(view.seq).toBeGreaterThan(pressesSeq)

    for (let i = 0; i < MAX_PRESSES + 2; i += 1) {
      view = reduceSmoke(view, { kind: "redirect", event: { focused: true } })
    }
    expect(view.redirects).toHaveLength(MAX_PRESSES)
  })

  test("reset clears results, presses, redirects and the binding", () => {
    let view = reduceSmoke(initialSmokeView(), { kind: "bound", accelerator: CANONICAL })
    view = reduceSmoke(view, { kind: "report", report: report() })
    view = reduceSmoke(view, { kind: "press", press: press() })
    view = reduceSmoke(view, { kind: "redirect", event: { focused: true } })
    view = reduceSmoke(view, { kind: "reset" })
    expect(view).toEqual(initialSmokeView())
  })
})

describe("display helpers", () => {
  test("describeDelivery names the fault and the host state behind it", () => {
    expect(describeDelivery(press())).toBe("已投递 host（host ready, pid 4242）")

    const noHost = describeDelivery(
      press({ delivery: "no-host", host: { phase: "backoff", pid: null, lastError: "boom" } }),
    )
    expect(noHost).toContain("没有宿主进程在运行")
    expect(noHost).toContain("backoff")
    expect(noHost).toContain("boom")

    const writeFailed = describeDelivery(
      press({
        delivery: "write-failed",
        detail: "host stdio closed",
        host: { phase: "ready", pid: 9, lastError: null },
      }),
    )
    expect(writeFailed).toContain("宿主管道写入失败")
    expect(writeFailed).toContain("host stdio closed")

    // With no host view at all the sentence still stands on its own.
    const bare = describeDelivery(press({ delivery: "no-host", host: null }))
    expect(bare).toContain("没有宿主进程在运行")
    expect(bare).not.toContain("（host")
  })

  test("formatPress reports delivery and match", () => {
    const entry = { ...press(), seq: 3, at: new Date(), matched: true }
    expect(formatPress(entry)).toContain(CANONICAL)
    expect(formatPress(entry)).toContain("已投递 host")
    expect(formatPress({ ...entry, matched: false })).toContain("不是本面板注册的组合键")
  })

  test("formatRedirect distinguishes arrived-and-focused from arrived-but-failed", () => {
    expect(formatRedirect({ focused: true }, 1)).toContain("主窗口已聚焦")
    const failed = formatRedirect({ focused: false, error: "no window" }, 2)
    expect(failed).toContain("聚焦失败")
    expect(failed).toContain("no window")
    expect(formatRedirect({ focused: false }, 3)).toContain("未知原因")
  })

  test("describeValue is empty when there is nothing to show and never throws", () => {
    expect(describeValue(report({ value: undefined }))).toBe("")
    expect(describeValue(report({ value: null }))).toBe("")
    expect(describeValue(report({ value: { pid: 42 } }))).toBe('{"pid":42}')

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(describeValue(report({ value: circular }))).toBe("")
  })

  test("shortcutHint separates the states a developer can be in", () => {
    expect(shortcutHint(initialSmokeView())).toContain("尚未注册")

    const bound = reduceSmoke(initialSmokeView(), { kind: "bound", accelerator: CANONICAL })
    expect(shortcutHint(bound)).toContain("按一次试试")

    const delivered = reduceSmoke(bound, { kind: "press", press: press() })
    expect(shortcutHint(delivered)).toContain("完整链路已跑通")

    // A failure reuses the detailed sentence, so the hint itself carries the
    // reason instead of a vague "未投递 host".
    const undelivered = reduceSmoke(bound, {
      kind: "press",
      press: press({ delivery: "no-host", host: { phase: "failed", pid: null, lastError: "x" } }),
    })
    expect(shortcutHint(undelivered)).toContain("failed")

    const mismatch = reduceSmoke(bound, {
      kind: "press",
      press: press({ accelerator: "shift+control+KeyJ" }),
    })
    expect(shortcutHint(mismatch)).toContain("最近一次按键是 shift+control+KeyJ")
  })

  test("singleInstanceHint explains that the second process exits by itself", () => {
    expect(singleInstanceHint(initialSmokeView())).toContain("自行退出")

    const arrived = reduceSmoke(initialSmokeView(), {
      kind: "redirect",
      event: { focused: true },
    })
    expect(singleInstanceHint(arrived)).toContain("已到达并聚焦主窗口")

    const failed = reduceSmoke(initialSmokeView(), {
      kind: "redirect",
      event: { focused: false, error: "no window" },
    })
    expect(singleInstanceHint(failed)).toContain("聚焦失败")
    expect(singleInstanceHint(failed)).toContain("no window")
  })
})
