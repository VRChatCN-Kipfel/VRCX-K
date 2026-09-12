// ShortcutService unit tests (issue #6 shortcut callback, host side).
//
// No real shell is involved: a fake bridge records register/unregister calls and
// lets the test deliver presses exactly as the shell would. The point of these
// tests is the CONTRACT the two sides must agree on:
//   - a binding is keyed on the canonical spelling the SHELL returned, not on
//     whatever the caller typed;
//   - only a bound chord runs a handler, an unbound press is logged not guessed;
//   - one throwing handler cannot break the others or the notification path;
//   - with no shell attached nothing pretends to be registered.
import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import {
  ShortcutService,
  normalizePress,
  type ShortcutServiceOptions,
} from "../src/shortcut"
import type {
  ShellShortcutBridge,
  ShortcutPressEvent,
  ShortcutRegistration,
} from "../src/stdio"

// ShortcutService is a cordis `Service` (M2-1 attribution), so it needs a
// Context to register on. Each service gets its own root Context — a shared one
// would reject the second "shortcut" registration.
const makeShortcut = (options?: ShortcutServiceOptions) => new ShortcutService(new Context(), options)

/** Canonical spelling a real shell returns for `CommandOrControl+Shift+K`. */
const CANONICAL = "shift+control+KeyK"

function fakeBridge(
  respond: (accelerator: string, op: "register" | "unregister") => ShortcutRegistration = () => ({
    ok: true,
    accelerator: CANONICAL,
  }),
) {
  const calls: Array<{ op: "register" | "unregister"; accelerator: string }> = []
  let press: ((event: ShortcutPressEvent) => void) | undefined
  let unsubscribed = 0
  const bridge: ShellShortcutBridge = {
    async register(accelerator) {
      calls.push({ op: "register", accelerator })
      return respond(accelerator, "register")
    },
    async unregister(accelerator) {
      calls.push({ op: "unregister", accelerator })
      return respond(accelerator, "unregister")
    },
    onPress(handler) {
      press = handler
      return () => {
        unsubscribed += 1
        press = undefined
      }
    },
  }
  return {
    bridge,
    calls,
    get unsubscribed() {
      return unsubscribed
    },
    /** Deliver a press as the shell would (canonical spelling). */
    deliver(event: ShortcutPressEvent) {
      press?.(event)
    },
  }
}

describe("ShortcutService registration", () => {
  test("binds under the canonical spelling the shell returned", async () => {
    const shell = fakeBridge()
    const service = makeShortcut()
    service.attachShell(shell.bridge)

    const seen: ShortcutPressEvent[] = []
    const result = await service.register("CommandOrControl+Shift+K", (event) => seen.push(event))
    // The caller's spelling is what went over the wire…
    expect(shell.calls).toEqual([{ op: "register", accelerator: "CommandOrControl+Shift+K" }])
    // …but the binding is keyed on the shell's canonical answer, so the host
    // never has to parse an accelerator itself.
    expect(result).toEqual({ status: "registered", accelerator: CANONICAL })
    expect(service.bound).toEqual([CANONICAL])

    shell.deliver({ accelerator: CANONICAL, id: 42 })
    expect(seen).toEqual([{ accelerator: CANONICAL, id: 42 }])
  })

  test("a rejected registration binds nothing", async () => {
    const shell = fakeBridge(() => ({ ok: false, error: "already in use" }))
    const service = makeShortcut()
    service.attachShell(shell.bridge)

    expect(await service.register("Ctrl+Shift+K", () => {})).toEqual({
      status: "rejected",
      error: "already in use",
    })
    expect(service.bound).toEqual([])
    // A press of that chord must find no handler.
    const logs: string[] = []
    const logging = makeShortcut({ log: (line) => logs.push(line) })
    logging.attachShell(shell.bridge)
    expect(logging.dispatchPress({ accelerator: CANONICAL, id: 1 })).toBe(false)
    expect(logs[0]).toContain("unbound chord")
  })

  test("with no shell attached register reports no-shell instead of throwing", async () => {
    const service = makeShortcut()
    expect(await service.register("Ctrl+Shift+K", () => {})).toEqual({ status: "no-shell" })
    expect(await service.unregister("Ctrl+Shift+K")).toEqual({ status: "no-shell" })
    expect(service.bound).toEqual([])
  })

  test("unregister drops the binding so the chord goes silent", async () => {
    const shell = fakeBridge()
    const service = makeShortcut()
    service.attachShell(shell.bridge)
    await service.register("Ctrl+Shift+K", () => {})
    expect(service.bound).toEqual([CANONICAL])

    expect(await service.unregister(CANONICAL)).toEqual({
      status: "registered",
      accelerator: CANONICAL,
    })
    expect(service.bound).toEqual([])
  })

  test("a bridge that throws is reported, not surfaced as a crash", async () => {
    const service = makeShortcut()
    service.attachShell({
      register: async () => {
        throw new Error("pipe closed")
      },
      unregister: async () => {
        throw new Error("pipe closed")
      },
      onPress: () => () => {},
    })
    expect(await service.register("Ctrl+Shift+K", () => {})).toEqual({
      status: "rejected",
      error: "pipe closed",
    })
    expect(await service.unregister("Ctrl+Shift+K")).toEqual({
      status: "rejected",
      error: "pipe closed",
    })
  })
})

