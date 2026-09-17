// Where does a `ctx.effect()` disposer actually live, and who reaches it?
//
// probe22 showed the graceful path (lifecycle.ts:84-98, iterating
// ctx.registry → runtime.fibers → fiber.dispose) did NOT run a disposer
// registered with a bare `ctx.effect(...)` on the root context.
//
// Two possibilities, and they matter very differently:
//   (a) the probe registered its effect in a way real plugins never do, or
//   (b) `gracefulStop` misses disposers registered directly on the root context,
//       which would mean a data engine writing in its disposer can lose data
//       even on the CLEAN path.
//
// Run: bun run docs/probes/probe23.ts
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"

const out: Record<string, unknown> = {}

// ── Case 1: bare ctx.effect on the root context ──────────────────────────
{
  const log: string[] = []
  const ctx = new Context()
  ctx.effect(() => () => log.push("root-effect-ran"))
  const runtimes = [...ctx.registry.values()]
  out.rootEffect = {
    registrySize: runtimes.length,
    fiberCounts: runtimes.map((r) => [...r.fibers].length),
    ranAfterDispose: false as boolean,
  }
  for (const runtime of [...runtimes].reverse()) {
    for (const fiber of [...runtime.fibers].reverse()) await fiber.dispose()
  }
  out.rootEffect.ranAfterDispose = log.includes("root-effect-ran")
}

// ── Case 2: a plugin fiber (how real plugins are shaped) ─────────────────
{
  const log: string[] = []
  const ctx = new Context()
  await ctx.plugin(Loader)
  const plugin = {
    name: "probe23-plugin",
    apply(c: Context) {
      c.effect(() => () => log.push("plugin-effect-ran"))
    },
  }
  await ctx.plugin(plugin)

  const entries = [...ctx.registry.values()]
  out.pluginEffect = {
    registrySize: entries.length,
    fiberCounts: entries.map((r) => [...r.fibers].length),
    ranAfterDispose: false as boolean,
  }
  for (const runtime of [...entries].reverse()) {
    for (const fiber of [...runtime.fibers].reverse()) await fiber.dispose()
  }
  out.pluginEffect.ranAfterDispose = log.includes("plugin-effect-ran")
}

// ── Case 3: is there a context-level dispose that covers everything? ─────
{
  const log: string[] = []
  const ctx = new Context()
  ctx.effect(() => () => log.push("root-effect-ran"))
  // cordis exposes teardown through the root fiber / registry disposal rather
  // than a ctx.stop(); try the documented-ish routes and record what exists.
  const anyCtx = ctx as unknown as Record<string, unknown>
  out.availableRoutes = ["stop", "dispose", "start", "scope"].filter((k) => typeof anyCtx[k] === "function")
  await ctx.root?.dispose?.()
  out.rootDisposeRanEffect = log.includes("root-effect-ran")
}

console.log(JSON.stringify(out, null, 2))
