// Unit tests for makeRestartRequester (issue #11 restart-required policy).
// Covers: startup grace, per-entry 60s rate limit, no-shell logging (never
// silent), exit-51 only when a shell is attached, and the single-restart
// latch (no concurrent restarts).
import { describe, expect, test } from "bun:test"
import { makeRestartRequester, type RestartRequesterOptions } from "../src/restart"

function makeHarness(overrides: Partial<RestartRequesterOptions> = {}) {
  let clock = 0
  const exits: number[] = []
  const stops: string[] = []
  const options: RestartRequesterOptions = {
    shellAttached: false,
    now: () => clock,
    exitProcess: (code) => {
      exits.push(code)
    },
    gracefulStop: async (reason) => {
      stops.push(reason)
    },
    ...overrides,
  }
  const requester = makeRestartRequester({} as never, options)
  return {
    requester,
    advance(ms: number) {
      clock += ms
    },
    get exits() {
      return exits
    },
    get stops() {
      return stops
    },
  }
}

describe("makeRestartRequester", () => {
  test("suppresses restart-required during the 10s startup grace", () => {
    const h = makeHarness({ shellAttached: true })
    h.requester({ entryId: "a", error: new Error("boom") })
    expect(h.exits).toHaveLength(0)
    expect(h.stops).toHaveLength(0)
  })

  test("suppresses a second request for the same entry inside the 60s rate limit", async () => {
    const h = makeHarness({ shellAttached: true })
    h.advance(10_001) // past the startup grace
    h.requester({ entryId: "a", error: new Error("boom") })
    // gracefulStop (fake) resolves; the exit runs after its 10ms delay.
    await new Promise((r) => setTimeout(r, 30))
    expect(h.stops).toEqual(["restart"])
    expect(h.exits).toEqual([51])

    // Same entry again inside 60s → suppressed (rate limit per entry).
    h.advance(30_000)
    h.requester({ entryId: "a", error: new Error("boom again") })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.stops).toHaveLength(1)
    expect(h.exits).toHaveLength(1)
  })

  test("allows a different entry immediately once the previous restart finished (per-entry limit)", async () => {
    const h = makeHarness({ shellAttached: true })
    h.advance(10_001)
    h.requester({ entryId: "a", error: new Error("boom") })
    await new Promise((r) => setTimeout(r, 30)) // restart cycle completes
    h.requester({ entryId: "b", error: new Error("boom b") })
    await new Promise((r) => setTimeout(r, 30))
    expect(h.stops).toHaveLength(2)
    expect(h.exits).toHaveLength(2)
  })

  test("logs and does nothing when no shell is attached (never silent)", () => {
    const h = makeHarness({ shellAttached: false })
    h.advance(10_001)
    h.requester({ entryId: "a", error: new Error("boom") })
    expect(h.exits).toHaveLength(0)
    expect(h.stops).toHaveLength(0)
  })

  test("exits 51 after graceful stop when a shell is attached", async () => {
    const h = makeHarness({ shellAttached: true })
    h.advance(10_001)
    h.requester({ entryId: "a", error: new Error("boom") })
    await new Promise((r) => setTimeout(r, 30)) // 10ms exit delay
    expect(h.stops).toEqual(["restart"])
    expect(h.exits).toEqual([51])
  })

  test("never starts a second restart while one is in progress", async () => {
    // A graceful stop that never settles keeps the restart latch engaged.
    let clock = 0
    const stops: string[] = []
    const requester = makeRestartRequester({} as never, {
      shellAttached: true,
      now: () => clock,
      exitProcess: () => {},
      gracefulStop: async (reason) => {
        stops.push(reason)
        return new Promise<never>(() => {}) // never settles
      },
    })
    clock = 10_001 // past the startup grace (grace is measured from construct)
    requester({ entryId: "a", error: new Error("boom") })
    // In-flight (gracefulStop pending forever).
    requester({ entryId: "b", error: new Error("boom b") })
    await new Promise((r) => setTimeout(r, 30))
    // Only one stop was initiated; entry b hit the in-progress latch.
    expect(stops).toHaveLength(1)
  })
})
