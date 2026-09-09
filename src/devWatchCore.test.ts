// Unit tests for the dev-watch panel pure logic (no React/DOM harness needed).
import { describe, expect, test } from "bun:test"
import {
  appendLog,
  dedupPush,
  DEV_WATCH_DEDUP_WINDOW_MS,
  idleHint,
  MAX_LOG,
  pushSignature,
  summarize,
  toastPlan,
  type DevWatchLog,
  type DevWatchPush,
} from "./devWatchCore"

const reload = (status: string | undefined, error?: string): DevWatchPush => ({
  type: "reload",
  entryId: "plugin.echo",
  status,
  error,
})

describe("toastPlan", () => {
  test("reload success maps to a success toast", () => {
    expect(toastPlan(reload("reloaded"))).toEqual({
      level: "success",
      title: "Dev reload: plugin.echo 已重载",
    })
  })

  test("kept-old and restored-old map to warnings", () => {
    expect(toastPlan(reload("kept-old", "import boom"))?.level).toBe("warning")
    expect(toastPlan(reload("kept-old", "import boom"))?.description).toBe("import boom")
    expect(toastPlan(reload("restored-old"))?.level).toBe("warning")
  })

  test("restart-required maps to an error and keeps the restart UX message", () => {
    const plan = toastPlan(reload("restart-required"))
    expect(plan?.level).toBe("error")
    expect(plan?.title).toContain("需要重启宿主")
    expect(plan?.description).toContain("重启宿主")
  })

  test("timeout maps to an error with the error text", () => {
    const plan = toastPlan(reload("timeout", "took too long"))
    expect(plan?.level).toBe("error")
    expect(plan?.description).toBe("took too long")
  })

  test("unknown reload status without error stays informational", () => {
    const plan = toastPlan(reload("mystery-status"))
    expect(plan?.level).toBe("info")
  })

  test("skipped (real host status) is an info toast, not a raw token", () => {
    const plan = toastPlan(reload("skipped"))
    expect(plan?.level).toBe("info")
    expect(plan?.title).toContain("已在队列中跳过")
    expect(plan?.title).not.toContain("skipped")
    expect(plan?.description).toBeTruthy()
    // An error, when the host supplies one, is still surfaced as text.
    expect(toastPlan(reload("skipped", "no fiber"))?.description).toBe("no fiber")
  })

  test("watcher/config errors map to errors with the message", () => {
    expect(toastPlan({ type: "watcher-error", error: "watch broke" })).toEqual({
      level: "error",
      title: "Dev watch: watcher-error",
      description: "watch broke",
    })
    expect(toastPlan({ type: "config-error", error: "bad yaml" })?.level).toBe("error")
  })

  test("started shows one informational toast", () => {
    expect(toastPlan({ type: "started" })).toEqual({
      level: "info",
      title: "Dev watch 已启动",
    })
  })

  test("change/unowned/ambiguous/config-refreshed/closed stay silent (panel only)", () => {
    expect(toastPlan({ type: "change", path: "x.ts", entries: ["e"] })).toBeNull()
    expect(toastPlan({ type: "unowned", path: "y.ts" })).toBeNull()
    expect(toastPlan({ type: "ambiguous", path: "z.ts", entries: ["a", "b"] })).toBeNull()
    expect(toastPlan({ type: "config-refreshed", entries: ["a"] })).toBeNull()
    expect(toastPlan({ type: "closed" })).toBeNull()
  })
})

describe("summarize", () => {
  test("prefers entryId, then path, then entry count, then empty", () => {
    expect(summarize({ type: "reload", entryId: "plugin.a", path: "p", status: "reloaded" })).toBe(
      "plugin.a",
    )
    expect(summarize({ type: "change", path: "src/x.ts" })).toBe("src/x.ts")
    expect(summarize({ type: "config-refreshed", entries: ["a", "b", "c"] })).toBe("3 entry(ies)")
    expect(summarize({ type: "closed" })).toBe("")
  })
})

describe("appendLog", () => {
  const push = (type: string): DevWatchPush => ({ type })
  const entry = (seq: number): DevWatchLog => ({ seq, at: new Date(), push: push(`t${seq}`) })

  test("prepends newest first", () => {
    const log = appendLog([], entry(1))
    const log2 = appendLog(log, entry(2))
    expect(log2.map((e) => e.seq)).toEqual([2, 1])
  })

  test("caps at MAX_LOG (8) dropping the oldest", () => {
    let log: DevWatchLog[] = []
    for (let seq = 1; seq <= 12; seq++) log = appendLog(log, entry(seq))
    expect(log.length).toBe(MAX_LOG)
    expect(log.map((e) => e.seq)).toEqual([12, 11, 10, 9, 8, 7, 6, 5])
  })

  test("honors a custom cap", () => {
    let log: DevWatchLog[] = []
    for (let seq = 1; seq <= 4; seq++) log = appendLog(log, entry(seq), 2)
    expect(log.map((e) => e.seq)).toEqual([4, 3])
  })
})

