// Deep-link service tests (issue #41 gap ④).
//
// What is actually at stake: before this service existed, a URL that reached the host left
// NO trace anywhere — the shell's forwarding path had no consumer, so "the URL arrived" and
// "nothing happened" were the same observation. These tests pin both halves of the fix:
// parsing what the OS hands over, and making arrival visible even when nobody subscribed.

import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import { bindDeepLinkAdmin, hostWsAPI } from "../src/api"
import {
  attachDeepLinkShell,
  closeDeepLinkService,
  DeepLinkService,
  dispatchDeepLinkEvent,
  normalizeOpened,
  parseDeepLink,
  unregisterDeclaredScheme,
} from "../src/deeplink"
import type { DeepLinkEvent, DeepLinkUnregisterResult, ShellDeepLinkBridge } from "../src/stdio"

/** A bridge whose `unregister` answers whatever the case under test needs. */
function bridge(
  answer: DeepLinkUnregisterResult | (() => Promise<DeepLinkUnregisterResult>) = {
    ok: true,
    scheme: "vrcxk",
    removed: true,
  },
) {
  const events: DeepLinkEvent[] = []
  let handler: ((event: DeepLinkEvent) => void) | undefined
  const value: ShellDeepLinkBridge = {
    onOpen(next) {
      handler = next
      return () => {
        handler = undefined
      }
    },
    async unregister(_scheme: string) {
      return typeof answer === "function" ? answer() : answer
    },
  }
  return {
    bridge: value,
    /** Simulate the shell pushing a `deepLink.opened` notification. */
    emit(event: DeepLinkEvent) {
      events.push(event)
      handler?.(event)
    },
    get subscribed() {
      return handler !== undefined
    },
  }
}

function service(
  shell: ShellDeepLinkBridge | undefined,
  log?: (line: string) => void,
): DeepLinkService {
  const ctx = new Context()
  return new DeepLinkService(ctx, { bridge: shell, log: log ?? (() => {}) })
}

/**
 * ⚠ Review finding, pinned: `attachShell` runs inside the CONSTRUCTOR, and `fanout` hands a
 * RETAINED event to its first subscriber **synchronously** (`stdio.ts`) — which is exactly the
 * cold-start case retention was added for. With the log sink assigned after the subscription,
 * that handoff logged through `undefined` and threw, so the activation this whole PR exists to
 * save was the one it lost. The sink must be in place before anything can dispatch.
 */
test("a retained activation handed over during construction is logged, not thrown away", () => {
  const lines: string[] = []
  const retained: DeepLinkEvent = { urls: ["vrcxk://user/usr_1"] }
  const syncBridge: ShellDeepLinkBridge = {
    onOpen(next) {
      // Exactly what `fanout(..., { retainUntilSubscribed: true })` does for the first subscriber.
      next(retained)
      return () => {}
    },
  }
  const ctx = new Context()
  const deepLink = new DeepLinkService(ctx, {
    bridge: syncBridge,
    log: (line) => lines.push(line),
  })

  expect(
    lines.some((line) => line.includes("deepLink.opened vrcxk://user/usr_1")),
    `the retained activation must be logged during construction; got: ${JSON.stringify(lines)}`,
  ).toBe(true)
  // And the service is still usable afterwards (no half-constructed state).
  expect(dispatchDeepLinkEvent(deepLink, { urls: ["vrcxk://world/wrld_2"] })).toBe(1)
})

describe("parseDeepLink: the OS hands over a URL, not a structured command", () => {
  test("the authority form is verb/id", () => {
    const target = parseDeepLink("vrcxk://user/usr_1")
    expect(target).toEqual({
      scheme: "vrcxk",
      verb: "user",
      id: "usr_1",
      params: {},
      raw: "vrcxk://user/usr_1",
    })
  })

  test("the triple-slash form keeps verb/id in the path", () => {
    // `vrcxk:///user/usr_1` — a form people (and some link generators) really write.
    // Reading the authority here would yield verb "" and id "user", i.e. silently the
    // wrong command.
    const target = parseDeepLink("vrcxk:///world/wrld_9")
    expect(target?.verb).toBe("world")
    expect(target?.id).toBe("wrld_9")
  })

  test("query parameters are decoded, last one wins", () => {
    const target = parseDeepLink("vrcxk://join/wrld_9?ref=a&ref=b&x=1")
    expect(target?.params).toEqual({ ref: "b", x: "1" })
  })

  test("percent-encoded ids are decoded exactly once", () => {
    expect(parseDeepLink("vrcxk://avatar/avtr%20one")?.id).toBe("avtr one")
  })

  test("no verb and no id are empty strings, not errors", () => {
    const target = parseDeepLink("vrcxk://")
    expect(target?.verb).toBe("")
    expect(target?.id).toBe("")
  })

  test("the scheme is lowercased (URL schemes are case-insensitive)", () => {
    expect(parseDeepLink("VRCXK://user/usr_1")?.scheme).toBe("vrcxk")
  })

  test("something that is not a URL is refused rather than guessed at", () => {
    expect(parseDeepLink("not a url")).toBeUndefined()
    expect(parseDeepLink("")).toBeUndefined()
  })
})

