// Unit tests for the frontend host-lifecycle contract owner
// (src/hostLifecycle.ts). Pure logic only — no React/DOM/Tauri harness.
import { describe, expect, test } from "bun:test"
import {
  formatHostSnapshot,
  hostLifecycleSummary,
  initialHostLifecycleView,
  isHostLifecycleEnvelope,
  isHostSnapshot,
  isStaleSnapshot,
  parseHostLifecyclePayload,
  reduceHostLifecycle,
  type HostLifecycleView,
  type HostSnapshot,
} from "./hostLifecycle"

const snapshot = (over: Partial<HostSnapshot> = {}): HostSnapshot => ({
  schemaVersion: 1,
  generation: 3,
  phase: "ready",
  desired: "running",
  pid: 4242,
  port: 43121,
  attempt: 0,
  nextRetryMs: null,
  lastExit: null,
  lastError: null,
  ...over,
})

describe("isHostSnapshot / envelope guard", () => {
  test("accepts a bare valid snapshot", () => {
    expect(isHostSnapshot(snapshot())).toBe(true)
  })

  test("is exactly as strict as the host validator: {lastExit: []} is rejected", () => {
    // The old hand-fork accepted any object here; the canonical host validator
    // requires a HostExitSummary.
    expect(isHostSnapshot({ ...snapshot(), lastExit: [] })).toBe(false)
    expect(isHostSnapshot({ ...snapshot(), lastExit: { code: 1, signal: null, kind: "crashed" } })).toBe(true)
    expect(isHostSnapshot({ ...snapshot(), lastExit: { code: 1, signal: null, kind: "nope" } })).toBe(false)
    expect(isHostSnapshot({ ...snapshot(), lastExit: { code: "1", signal: null, kind: "crashed" } })).toBe(false)
  })

  test("rejects the {snapshot} envelope in the bare guard", () => {
    expect(isHostSnapshot({ snapshot: snapshot() })).toBe(false)
  })

  test("unwraps the envelope explicitly, strictly", () => {
    expect(isHostLifecycleEnvelope({ snapshot: snapshot() })).toBe(true)
    expect(isHostLifecycleEnvelope({ snapshot: { ...snapshot(), lastExit: [] } })).toBe(false)
    // Exactly one own key named `snapshot`; no extra fields smuggled in.
    expect(isHostLifecycleEnvelope({ snapshot: snapshot(), extra: 1 })).toBe(false)
    expect(isHostLifecycleEnvelope({ snapshot: snapshot(), generation: 9 })).toBe(false)
    expect(isHostLifecycleEnvelope(null)).toBe(false)
    expect(isHostLifecycleEnvelope("snapshot")).toBe(false)
  })

  test("parseHostLifecyclePayload accepts both IPC shapes and nulls everything else", () => {
    expect(parseHostLifecyclePayload({ snapshot: snapshot() })).toEqual(snapshot())
    expect(parseHostLifecyclePayload(snapshot())).toEqual(snapshot())
    expect(parseHostLifecyclePayload({ snapshot: { phase: "ready" } })).toBeNull()
    expect(parseHostLifecyclePayload(undefined)).toBeNull()
    expect(parseHostLifecyclePayload([])).toBeNull()
  })
})

describe("isStaleSnapshot", () => {
  test("older generation is stale, equal or newer is not", () => {
    expect(isStaleSnapshot(snapshot({ generation: 5 }), snapshot({ generation: 4 }))).toBe(true)
    expect(isStaleSnapshot(snapshot({ generation: 5 }), snapshot({ generation: 5 }))).toBe(false)
    expect(isStaleSnapshot(snapshot({ generation: 5 }), snapshot({ generation: 6 }))).toBe(false)
    expect(isStaleSnapshot(null, snapshot({ generation: 0 }))).toBe(false)
  })
})