describe("ShortcutService press fan-out", () => {
  test("only the bound chord runs a handler", async () => {
    const shell = fakeBridge()
    const service = makeShortcut()
    service.attachShell(shell.bridge)
    let runs = 0
    await service.register("Ctrl+Shift+K", () => {
      runs += 1
    })

    shell.deliver({ accelerator: CANONICAL, id: 1 })
    expect(runs).toBe(1)
    // A different canonical chord (e.g. registered by someone else) must not
    // fire this handler.
    shell.deliver({ accelerator: "shift+control+KeyJ", id: 2 })
    expect(runs).toBe(1)
    // A non-canonical spelling would be a shell bug, not a match: it must NOT
    // be treated as the same chord.
    expect(service.dispatchPress({ accelerator: "Ctrl+Shift+K", id: 3 })).toBe(false)
    expect(runs).toBe(1)
  })

  test("a malformed payload is logged and ignored instead of guessed at", () => {
    const logs: string[] = []
    const service = makeShortcut({ log: (line) => logs.push(line) })
    for (const payload of [
      null,
      "shift+control+KeyK",
      {},
      { accelerator: "", id: 1 },
      { accelerator: CANONICAL },
      { accelerator: CANONICAL, id: "1" },
      { accelerator: CANONICAL, id: Number.NaN },
    ]) {
      expect(service.dispatchPress(payload)).toBe(false)
    }
    expect(logs).toHaveLength(7)
    for (const line of logs) expect(line).toContain("invalid payload")
  })

  test("one throwing handler cannot stop the press path", async () => {
    const shell = fakeBridge()
    const logs: string[] = []
    const service = makeShortcut({ log: (line) => logs.push(line) })
    service.attachShell(shell.bridge)
    await service.register("Ctrl+Shift+K", () => {
      throw new Error("business handler exploded")
    })

    expect(() => shell.deliver({ accelerator: CANONICAL, id: 1 })).not.toThrow()
    expect(logs.some((line) => line.includes("handler error"))).toBe(true)
    // The path still works afterwards.
    expect(service.dispatchPress({ accelerator: CANONICAL, id: 2 })).toBe(true)
  })

  test("reattaching a shell never double-delivers", async () => {
    const shell = fakeBridge()
    const service = makeShortcut()
    service.attachShell(shell.bridge)
    let runs = 0
    await service.register("Ctrl+Shift+K", () => {
      runs += 1
    })

    // A shell restart hands over a new bridge.
    const second = fakeBridge()
    service.attachShell(second.bridge)
    expect(shell.unsubscribed).toBe(1)

    second.deliver({ accelerator: CANONICAL, id: 1 })
    expect(runs).toBe(1)
    // The stale bridge is unsubscribed, so its presses go nowhere.
    shell.deliver({ accelerator: CANONICAL, id: 2 })
    expect(runs).toBe(1)
  })

  test("close() unsubscribes and stops delivering", async () => {
    const shell = fakeBridge()
    const service = makeShortcut()
    service.attachShell(shell.bridge)
    let runs = 0
    await service.register("Ctrl+Shift+K", () => {
      runs += 1
    })

    service.close()
    expect(shell.unsubscribed).toBe(1)
    expect(service.bound).toEqual([])
    expect(service.dispatchPress({ accelerator: CANONICAL, id: 1 })).toBe(false)
    expect(runs).toBe(0)
    // A closed service never pretends to register anything.
    expect(await service.register("Ctrl+Shift+K", () => {})).toEqual({ status: "no-shell" })
  })
})

describe("normalizePress", () => {
  test("accepts only a complete press payload", () => {
    expect(normalizePress({ accelerator: CANONICAL, id: 42 })).toEqual({
      accelerator: CANONICAL,
      id: 42,
    })
    expect(normalizePress({ accelerator: CANONICAL, id: 0 })).toEqual({
      accelerator: CANONICAL,
      id: 0,
    })
    expect(normalizePress({ accelerator: CANONICAL, id: 1.5 })).toBeUndefined()
    // The shell sends a u32: negative and non-finite ids are contract bugs.
    expect(normalizePress({ accelerator: CANONICAL, id: -1 })).toBeUndefined()
    expect(normalizePress({ accelerator: CANONICAL, id: Number.POSITIVE_INFINITY })).toBeUndefined()
    expect(normalizePress({ accelerator: CANONICAL, id: Number.NaN })).toBeUndefined()
    expect(normalizePress(undefined)).toBeUndefined()
    expect(normalizePress([])).toBeUndefined()
  })
})
