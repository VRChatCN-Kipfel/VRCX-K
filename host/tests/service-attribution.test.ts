// M2-1 regression: capability services must be cordis `Service` subclasses so a
// plugin calling `ctx.tray` / `ctx.shortcut` is attributable to that plugin.
//
// A plain `ctx.provide(name, obj)` loses the caller (docs/cordis-runtime-findings.md
// §1.2-1.3); only `Service` gets a per-caller traceable proxy. If someone
// downgrades one of these back to a plain object/class, the "fresh proxy" checks
// fail and the caller test reads `null`.
import { describe, expect, test } from "bun:test"
import { Context, Service } from "cordis"
import { TrayService } from "../src/tray"
import { ShortcutService } from "../src/shortcut"
import { callerName } from "../src/capability"
import type { TrayGroup } from "../src/tray-contract.generated"

const group = (id: string): TrayGroup => ({
  id,
  order: 0,
  label: null,
  visible: true,
  source: "host",
  items: [],
})

describe("M2-1 capability services are attributable", () => {
  test("ctx.tray is a Service (fresh traceable proxy per read)", () => {
    const ctx = new Context()
    new TrayService(ctx, {})
    expect(ctx.get("tray")).not.toBe(ctx.get("tray"))
  })

  test("ctx.shortcut is a Service (fresh traceable proxy per read)", () => {
    const ctx = new Context()
    new ShortcutService(ctx, {})
    expect(ctx.get("shortcut")).not.toBe(ctx.get("shortcut"))
  })

  test("a plain ctx.provide object is not traceable (control)", () => {
    const ctx = new Context()
    const plain = { hello: () => "hi" }
    ctx.provide("plainSvc", plain)
    expect(ctx.get("plainSvc")).toBe(plain)
  })

  test("a plugin's call into ctx.tray carries the calling fiber", async () => {
    const ctx = new Context()
    const seen: Array<string | null> = []
    class TracingTray extends TrayService {
      setGroups(groups: TrayGroup[]) {
        seen.push(callerName(this))
        return super.setGroups(groups)
      }
    }
    new TracingTray(ctx, {})
    await ctx.plugin(function probeTrayPlugin(inner: Context) {
      void inner.tray.setGroups([group("host.a")])
    })
    expect(seen).toEqual(["probeTrayPlugin"])
  })

  // The rest pin the exact pitfalls M2-1 must not regress into. Each fails if
  // someone "simplifies" a capability namespace back to an arrow function or a
  // plain object literal (docs/cordis-runtime-findings.md §1.2-1.3).
  test("on a real fiber, a plain provided object loses the caller (control)", async () => {
    const ctx = new Context()
    const seen: Array<string | null> = []
    const plain = {
      who(this: unknown) {
        seen.push(callerName(this))
        return "ok"
      },
    }
    ctx.provide("plainSvc", plain)
    await ctx.plugin(function plainCallerPlugin(inner: Context) {
      void (inner as unknown as { plainSvc: typeof plain }).plainSvc.who()
    })
    expect(seen).toEqual([null])
  })

  test("an arrow-function property silently loses attribution", async () => {
    const ctx = new Context()
    const seen: Array<string | null> = []
    class ArrowSvc extends Service {
      constructor(context: Context) {
        super(context, "arrowSvc")
        Object.defineProperty(this, "who", {
          configurable: true,
          value: () => {
            seen.push(callerName(this))
            return "ok"
          },
        })
      }
    }
    new ArrowSvc(ctx)
    await ctx.plugin(function arrowCallerPlugin(inner: Context) {
      void (inner as unknown as { arrowSvc: { who: () => string } }).arrowSvc.who()
    })
    expect(seen).toEqual([null])
  })

  test("a plain object namespace loses attribution", async () => {
    const ctx = new Context()
    const seen: Array<string | null> = []
    class NsSvc extends Service {
      constructor(context: Context) {
        super(context, "nsSvc")
        Object.defineProperty(this, "nested", {
          configurable: true,
          value: {
            who(this: unknown) {
              seen.push(callerName(this))
              return "ok"
            },
          },
        })
      }
    }
    new NsSvc(ctx)
    await ctx.plugin(function nsCallerPlugin(inner: Context) {
      void (inner as unknown as { nsSvc: { nested: { who: () => string } } }).nsSvc.nested.who()
    })
    expect(seen).toEqual([null])
  })

  test("a bare ctx.plugin without a loader Entry is still attributed by fiber name", async () => {
    const ctx = new Context()
    const seen: Array<string | null> = []
    class WhoSvc extends Service {
      who(): string | null {
        return callerName(this)
      }
    }
    new WhoSvc(ctx, "whoSvc")
    await ctx.plugin(function barePlugin(inner: Context) {
      seen.push((inner as unknown as { whoSvc: WhoSvc }).whoSvc.who())
    })
    expect(seen).toEqual(["barePlugin"])
  })

  test("callerName tolerates a missing this (destructured call)", () => {
    expect(callerName(undefined)).toBeNull()
  })
})