describe("reduceHostLifecycle", () => {
  test("response with an envelope goes live", () => {
    const view = reduceHostLifecycle(initialHostLifecycleView, {
      kind: "response",
      raw: { snapshot: snapshot() },
    })
    expect(view.status).toBe("live")
    expect(view.snapshot).toEqual(snapshot())
    expect(view.notice).toBeNull()
  })

  test("response with a bare snapshot also goes live", () => {
    const view = reduceHostLifecycle(initialHostLifecycleView, { kind: "response", raw: snapshot() })
    expect(view.status).toBe("live")
  })

  test("unrecognized response degrades to unsupported instead of throwing", () => {
    const view = reduceHostLifecycle(initialHostLifecycleView, { kind: "response", raw: { snapshot: {} } })
    expect(view.status).toBe("unsupported")
    expect(view.snapshot).toBeNull()
    expect(view.notice).toContain("无法识别")
  })

  test("event updates a live view", () => {
    const first = reduceHostLifecycle(initialHostLifecycleView, { kind: "response", raw: snapshot() })
    const next = reduceHostLifecycle(first, {
      kind: "event",
      raw: { snapshot: snapshot({ generation: 4, phase: "backoff", nextRetryMs: 1500 }) },
    })
    expect(next.status).toBe("live")
    expect(next.snapshot?.phase).toBe("backoff")
    expect(next.snapshot?.generation).toBe(4)
  })

  test("malformed event keeps the last known good snapshot", () => {
    const live = reduceHostLifecycle(initialHostLifecycleView, { kind: "response", raw: snapshot() })
    expect(reduceHostLifecycle(live, { kind: "event", raw: { snapshot: { lastExit: [] } } })).toBe(live)
    expect(reduceHostLifecycle(live, { kind: "event", raw: null })).toBe(live)
  })

  test("out-of-order event with an older generation is ignored", () => {
    const live = reduceHostLifecycle(initialHostLifecycleView, {
      kind: "response",
      raw: snapshot({ generation: 7 }),
    })
    expect(reduceHostLifecycle(live, { kind: "event", raw: snapshot({ generation: 6 }) })).toBe(live)
    const sameGen = reduceHostLifecycle(live, {
      kind: "event",
      raw: snapshot({ generation: 7, phase: "stopping" }),
    })
    expect(sameGen.snapshot?.phase).toBe("stopping")
  })

  test("unsupported (missing command on an older shell) never clobbers a live snapshot", () => {
    const live = reduceHostLifecycle(initialHostLifecycleView, { kind: "response", raw: snapshot() })
    expect(reduceHostLifecycle(live, { kind: "unsupported", reason: "no command" })).toBe(live)

    const pending = reduceHostLifecycle(initialHostLifecycleView, {
      kind: "unsupported",
      reason: "no command",
    })
    expect(pending.status).toBe("unsupported")
    expect(pending.notice).toBe("no command")
  })

  test("unparseable response never clobbers a live snapshot (concurrent invoke vs event)", () => {
    // The one-shot invoke and the event stream race on mount; a response we
    // cannot parse must be as harmless as an `unsupported` action.
    const live = reduceHostLifecycle(initialHostLifecycleView, { kind: "event", raw: snapshot() })
    expect(live.status).toBe("live")
    expect(reduceHostLifecycle(live, { kind: "response", raw: { snapshot: {} } })).toBe(live)
    expect(reduceHostLifecycle(live, { kind: "response", raw: null })).toBe(live)

    // From a pending view the same response still degrades visibly.
    const degraded = reduceHostLifecycle(initialHostLifecycleView, {
      kind: "response",
      raw: { snapshot: {} },
    })
    expect(degraded.status).toBe("unsupported")
    expect(degraded.snapshot).toBeNull()
  })

  test("listen error keeps the last snapshot and surfaces the message", () => {
    const live = reduceHostLifecycle(initialHostLifecycleView, { kind: "response", raw: snapshot() })
    const failed = reduceHostLifecycle(live, { kind: "error", message: "listen boom" })
    expect(failed.status).toBe("error")
    expect(failed.snapshot).toEqual(snapshot())
    expect(failed.notice).toBe("listen boom")
  })
})

describe("formatHostSnapshot", () => {
  test("renders every reviewed field in order", () => {
    expect(formatHostSnapshot(snapshot()).map((f) => f.key)).toEqual([
      "phase",
      "desired",
      "generation",
      "attempt",
      "pid",
      "port",
      "nextRetryMs",
      "lastError",
    ])
  })

  test("formats values and uses a placeholder for null optionals", () => {
    const fields = formatHostSnapshot(
      snapshot({ attempt: 2, pid: null, port: null, nextRetryMs: 1500, lastError: "spawn failed" }),
    )
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f.value]))
    expect(byKey.phase).toBe("ready")
    expect(byKey.desired).toBe("running")
    expect(byKey.generation).toBe("3")
    expect(byKey.attempt).toBe("2")
    expect(byKey.pid).toBe("—")
    expect(byKey.port).toBe("—")
    expect(byKey.nextRetryMs).toBe("1500 ms")
    expect(byKey.lastError).toBe("spawn failed")
  })

  test("null nextRetryMs/lastError show the placeholder", () => {
    const byKey = Object.fromEntries(formatHostSnapshot(snapshot()).map((f) => [f.key, f.value]))
    expect(byKey.nextRetryMs).toBe("—")
    expect(byKey.lastError).toBe("—")
    expect(byKey.pid).toBe("4242")
    expect(byKey.port).toBe("43121")
  })
})

describe("hostLifecycleSummary", () => {
  const view = (over: Partial<HostLifecycleView>): HostLifecycleView => ({
    ...initialHostLifecycleView,
    ...over,
  })

  test("pending", () => {
    expect(hostLifecycleSummary(initialHostLifecycleView)).toBe("正在读取宿主生命周期…")
  })

  test("unsupported and error include the notice as plain text", () => {
    expect(hostLifecycleSummary(view({ status: "unsupported", notice: "无此命令" }))).toBe(
      "不可用：无此命令",
    )
    expect(hostLifecycleSummary(view({ status: "error", notice: "listen boom" }))).toBe(
      "读取失败：listen boom",
    )
  })

  test("live shows phase/desired/generation plus pid/port when present", () => {
    expect(hostLifecycleSummary(view({ status: "live", snapshot: snapshot() }))).toBe(
      "ready · desired running · gen 3 · pid 4242 · port 43121",
    )
    expect(
      hostLifecycleSummary(view({ status: "live", snapshot: snapshot({ pid: null, port: null }) })),
    ).toBe("ready · desired running · gen 3")
  })

  test("live without a snapshot stays in the pending wording (no crash)", () => {
    expect(hostLifecycleSummary(view({ status: "live", snapshot: null }))).toBe("正在读取宿主生命周期…")
  })
})