describe("normalizeOpened: a malformed payload is reported, never guessed at", () => {
  test("accepts the shape the shell sends", () => {
    expect(normalizeOpened({ urls: ["vrcxk://user/usr_1"] })).toEqual({
      urls: ["vrcxk://user/usr_1"],
    })
  })

  test("refuses everything else", () => {
    for (const value of [
      undefined,
      null,
      "vrcxk://user/usr_1",
      {},
      { urls: [] },
      { urls: "vrcxk://user/usr_1" },
      { urls: [""] },
      { urls: [42] },
    ]) {
      expect(normalizeOpened(value), `${JSON.stringify(value)} must be refused`).toBeUndefined()
    }
  })
})

describe("dispatch: arrival must leave a trace even with no subscriber", () => {
  test("a URL with no subscriber is still logged", () => {
    // ⚠ THE POINT OF GAP ④. This is the assertion that would fail against the state the
    // repo was in before this service: a delivered activation and a link nobody clicked
    // produced byte-identical logs (i.e. nothing).
    const lines: string[] = []
    const deepLink = service(bridge().bridge, (line) => lines.push(line))
    expect(dispatchDeepLinkEvent(deepLink, { urls: ["vrcxk://user/usr_1"] })).toBe(1)
    expect(lines.some((line) => line.includes("deepLink.opened vrcxk://user/usr_1"))).toBe(true)
  })

  test("every subscriber sees every URL of a multi-URL activation", () => {
    const shell = bridge()
    const deepLink = service(shell.bridge)
    const seen: string[] = []
    deepLink.onUrl((target) => seen.push(`${target.verb}/${target.id}`))
    const delivered = dispatchDeepLinkEvent(deepLink, {
      urls: ["vrcxk://user/usr_1", "vrcxk://world/wrld_2"],
    })
    expect(delivered).toBe(2)
    expect(seen).toEqual(["user/usr_1", "world/wrld_2"])
  })

  test("unsubscribing stops delivery", () => {
    const shell = bridge()
    const deepLink = service(shell.bridge)
    let calls = 0
    const off = deepLink.onUrl(() => {
      calls += 1
    })
    dispatchDeepLinkEvent(deepLink, { urls: ["vrcxk://user/usr_1"] })
    off()
    expect(deepLink.subscriberCount).toBe(0)
    dispatchDeepLinkEvent(deepLink, { urls: ["vrcxk://user/usr_1"] })
    expect(calls).toBe(1)
  })

  test("a throwing handler does not stop the others", () => {
    const lines: string[] = []
    const deepLink = service(bridge().bridge, (line) => lines.push(line))
    let reached = 0
    deepLink.onUrl(() => {
      throw new Error("boom")
    })
    deepLink.onUrl(() => {
      reached += 1
    })
    expect(dispatchDeepLinkEvent(deepLink, { urls: ["vrcxk://user/usr_1"] })).toBe(1)
    expect(reached).toBe(1)
    expect(lines.some((line) => line.includes("deepLink handler error"))).toBe(true)
  })

  test("a malformed payload delivers nothing and says so", () => {
    const lines: string[] = []
    const deepLink = service(bridge().bridge, (line) => lines.push(line))
    expect(dispatchDeepLinkEvent(deepLink, { urls: "nope" })).toBe(0)
    expect(lines.some((line) => line.includes("invalid payload"))).toBe(true)
  })

  test("an unparseable URL is skipped without taking the activation down", () => {
    const lines: string[] = []
    const deepLink = service(bridge().bridge, (line) => lines.push(line))
    const delivered = dispatchDeepLinkEvent(deepLink, { urls: ["not a url", "vrcxk://user/usr_1"] })
    expect(delivered).toBe(1)
    expect(lines.some((line) => line.includes("unparseable URL"))).toBe(true)
  })

  /**
   * ⚠ Review finding, pinned — and the reason the test above is not enough. `"not a url"` is
   * rejected by `new URL`, which is a DIFFERENT path from a **malformed percent escape**: that
   * one gets through `new URL` and then made `decodeURIComponent` throw a `URIError`, which
   * escaped `dispatch` — taking down the whole activation (including any valid URL later in the
   * same batch) and leaving **nothing** in the log. So the assertion is not just "the bad one is
   * skipped": the good one must still be delivered in that same batch, and the arrival recorded.
   */
  test("a malformed percent escape does not take the rest of the batch with it", () => {
    const lines: string[] = []
    const seen: string[] = []
    const deepLink = service(bridge().bridge, (line) => lines.push(line))
    deepLink.onUrl((target) => seen.push(target.raw))

    const delivered = dispatchDeepLinkEvent(deepLink, {
      // "%E0%A4%A" is an incomplete UTF-8 sequence: `decodeURIComponent` throws on it.
      urls: ["vrcxk://user/%E0%A4%A", "vrcxk://user/usr_ok"],
    })

    expect(delivered, "the valid URL in the same batch must still be delivered").toBe(1)
    expect(seen).toEqual(["vrcxk://user/usr_ok"])
    expect(
      lines.some((line) => line.includes("unparseable URL")),
      `the malformed URL must be REPORTED (gap ④: an arrival always leaves a trace); got: ${JSON.stringify(lines)}`,
    ).toBe(true)
    expect(lines.some((line) => line.includes("deepLink.opened vrcxk://user/usr_ok"))).toBe(true)
  })

  test("a closed service ignores notifications instead of throwing", () => {
    const deepLink = service(bridge().bridge)
    closeDeepLinkService(deepLink)
    expect(dispatchDeepLinkEvent(deepLink, { urls: ["vrcxk://user/usr_1"] })).toBe(0)
  })

  test("re-attaching a new shell replaces the subscription instead of doubling it", () => {
    const first = bridge()
    const second = bridge()
    const deepLink = service(first.bridge)
    const seen: string[] = []
    deepLink.onUrl((target) => seen.push(target.raw))
    attachDeepLinkShell(deepLink, second.bridge)
    expect(first.subscribed).toBe(false)
    first.emit({ urls: ["vrcxk://user/stale"] })
    second.emit({ urls: ["vrcxk://user/fresh"] })
    expect(seen).toEqual(["vrcxk://user/fresh"])
  })
})

