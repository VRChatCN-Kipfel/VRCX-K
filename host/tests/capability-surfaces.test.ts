/**
 * Pin the capability INVENTORY against the RUNNING host.
 *
 * `capabilityInventory.ts` is only a single source of truth if something fails
 * when it disagrees with reality. Otherwise it is just a third hand-written copy
 * of the same list, with better intentions.
 *
 * This boots the real services the way `host/src/index.ts` does and asserts every
 * declared service is actually retrievable from the context. If someone renames
 * or drops a service, the inventory stops matching and this fails — rather than a
 * plugin later discovering that a capability it declared cannot be resolved.
 */
import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import { createShellCapabilities, ShellHandle } from "../src/capability"
import { TrayService } from "../src/tray"
import { ShortcutService } from "../src/shortcut"
import { ShutdownSignal } from "../src/signal"
import {
  HOST_SERVICES,
  REQUESTABLE_CAPABILITIES,
  SHELL_SUBDOMAINS,
} from "../src/contracts/capabilityInventory"

/** Build a context carrying exactly the services the host provides at boot. */
function bootServices(): Context {
  const ctx = new Context()
  // Mirrors host/src/index.ts: provide the shutdown signal, construct the two
  // Service subclasses, then register the capability surface.
  ctx.provide("signal", new ShutdownSignal())
  new TrayService(ctx, { log: () => {} })
  new ShortcutService(ctx, { log: () => {} })
  createShellCapabilities(ctx, new ShellHandle(() => {}))
  return ctx
}

describe("declared capabilities really exist at runtime", () => {
  test("every HOST_SERVICE is resolvable from the context", () => {
    const ctx = bootServices()
    for (const name of HOST_SERVICES) {
      expect(ctx.get(name), `service "${name}" is declared but not provided`).toBeTruthy()
    }
  })

  test("every REQUESTABLE_CAPABILITY is a HOST_SERVICE and is resolvable", () => {
    const ctx = bootServices()
    for (const name of REQUESTABLE_CAPABILITIES) {
      expect(HOST_SERVICES as readonly string[]).toContain(name)
      expect(ctx.get(name), `capability "${name}" cannot be requested: not provided`).toBeTruthy()
    }
  })

  test("the raw ctx.shell mirror exposes exactly the declared sub-domains", () => {
    const ctx = bootServices()
    const shell = ctx.get("shell") as unknown as Record<string, unknown>
    // `Service` adds own `ctx`/`name`; every other own key is a mirror entry.
    const keys = Object.getOwnPropertyNames(shell)
      .filter((key) => key !== "ctx" && key !== "name")
      .sort()
    expect(keys).toEqual([...SHELL_SUBDOMAINS].sort())
  })
})
