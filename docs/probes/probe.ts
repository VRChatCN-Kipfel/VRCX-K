// M2-1 spike (v2, awaits fibers): how does a plugin-visible capability service
// learn WHO called it?
//
// v1 failed because ctx.plugin() is async: every plugin was still LOADING
// (state 1) when the report printed. This version awaits each fiber.

import { Context, Service, symbols } from "../../host/node_modules/cordis/lib/index.js"

const out: Record<string, unknown> = {}
const STATE = ["PENDING", "LOADING", "ACTIVE", "FAILED", "DISPOSED", "UNLOADING"]

function err(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

function symbolKeys(v: unknown): string[] {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return []
  return Reflect.ownKeys(v as object).map((k) => (typeof k === "symbol" ? k.toString() : String(k)))
}

function stateOf(fiber: any): string {
  try {
    return `${fiber?.state}(${STATE[fiber?.state] ?? "?"})`
  } catch (e) {
    return `err:${err(e)}`
  }
}

/** Everything we might learn about a method's `this`. */
function describeThis(self: any, target: unknown, hostPlugin: string): Record<string, unknown> {
  const info: Record<string, unknown> = {
    hostPlugin,
    thisIsTarget: self === target,
    thisIsContext: Context.is(self),
    thisCtor: self?.constructor?.name ?? null,
    thisSymbols: symbolKeys(self).slice(0, 20),
    hasShadow: self?.[symbols.shadow] !== undefined,
    hasCaller: self?.[symbols.caller] !== undefined,
  }
  const shadow = self?.[symbols.shadow]
  const caller = self?.[symbols.caller]
  info.shadowName = shadow?.fiber?.name ?? null
  info.callerName = caller?.fiber?.name ?? null
  // What we actually need: the name of the plugin that made the call.
  info.callerResolved = caller?.fiber?.runtime?.name ?? shadow?.fiber?.runtime?.name ?? null
  return info
}

async function main() {
  // ─── A. public exports ────────────────────────────────────────────────────
  out.A = {
    symbolsKeys: Object.keys(symbols),
    caller: typeof symbols.caller,
    shadow: typeof symbols.shadow,
    ContextIntercept: typeof Context.intercept,
    Service: typeof Service,
  }

  // ─── B. PLAIN OBJECT provided via ctx.provide ─────────────────────────────
  {
    const ctx = new Context()
    const plain: any = {
      probe() {
        return describeThis(this, plain, "?")
      },
    }
    ctx.provide("plain", plain)

    await ctx.plugin(function pluginA(inner: any) {
      try {
        out.B_readIdentity = {
          readIsSameObject: inner.plain === plain,
          readSymbols: symbolKeys(inner.plain).slice(0, 20),
          readCallerName: inner.plain[symbols.caller]?.fiber?.name ?? null,
        }
        const r = inner.plain.probe()
        r.hostPlugin = "pluginA"
        out.B_call_from_A = r
      } catch (e) {
        out.B_call_from_A_error = err(e)
      }
    })

    await ctx.plugin(function pluginB(inner: any) {
      try {
        const r = inner.plain.probe()
        r.hostPlugin = "pluginB"
        out.B_call_from_B = r
      } catch (e) {
        out.B_call_from_B_error = err(e)
      }
    })
  }

  // ─── C. SERVICE subclass: per-caller materialization + caller identity ─────
  {
    const ctx = new Context()
    const seen: any[] = []

    class ProbeService extends Service {
      constructor(c: any) {
        super(c, "probeSvc")
      }
      who() {
        const self: any = this
        seen.push(self)
        const info = describeThis(self, undefined, "?")
        info.ctxFiberName = self?.ctx?.fiber?.name ?? null
        return info
      }
    }
    new ProbeService(ctx)

    const readA = (ctx as any).probeSvc
    const readA2 = (ctx as any).probeSvc
    out.C_readIdentical = readA === readA2
    out.C_readSymbols = symbolKeys(readA).slice(0, 20)
    out.C_readCaller = readA[symbols.caller]?.fiber?.name ?? null

    await ctx.plugin(function svcPluginA(inner: any) {
      try {
        out.C_inPlugin_sameAsHostRead = (inner as any).probeSvc === readA
        const r = (inner as any).probeSvc.who()
        r.hostPlugin = "svcPluginA"
        out.C_who_from_A = r
      } catch (e) {
        out.C_who_from_A_error = err(e)
      }
    })

    await ctx.plugin(function svcPluginB(inner: any) {
      try {
        const r = (inner as any).probeSvc.who()
        r.hostPlugin = "svcPluginB"
        out.C_who_from_B = r
      } catch (e) {
        out.C_who_from_B_error = err(e)
      }
    })

    out.C_distinctSelfInstances = new Set(seen).size
    out.C_sameInstanceAcrossCallers = seen.length >= 2 ? seen[0] === seen[1] : null
  }

  // ─── D. inject config → ctx[Context.intercept] (per-caller policy hook) ────
  {
    const ctx = new Context()
    ctx.provide("tagged", { tag: () => "svc" })

    await ctx.plugin(
      function taggedPlugin(inner: any) {
        try {
          const intercept = inner[Context.intercept]
          out.D = {
            interceptPresent: intercept !== undefined,
            interceptKeys: intercept ? Object.keys(intercept) : [],
            interceptTagged: intercept ? JSON.stringify(intercept.tagged) : null,
            fiberInject: JSON.stringify(inner.fiber?.inject ?? null),
          }
        } catch (e) {
          out.D_error = err(e)
        }
      },
      { mode: "A", limit: 3 },
    )
  }

  // ─── E. is inject a GATE? (plugin without inject reads the service) ────────
  {
    const ctx = new Context()
    ctx.provide("present", { hello: () => "hi" })
    await ctx.plugin(function noInjectPlugin(inner: any) {
      try {
        out.E = {
          readWithoutInject: inner.present.hello(),
          getWithoutInject: typeof inner.get("present"),
        }
      } catch (e) {
        out.E_error = err(e)
      }
    })
  }

  // ─── F. inject gating: PENDING until provide, then starts ─────────────────
  {
    const ctx = new Context()
    let started = 0
    function needsNotify(inner: any) {
      started += 1
      out.F_startedSeesNotify = typeof inner.notify
    }
    ;(needsNotify as any).inject = ["notify"]
    const fiber: any = ctx.plugin(needsNotify)
    out.F_beforeProvide = { started, state: stateOf(fiber) }

    ctx.provide("notify", { notify: () => true })
    await new Promise((r) => setTimeout(r, 20))
    out.F_afterProvide = { started, state: stateOf(fiber) }
  }

  // ─── G. reflect.bind / reflect.trace caller identity ──────────────────────
  {
    const ctx = new Context()
    out.G_api = {
      bind: typeof ctx.reflect?.bind,
      trace: typeof (ctx.reflect as any)?.trace,
    }
    const bound: any = ctx.reflect.bind(function boundFn() {
      const self: any = this
      return {
        thisIsContext: Context.is(self),
        thisSymbols: symbolKeys(self).slice(0, 20),
        callerName: self?.[symbols.caller]?.fiber?.name ?? null,
        shadowName: self?.[symbols.shadow]?.fiber?.name ?? null,
      }
    })
    await ctx.plugin(function boundPlugin(inner: any) {
      try {
        out.G_call_from_plugin = bound()
      } catch (e) {
        out.G_call_error = err(e)
      }
    })
  }

  console.log(JSON.stringify(out, (k, v) => (typeof v === "symbol" ? v.toString() : v), 2))
}

await main()