describe("unregisterDeclaredScheme: the undo the face may reach, and plugins may not", () => {
  test("missing or empty scheme is refused before any RPC", async () => {
    for (const value of [undefined, null, 42, ""]) {
      const result = await unregisterDeclaredScheme(bridge().bridge, value)
      expect(result.status).toBe("unsupported")
    }
  })

  test("no bridge at all reports no-shell (not a refusal)", async () => {
    expect(await unregisterDeclaredScheme(undefined, "vrcxk")).toEqual({ status: "no-shell" })
  })

  test("a shell that predates the route reports no-shell", async () => {
    // `unregister` is optional on the bridge: "this shell cannot undo it" is a different
    // answer from "the shell refused", and the face must be able to tell them apart.
    const older: ShellDeepLinkBridge = { onOpen: () => () => {} }
    expect(await unregisterDeclaredScheme(older, "vrcxk")).toEqual({ status: "no-shell" })
  })

  test("removed / absent are both successes, and they are distinguishable", async () => {
    expect(
      await unregisterDeclaredScheme(
        bridge({ ok: true, scheme: "vrcxk", removed: true }).bridge,
        "vrcxk",
      ),
    ).toEqual({ status: "removed" })
    // Asking twice is legitimate: nothing was registered, nothing went wrong.
    expect(
      await unregisterDeclaredScheme(bridge({ ok: true, scheme: "vrcxk" }).bridge, "vrcxk"),
    ).toEqual({ status: "absent" })
  })

  test("the shell's refusal is forwarded verbatim", async () => {
    const result = await unregisterDeclaredScheme(
      bridge({
        ok: false,
        scheme: "vrcxk",
        error: "refusing to overwrite it — an existing class key cannot be restored",
      }).bridge,
      "vrcxk",
    )
    expect(result.status).toBe("unsupported")
    expect(result.status === "unsupported" && result.error).toContain("cannot be restored")
  })

  test("a transport failure is not reported as a completed removal", async () => {
    const result = await unregisterDeclaredScheme(
      bridge(() => Promise.reject(new Error("pipe closed"))).bridge,
      "vrcxk",
    )
    expect(result.status).toBe("unsupported")
    expect(result.status === "unsupported" && result.error).toContain("pipe closed")
  })
})

describe("HostWsAPI.deepLink: the face's entry point, not a plugin capability", () => {
  test("with nothing bound it reports no-shell rather than pretending", async () => {
    bindDeepLinkAdmin(undefined)
    expect(await hostWsAPI.deepLink.unregister("vrcxk")).toEqual({ status: "no-shell" })
  })

  test("the bound handler receives the scheme and its outcome comes back", async () => {
    const calls: unknown[] = []
    bindDeepLinkAdmin({
      async unregister(scheme) {
        calls.push(scheme)
        return { status: "removed" }
      },
    })
    expect(await hostWsAPI.deepLink.unregister("vrcxk")).toEqual({ status: "removed" })
    expect(calls).toEqual(["vrcxk"])
    bindDeepLinkAdmin(undefined)
  })
})
