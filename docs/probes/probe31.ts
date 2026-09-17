/**
 * How does a plugin actually read its OWN config?
 *
 * WHERE THIS CAME FROM
 *   Three earlier probes failed for the same mistaken assumption — that a plugin
 *   reads its config as `ctx.config`. That is wrong, and the failures produced
 *   misleading readings ("fiber FAILED", "inject gates service access") that had
 *   nothing to do with the mechanisms under test. This probe replaces the broken
 *   ones (probe25/27 deleted, probe31 rewritten) so that `docs/probes/` contains
 *   only measurements that hold up.
 *
 * THE CORRECT SHAPE, from the upstream source
 *   `@cordisjs/plugin-include` is a Service subclass and takes config as the
 *   CONSTRUCTOR'S SECOND ARGUMENT (lib/index.js:26-28):
 *       constructor(ctx, config) { super(ctx); this.config = config }
 *   For a plain functional plugin, the equivalent is the second parameter of
 *   `apply`: `export function apply(ctx, config) { ... }`.
 *
 * WHAT IS TESTED
 *   T1  `apply(ctx)` reading `ctx.config`        -> expect: does NOT work
 *   T2  `apply(ctx, config)` reading the 2nd arg -> expect: works, receives value
 *   T3  `ctx.plugin(p)` with no config           -> expect: 2nd arg is undefined/empty
 *   T4  Service subclass `this.config`           -> expect: works (the upstream shape)
 *
 * This matters beyond curiosity: our own plugins (`host/src/tray.ts`,
 * `shortcut.ts`) are Service subclasses and correctly never touch `ctx.config`,
 * and the #19 plugin template must use the 2nd-argument form. Getting this wrong
 * makes a plugin fail with a confusing "cannot get property" error.
 *
 * Run: bun run docs/probes/probe31.ts
 */
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import { Service } from "../../host/node_modules/cordis/lib/index.js"

const out: Record<string, unknown> = {}
const settle = () => new Promise((r) => setTimeout(r, 150))

/** FIBER_ACTIVE = 2 (host/src/fiber.ts). */
const ACTIVE = 2

// ── T1: reading ctx.config from a plain functional plugin ─────────────────
{
  const ctx = new Context()
  let read: string
  try {
    read = JSON.stringify(ctx.config)
  } catch (error) {
    read = `THREW: ${(error as Error).message}`
  }
  const fiber = ctx.plugin({ name: "t1", apply: () => {} }, { hello: "world" })
  await settle()
  // Probe the property from a plugin body, where the gate actually applies.
  let fromBody: string
  const ctx2 = new Context()
  const f2 = ctx2.plugin(
    {
      name: "t1b",
      apply(c: Context) {
        try {
          fromBody = JSON.stringify((c as unknown as { config?: unknown }).config)
        } catch (error) {
          fromBody = `THREW: ${(error as Error).message}`
        }
      },
    },
    { hello: "world" },
  )
  await settle()
  out.T1_ctxConfig = { outerRead: read, fromPluginBody: fromBody!, fiberState: f2.state, expectedActive: ACTIVE }
  void fiber
}

// ── T2: the second parameter of apply ────────────────────────────────────
{
  const ctx = new Context()
  let seen: unknown = "not-run"
  const fiber = ctx.plugin(
    {
      name: "t2",
      apply: (_c: Context, config: unknown) => {
        seen = config
      },
    },
    { hello: "world" },
  )
  await settle()
  out.T2_secondArg = { received: seen, fiberState: fiber.state, expectedActive: ACTIVE }
}

// ── T3: no config passed ─────────────────────────────────────────────────
{
  const ctx = new Context()
  let seen: unknown = "not-run"
  const fiber = ctx.plugin({
    name: "t3",
    apply: (_c: Context, config: unknown) => {
      seen = config
    },
  })
  await settle()
  out.T3_noConfig = { received: seen, fiberState: fiber.state }
}

// ── T4: the Service-subclass shape used by upstream and by our own services ─
{
  const ctx = new Context()
  let captured: unknown = "not-run"
  class Probe extends Service {
    constructor(c: Context, config: { tag?: string }) {
      super(c, "probe31")
      captured = config
    }
  }
  ;(ctx as unknown as { plugin(p: unknown, c?: unknown): { state?: number } }).plugin(Probe, { tag: "svc" })
  await settle()
  out.T4_serviceSubclass = { received: captured }
}

console.log(JSON.stringify(out, null, 2))

console.log("\n=== VERDICT ===")
const t1 = out.T1_ctxConfig as { outerRead: string; fromPluginBody: string }
const t2 = out.T2_secondArg as { received: unknown; fiberState?: number }
const t3 = out.T3_noConfig as { received: unknown }
const t4 = out.T4_serviceSubclass as { received: unknown }

console.log(`  T1 ctx.config from a plugin body : ${t1.fromPluginBody}`)
console.log(`  T2 apply(ctx, config)            : ${JSON.stringify(t2.received)}`)
console.log(`  T3 apply(ctx) with no config     : ${JSON.stringify(t3.received)}`)
console.log(`  T4 Service subclass this.config  : ${JSON.stringify(t4.received)}`)
console.log("")
console.log("  => config arrives as the 2nd parameter, NOT as ctx.config:",
  t2.received !== "not-run" && (t1.fromPluginBody.startsWith("THREW") || t1.fromPluginBody === "undefined"))
