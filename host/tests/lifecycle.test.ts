import { expect, test } from "bun:test"
import { gracefulStopWithTimeout } from "../src/lifecycle"
import { ShutdownSignal } from "../src/signal"

function fakeCtx(signal: ShutdownSignal) {
  return {
    signal,
    registry: new Map(),
    fiber: {
      _disposables: {
        clear: () => [],
      },
    },
  }
}

test("graceful stop deadline stops awaiting a hung disposer", async () => {
  const signal = new ShutdownSignal()
  const ctx = {
    signal,
    registry: new Map(),
    fiber: {
      _disposables: {
        clear: () => [() => new Promise<void>(() => {})],
      },
    },
  }

  const started = performance.now()
  await gracefulStopWithTimeout(ctx as never, "stop", 25, 500)
  expect(performance.now() - started).toBeLessThan(500)
  expect(signal.stopping).toBe(true)
  expect(signal.reason).toBe("stop")
})

test("extend pushes the deadline and returns remaining time", async () => {
  const signal = new ShutdownSignal()
  signal.begin(100, 10_000, "restart")
  expect(signal.stopping).toBe(true)
  expect(signal.reason).toBe("restart")

  const remainingBefore = signal.remaining
  const remainingAfter = signal.extend(1000)
  expect(remainingAfter).toBeGreaterThan(remainingBefore)
  // deadline moved forward
  const deadline = signal.deadline!
  expect(deadline).toBeGreaterThan(Date.now())
})

test("extend respects the hard cap", async () => {
  const signal = new ShutdownSignal()
  signal.begin(100, 500, "stop")
  // Try to extend well beyond the 500ms hard cap.
  signal.extend(10_000)
  const hardCap = signal.hardCap!
  expect(hardCap - Date.now()).toBeLessThanOrEqual(500 + 50)
  // deadline cannot exceed the hard cap
  expect(signal.deadline!).toBeLessThanOrEqual(hardCap)
})

test("deadline promise resolves on timeout", async () => {
  const signal = new ShutdownSignal()
  signal.begin(30, 500, "stop")
  const outcome = await signal.deadlinePromise
  expect(outcome).toBe("timeout")
})

test("begin is a one-shot gate: a second begin while stopping returns false and keeps the first reason", () => {
  const signal = new ShutdownSignal()
  expect(signal.begin(100, 10_000, "stop")).toBe(true)
  expect(signal.begin(100, 10_000, "restart")).toBe(false)
  // First trigger's reason/deadline are preserved.
  expect(signal.reason).toBe("stop")
  expect(signal.deadline).not.toBeNull()
})

test("graceful stop gate: a concurrent second stop does not run cleanup twice", async () => {
  const signal = new ShutdownSignal()
  let disposeRuns = 0
  const ctx = {
    signal,
    registry: new Map(),
    fiber: {
      _disposables: {
        clear: () => [
          async () => {
            disposeRuns++
            // Hang until the deadline so the first call stays in flight.
            await new Promise<void>(() => {})
          },
        ],
      },
    },
  }

  // First call acquires the gate and starts cleanup (which hangs on the
  // disposer until the 60ms deadline).
  const first = gracefulStopWithTimeout(ctx as never, "stop", 30, 60)
  // Second, concurrent request (e.g. stdio stop RPC racing the dev-watch
  // restart requester) must be a no-op.
  const second = await gracefulStopWithTimeout(ctx as never, "restart", 30, 60)
  expect(second).toBe(false)
  await first
  expect(disposeRuns).toBe(1) // cleanup ran exactly once
  expect(signal.reason).toBe("stop") // first trigger's reason preserved
})

test("graceful stop gate: a lone stop still returns true and cleans up", async () => {
  const signal = new ShutdownSignal()
  let disposeRuns = 0
  const ctx = {
    signal,
    registry: new Map(),
    fiber: {
      _disposables: {
        clear: () => [
          async () => {
            disposeRuns++
          },
        ],
      },
    },
  }
  const acquired = await gracefulStopWithTimeout(ctx as never, "stop", 30, 500)
  expect(acquired).toBe(true)
  expect(disposeRuns).toBe(1)
  expect(signal.stopping).toBe(true)
  expect(signal.reason).toBe("stop")
})