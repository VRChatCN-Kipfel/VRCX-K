import { expect, test } from "bun:test"
import { gracefulStopWithTimeout } from "../src/lifecycle"

test("graceful stop deadline stops awaiting a hung disposer", async () => {
  const ctx = {
    registry: new Map(),
    fiber: {
      _disposables: {
        clear: () => [() => new Promise<void>(() => {})],
      },
    },
  }

  const started = performance.now()
  await gracefulStopWithTimeout(ctx as never, 25)
  expect(performance.now() - started).toBeLessThan(500)
})
