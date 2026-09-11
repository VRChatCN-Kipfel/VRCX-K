// M2-1 spike v4: the last implementation-shaping questions.
//
//   N. Does a NESTED Service instance carry caller? (decides whether the
//      namespaced `ctx.shell.window.show()` shape can be audited at all)
//   P. Arrow-function methods vs class methods: does attribution survive?
//   O. What is Service[symbols.filter] actually for? (v3 showed it is NOT an
//      access gate — it was never called on read)
//   Q. What caller identity can we actually extract, for a warn message?

import { Context, Service, symbols } from "../../host/node_modules/cordis/lib/index.js"

const out: Record<string, unknown> = {}

function err(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

function callerName(self: any): string | null {
  return self?.[symbols.caller]?.fiber?.name ?? null
}

/** Full identity dump of the calling context, as a warn line would need it. */
function callerIdentity(self: any): Record<string, unknown> {
  const c: any = self?.[symbols.caller]
  if (!c) return { present: false }
  return {
    present: true,
    isContext: Context.is(c),
    fiberName: c.fiber?.name ?? null,
    fiberUid: c.fiber?.uid ?? null,
    runtimeName: c.fiber?.runtime?.name ?? null,
    fiberState: c.fiber?.state ?? null,
  }
}

async function main() {
  // ─── N. nested Service instance as a property of another Service ──────────
  {
    const ctx = new Context()

    class WindowLike extends Service {
      constructor(c: any) {
        super(c, "windowLike")
      }
      show() {
        const self: any = this
        return {
          thisCtor: self?.constructor?.name ?? null,
          caller: callerName(self),
        }
      }
    }

    class ShellLike extends Service {
      window: any
      constructor(c: any) {
        super(c, "shellLike")
        // A nested SERVICE instance (has Symbol(cordis.tracker)), unlike v3's
        // plain object which lost attribution.
        this.window = new WindowLike(c)
      }
      notify() {
        return { thisCtor: (this as any)?.constructor?.name ?? null, caller: callerName(this) }
      }
    }
    new ShellLike(ctx)

    await ctx.plugin(function nestedSvcPlugin(inner: any) {
      try {
        out.N_flatMethod = inner.shellLike.notify()
      } catch (e) {
        out.N_flatMethod_error = err(e)
      }
      try {
        const r = inner.shellLike.window.show()
        r.hostPlugin = "nestedSvcPlugin"
        out.N_nestedService = r
      } catch (e) {
        out.N_nestedService_error = err(e)
      }
    })
  }

  // ─── P. arrow-function method: does attribution survive? ──────────────────
  {
    const ctx = new Context()

    class ArrowService extends Service {
      constructor(c: any) {
        super(c, "arrowSvc")
      }
      // Class method (baseline)
      method() {
        return { kind: "method", caller: callerName(this) }
      }
      // Arrow property: `this` is lexical (the construction-time instance)
      arrow = () => {
        return { kind: "arrow", caller: callerName(this) }
      }
    }
    new ArrowService(ctx)

    await ctx.plugin(function arrowPlugin(inner: any) {
      try {
        out.P_method = inner.arrowSvc.method()
      } catch (e) {
        out.P_method_error = err(e)
      }
      try {
        out.P_arrow = inner.arrowSvc.arrow()
      } catch (e) {
        out.P_arrow_error = err(e)
      }
    })
  }

  // ─── Q. caller identity available for a warn line ─────────────────────────
  {
    const ctx = new Context()

    class IdService extends Service {
      constructor(c: any) {
        super(c, "idSvc")
      }
      who() {
        return callerIdentity(this)
      }
    }
    new IdService(ctx)

    await ctx.plugin(function identifiedPlugin(inner: any) {
      out.Q_identity = inner.idSvc.who()
    })

    // Also: what does the SERVICE-side ctx look like (provider identity)?
    out.Q_providerCtx = {
      fiberName: (ctx as any).fiber?.name ?? null,
      hasFiber: !!(ctx as any).fiber,
    }
  }

  // ─── O. what is Service[symbols.filter] for? ──────────────────────────────
  {
    const ctx = new Context()
    const calls: string[] = []

    class FilterProbe extends Service {
      constructor(c: any) {
        super(c, "filterProbe")
      }
      [symbols.filter](c: any) {
        calls.push(`filter:${c?.fiber?.name ?? "?"}`)
        return true
      }
      hello() {
        return "hi"
      }
    }
    const inst = new FilterProbe(ctx)
    out.O_afterProvide = [...calls]

    await ctx.plugin(function filterPlugin(inner: any) {
      inner.filterProbe.hello()
      // Does emitting an event on the service scope invoke filter?
      try {
        inner.filterProbe.emit?.("probe-event", 1)
      } catch (e) {
        out.O_emit_error = err(e)
      }
    })

    await new Promise((r) => setTimeout(r, 10))
    out.O_calls = calls
    out.O_serviceHasEmit = typeof (inst as any).emit
  }

  console.log(JSON.stringify(out, (k, v) => (typeof v === "symbol" ? v.toString() : v), 2))
}

await main()
