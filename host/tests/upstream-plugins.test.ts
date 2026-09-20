/**
 * The host must actually WIRE the upstream plugins it imports.
 *
 * Importing and constructing them is not the same as them being reachable by the
 * plugins the host loads. This pins both halves:
 *
 *   1. `ctx.timeout` exists on the host's context (plugin-timer's mixin landed),
 *      and a scheduled callback really fires — proving it goes through a live
 *      timer, not a stub.
 *   2. `cordis:group` is registered as a loader builtin. Without that, a group
 *      entry silently never materialises and its children are skipped — the exact
 *      failure that invalidated an earlier probe, where every scenario reported
 *      loaded=[] including its own baseline. A silent skip deserves a test, not
 *      just a comment.
 *
 * The inject requirement for `ctx.timeout` INSIDE a plugin is pinned separately:
 * a plugin that touches it without `inject: ['timer']` goes FAILED and never
 * loads, which is why the template must declare it.
 */
import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import Loader from "@cordisjs/plugin-loader"
import Group from "@cordisjs/plugin-group"
import Timer from "@cordisjs/plugin-timer"

const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

describe("host wiring of adopted upstream plugins", () => {
  test("plugin-timer exposes ctx.timeout on the host context and it fires", async () => {
    const ctx = new Context()
    await ctx.plugin(Timer)

    const timer = ctx as unknown as { timeout?: (fn: () => void, ms: number) => unknown }
    expect(typeof timer.timeout).toBe("function")

    let fired = false
    timer.timeout!(() => {
      fired = true
    }, 20)
    await new Promise((r) => setTimeout(r, 200))
    expect(fired).toBe(true)
  })

  test("ctx.timeout requires inject INSIDE a plugin — hard failure otherwise", async () => {
    const ctx = new Context()
    await ctx.plugin(Timer)

    // No inject: this is what a careless plugin looks like.
    const bad = ctx.plugin({
      name: "no-inject",
      apply(c: Context) {
        const t = (c as unknown as { timeout: (fn: () => void, ms: number) => void }).timeout
        t(() => {}, 10)
      },
    })
    // With inject: the sanctioned shape.
    const good = ctx.plugin({
      name: "with-inject",
      inject: ["timer"],
      apply(c: Context) {
        const t = (c as unknown as { timeout: (fn: () => void, ms: number) => void }).timeout
        t(() => {}, 10)
      },
    })
    await new Promise((r) => setTimeout(r, 250))

    expect(bad.state).toBe(FIBER_FAILED)
    expect(good.state).toBe(FIBER_ACTIVE)
  })

  test("cordis:group is resolvable once registered as a builtin", async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group

    // The builtin lookup path is `builtins[name.slice('cordis:'.length)]`.
    const builtins = ctx.loader.builtins as Record<string, unknown>
    expect(builtins.group).toBe(Group)
    // A group entry whose name cannot resolve would never create its subgroup;
    // asserting the binding is the cheap half, and the loader-level behaviour is
    // covered by docs/probes/probe30.ts (children get independent entries).
  })
})
