// Does SIGTERM actually skip the cordis dispose chain?
//
// #27's acceptance is "data is persisted when the host exits gracefully". The
// host has TWO exit paths and they are not equivalent:
//
//   stdin loss / stdio "stop" RPC  →  stopOnStdinLoss → gracefulStopWithTimeout
//                                     → ctx.signal.begin() → disposers run
//   SIGTERM / SIGINT               →  process.exit(0)   ← index.ts:306
//
// If the second one really bypasses dispose, then a data engine that only writes
// in its disposer WILL LOSE DATA whenever the process is terminated by signal —
// which is exactly how a supervisor stops a child on Unix, and how Ctrl-C stops a
// dev host. The failure is silent and only shows up as missing rows after a crash.
//
// Run: bun run docs/probes/probe22.ts
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"

const evidence: Record<string, unknown> = {}

// A context shaped like the host's. The effect is registered INSIDE A PLUGIN
// FIBER, which probe23 established is the only place it is reachable from
// `gracefulStop` — an effect on the bare root context lands in no runtime at all
// and is silently never disposed.
function makeCtx(log: string[]): Context {
  const ctx = new Context()
  ctx.provide("signal", {
    stopping: false,
    remaining: Number.POSITIVE_INFINITY,
    begin: () => true,
    extend: () => {},
  })
  return ctx
}

/** Register the disposer the way a real plugin does: inside a fiber. */
async function applyProbePlugin(ctx: Context, log: string[]): Promise<void> {
  await ctx.plugin({
    name: "probe22-plugin",
    apply(c: Context) {
      c.effect(() => {
        log.push("disposer-registered")
        return () => {
          log.push("DISPOSER-RAN")
        }
      })
    },
  })
}

// ── Path A: the graceful path (what stopOnStdinLoss does) ────────────────
//
// `gracefulStop` disposes root runtimes' fibers directly (lifecycle.ts:84-98),
// so that is what a data engine's disposer would be reached through.
{
  const log: string[] = []
  const ctx = makeCtx(log)
  await ctx.plugin(Loader)
  await applyProbePlugin(ctx, log)
  for (const runtime of [...ctx.registry.values()].reverse()) {
    for (const fiber of [...runtime.fibers].reverse()) {
      await fiber.dispose()
    }
  }
  evidence.gracefulStop = { log, disposerRan: log.includes("DISPOSER-RAN") }
}

// ── Path B: what a SIGTERM handler in this process would do ──────────────
// We cannot send ourselves a real SIGTERM and survive to report, so we run the
// child and observe from outside.
if (!process.env.VRCXK_PROBE22_CHILD) {
  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: { ...process.env, VRCXK_PROBE22_CHILD: "1" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })

  const out = new Response(child.stdout).text()
  await new Promise((r) => setTimeout(r, 600))

  // SIGTERM — on Windows this is not delivered, so the probe reports that
  // explicitly rather than pretending the test ran.
  let delivered = true
  try {
    child.kill("SIGTERM")
  } catch {
    delivered = false
  }

  const code = await child.exited
  const text = await out

  evidence.sigterm = {
    delivered,
    exitCode: code,
    childSawDisposer: text.includes("DISPOSER-RAN"),
    childOutput: text.trim().split("\n").filter(Boolean),
  }
} else {
  // Child: register a disposer INSIDE a plugin fiber, install a SIGTERM handler
  // shaped like index.ts's, then wait to be killed.
  const log: string[] = []
  const ctx = makeCtx(log)
  await ctx.plugin(Loader)
  await applyProbePlugin(ctx, log)
  process.on("SIGTERM", () => {
    process.exit(0) // index.ts:310 — does this skip the disposer?
  })
  process.on("SIGINT", () => process.exit(0))
  console.log("child-ready")
  await new Promise((resolve) => setTimeout(resolve, 5_000))
}

console.log(JSON.stringify(evidence, null, 2))
console.log(
  "\nverdict: SIGTERM " +
    (evidence.sigterm && (evidence.sigterm as { childSawDisposer: boolean }).childSawDisposer
      ? "DOES run disposers"
      : "does NOT run disposers (data written only in a disposer would be LOST)"),
)