describe("pushSignature", () => {
  test("omitted and explicitly-undefined fields share one signature", () => {
    expect(pushSignature({ type: "closed" })).toBe(pushSignature({ type: "closed", entryId: undefined }))
  })

  test("entry order participates in the signature", () => {
    const a = pushSignature({ type: "config-refreshed", entries: ["a", "b"] })
    const b = pushSignature({ type: "config-refreshed", entries: ["a", "b"] })
    const c = pushSignature({ type: "config-refreshed", entries: ["b", "a"] })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe("dedupPush", () => {
  const reloadPush = (over: Partial<DevWatchPush> = {}): DevWatchPush => ({
    type: "reload",
    entryId: "plugin.echo",
    status: "reloaded",
    ...over,
  })

  test("identical consecutive push inside the window is a duplicate", () => {
    const first = dedupPush(null, reloadPush(), 1000)
    expect(first.duplicate).toBe(false)
    expect(first.state.at).toBe(1000)

    const second = dedupPush(first.state, reloadPush(), 1200)
    expect(second.duplicate).toBe(true)
    // The window stays anchored to the first push, so the burst cannot extend it.
    expect(second.state.at).toBe(1000)
  })

  test("the window is a parameter", () => {
    const first = dedupPush(null, reloadPush(), 0, 100)
    expect(dedupPush(first.state, reloadPush(), 99, 100).duplicate).toBe(true)
    expect(dedupPush(first.state, reloadPush(), 100, 100).duplicate).toBe(false)
    // Non-positive window disables suppression entirely.
    expect(dedupPush(first.state, reloadPush(), 0, 0).duplicate).toBe(false)
    expect(DEV_WATCH_DEDUP_WINDOW_MS).toBeGreaterThan(0)
  })

  test("after the window a repeat is accepted again with a fresh anchor", () => {
    const window = DEV_WATCH_DEDUP_WINDOW_MS
    const first = dedupPush(null, reloadPush(), 0)
    // Window-relative so the test does not pin the constant's value.
    const dup = dedupPush(first.state, reloadPush(), window - 1)
    expect(dup.duplicate).toBe(true)

    const third = dedupPush(dup.state, reloadPush(), window)
    expect(third.duplicate).toBe(false)
    expect(third.state.at).toBe(window)
  })

  test("a different payload is never a duplicate", () => {
    const first = dedupPush(null, reloadPush(), 0)
    expect(dedupPush(first.state, reloadPush({ status: "kept-old", error: "boom" }), 10).duplicate).toBe(false)
    expect(dedupPush(first.state, reloadPush({ entryId: "plugin.other" }), 10).duplicate).toBe(false)
    expect(dedupPush(first.state, { type: "change", path: "src/x.ts" }, 10).duplicate).toBe(false)
    expect(dedupPush(first.state, { type: "change", path: "src/y.ts" }, 10).duplicate).toBe(false)
    expect(dedupPush(null, reloadPush(), 10).duplicate).toBe(false)
  })

  test("a clock that jumps backwards never suppresses a real event", () => {
    const first = dedupPush(null, reloadPush(), 5000)
    expect(dedupPush(first.state, reloadPush(), 4000).duplicate).toBe(false)
  })
})

describe("idleHint", () => {
  test("pending listener asks the user to wait, not to restart the host", () => {
    expect(idleHint({ everReceived: false, listen: "pending" })).toContain("正在连接")
  })

  test("after an F5 (listener ok, nothing received) the host is not reported as unconfigured", () => {
    const hint = idleHint({ everReceived: false, listen: "ok" })
    expect(hint).toContain("本页面尚未收到")
    // The old false-negative wording must be gone: an F5 leaves everReceived
    // false even though the watcher is running (started is emitted once).
    expect(hint).not.toBe("未收到 dev-watch 事件：宿主需以 VRCXK_DEV_WATCH=1 启动（重启宿主后生效）")
    expect(hint).toContain("刚刷新页面属正常")
    expect(hint).toContain("VRCXK_DEV_WATCH=1")
  })

  test("after any event it switches to the waiting wording", () => {
    expect(idleHint({ everReceived: true, listen: "ok" })).toBe("等待 dev-watch 事件…")
  })

  test("failed listener reports the reason and keeps the panel usable", () => {
    const hint = idleHint({ everReceived: false, listen: "failed", listenError: "no ipc" })
    expect(hint).toContain("无法监听")
    expect(hint).toContain("no ipc")
    expect(hint).toContain("面板仍可用")
    expect(idleHint({ everReceived: false, listen: "failed" })).toContain("未知错误")
  })
})
