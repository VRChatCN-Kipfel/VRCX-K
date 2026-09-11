// M2-1 spike v3: implementation-shaping questions, after v2 established that
// only a `Service` subclass carries caller identity (a plain object does not).
//
//   D2. Does a plugin's `inject: { svc: <config> }` land in ctx[Context.intercept]?
//   H.  Can the SERVICE read that per-caller config? (the "provider defines the
//       policy" hook the upstream docs describe)
//   J.  Does `this[symbols.caller]` still resolve AFTER an await inside an async
//       method, or must the caller be captured synchronously at entry?
//   K.  Does a NESTED object property (e.g. ctx.shell.window.show()) carry caller?
//   L.  Can [symbols.filter] deny one caller and allow another?
//   M.  The recommended pattern: capture caller at entry, then await.

import { Context, Service, symbols } from "../../host/node_modules/cordis/lib/index.js"

const out: Record<string, unknown> = {}

function err(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

function callerName(self: any): string | null {
  return self?.[symbols.caller]?.fiber?.name ?? null
}

async function main() {
  // ─── D2 + H + J + M: Service with per-caller config, async caller capture ──
  {
    const ctx = new Context()

    class PolicyService extends Service {
      constructor(c: any) {
        super(c, "policySvc")
      }

      /** Per-caller config as the SERVICE sees it. */
      perCallerConfig() {
        const self: any = this
        const intercept = self?.ctx?.[Context.intercept]
        return {
          ctxFiberName: self?.ctx?.fiber?.name ?? null,
          interceptKeys: intercept ? Object.keys(intercept) : null,
          interceptOwn: intercept ? JSON.stringify(intercept.policySvc ?? null) : null,
          resolveConfig: (() => {
            try {
              return JSON.stringify(self[symbols.resolveConfig]?.() ?? null)
            } catch (e) {
              return `ERR ${err(e)}`
            }
          })(),
        }
      }

      /** Async: does the caller survive an await? */
      async asyncProbe() {
        const syncCaller = callerName(this)
        await new Promise((r) => setTimeout(r, 5))
        const lateCaller = callerName(this)
        return { syncCaller, lateCaller, survivedAwait: syncCaller === lateCaller }
      }

      /** The recommended pattern: capture at entry, then await. */
      async capturePattern() {
        const captured = callerName(this)
        await new Promise((r) => setTimeout(r, 5))
        return { captured, afterAwait: callerName(this) }
      }
    }
    new PolicyService(ctx)

    function pluginA(inner: any) {
      out.H_A_config = inner.policySvc.perCallerConfig()
      out.J_A_async = "pending"
      out.M_A_capture = "pending"
      inner.policySvc.asyncProbe().then((r: any) => (out.J_A_async = r))
      inner.policySvc.capturePattern().then((r: any) => (out.M_A_capture = r))
      out.D2_intercept = {
        keys: Object.keys(inner[Context.intercept] ?? {}),
        policySvc: JSON.stringify(inner[Context.intercept]?.policySvc ?? null),
        fiberInject: JSON.stringify(inner.fiber?.inject ?? null),
      }
    }
    ;(pluginA as any).inject = { policySvc: { mode: "A", limit: 3 } }

    function pluginB(inner: any) {
      out.H_B_config = inner.policySvc.perCallerConfig()
      inner.policySvc.asyncProbe().then((r: any) => (out.J_B_async = r))
      out.D2_intercept_B = {
        policySvc: JSON.stringify(inner[Context.intercept]?.policySvc ?? null),
      }
    }
    ;(pluginB as any).inject = { policySvc: { mode: "B" } }

    const fa = ctx.plugin(pluginA)
    const fb = ctx.plugin(pluginB)
    await fa
    await fb
    await new Promise((r) => setTimeout(r, 40))
  }

  // ─── K. nested object property on a Service: does it carry caller? ─────────
  {
    const ctx = new Context()

    class ShellLike extends Service {
      constructor(c: any) {
        super(c, "shellLike")
        // A nested namespace, like ctx.shell.window.*
        this.window = {
          show() {
            const self: any = this
            return {
              nestedThisCtor: self?.constructor?.name ?? null,
              hasCaller: self?.[symbols.caller] !== undefined,
              callerName: self?.[symbols.caller]?.fiber?.name ?? null,
            }
          },
        }
      }
      window: any
    }
    new ShellLike(ctx)

    await ctx.plugin(function nestedCallerPlugin(inner: any) {
      try {
        const r = inner.shellLike.window.show()
        r.hostPlugin = "nestedCallerPlugin"
        out.K_nested = r
      } catch (e) {
        out.K_nested_error = err(e)
      }
    })
  }

  // ─── L. [symbols.filter] can deny a caller ────────────────────────────────
  {
    const ctx = new Context()
    const seenFilters: string[] = []

    class GateService extends Service {
      constructor(c: any) {
        super(c, "gateSvc")
      }
      [symbols.filter](c: any) {
        seenFilters.push(c?.fiber?.name ?? "?")
        return c?.fiber?.name !== "deniedPlugin"
      }
      hello() {
        return `hello from ${callerName(this) ?? "?"}`
      }
    }
    new GateService(ctx)

    await ctx.plugin(function allowedPlugin(inner: any) {
      try {
        out.L_allowed = inner.gateSvc.hello()
      } catch (e) {
        out.L_allowed_error = err(e)
      }
    })

    await ctx.plugin(function deniedPlugin(inner: any) {
      try {
        out.L_denied = inner.gateSvc.hello()
      } catch (e) {
        out.L_denied_error = err(e)
      }
      try {
        out.L_denied_typeof = typeof inner.gateSvc
      } catch (e) {
        out.L_denied_typeof_error = err(e)
      }
    })

    out.L_filterCalls = seenFilters
  }

  console.log(JSON.stringify(out, (k, v) => (typeof v === "symbol" ? v.toString() : v), 2))
}

await main()
