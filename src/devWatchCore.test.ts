// Unit tests for the dev-watch panel pure logic (no React/DOM harness needed).
import { describe, expect, test } from "bun:test"
import {
  appendLog,
  MAX_LOG,
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
