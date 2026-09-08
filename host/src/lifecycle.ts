// Host graceful shutdown: reverse-order dispose of every Cordis fiber.
//
// Cordis tracks each plugin as a `Fiber` inside `ctx.registry` (per-runtime
// `fibers` list). A clean shutdown must dispose them in reverse load order —
// consumers first, services last — then let the root fiber's own disposables
// run (Loader/Include/heartbeat etc. registered via ctx.plugin()).
//
// The root fiber's `dispose()` is `() => this.restart()` (see cordis source),
// so we do NOT call it. Instead we dispose every child fiber explicitly and
// finally clear the root fiber's `_disposables` (its `clear()` returns the
// disposers in reverse order, each awaited).
//
// Loader write-suppression: Loader's `internal/plugin` handler flips an entry
// to `disabled: true` and writes it back to the config file whenever its fiber
// is disposed (unload == disable semantics). For a process-level shutdown we
// must NOT persist that — the next launch would silently drop the plugin. We
// pre-mark the entry `disabled` in memory before disposing so the handler's
// `if (fiber.entry.disabled) return` short-circuits the config write; the flag
// dies with the process.
//
// Graceful-stop contract (M1-3 issue #8):
//   - stop  -> dispose fibers -> exit 0
//   - hang  → caller (shell supervisor) force-kills after STOP_TIMEOUT
//   - logs  → every step goes to stderr, stdout stays clean for kkrpc/stdio
//
// Cooperative deadline:
//   A plugin that needs more time during cleanup can call
//   `ctx.signal.extend(ms)` inside its disposer.  Each call pushes the
//   deadline forward, up to the hard cap (`GRACEFUL_STOP_HARD_CAP_MS`).
//   The host stops awaiting disposers and schedules exit as soon as the
//   deadline expires or cleanup finishes, whichever comes first.  The
//   shell supervisor keeps a separate, longer force-kill deadline.

import type { Context } from "cordis"

// A cooperative host shutdown gets enough time for real plugin cleanup. The
// shell keeps a separate, longer 30s deadline and kills the process tree if
// this process itself becomes unresponsive.
export const GRACEFUL_STOP_TIMEOUT_MS = 10_000

// Hard cap — no amount of `extend()` calls can push the deadline beyond this
// from the moment the signal fires.  Must be less than the Rust shell's
// STOP_RPC_TIMEOUT (28s) to leave room for the RPC response.
export const GRACEFUL_STOP_HARD_CAP_MS = 25_000

/**
 * Dispose every fiber in reverse load order, then clear the root fiber's own
 * disposables. Resolves when cleanup finished; rejects nothing (errors are
 * logged, never fatal — the process still exits).
 */
export async function gracefulStop(ctx: Context): Promise<void> {
  const log = (line: string) => console.error("[host]", line)

  // 1. All plugin runtimes registered on this context.
  const runtimes = [...ctx.registry.values()]
  log(`graceful stop: disposing ${runtimes.length} runtime(s)`)

  for (const runtime of runtimes.reverse()) {
    const fibers = [...runtime.fibers]
    log(`  runtime ${runtime.name ?? "(unnamed)"}: ${fibers.length} fiber(s)`)
    for (const fiber of fibers.reverse()) {
      // Suppress Loader's config write-back (see module doc).
      const entry = (fiber as { entry?: { options?: { disabled?: boolean } } }).entry
      if (entry?.options) entry.options.disabled = true
      log(`    dispose fiber ${fiber.name}`)
      try {
        await fiber.dispose()
      } catch (err) {
        console.error("[host] fiber dispose error", err)
      }
    }
  }

  // 2. Root fiber's own disposables (Loader/Include/heartbeat effect cleanup).
  const root = ctx.fiber
  const disposers = root._disposables?.clear() ?? []
  log(`graceful stop: clearing ${disposers.length} root disposable(s)`)
  for (const dispose of disposers) {
    try {
      await dispose()
    } catch (err) {
      console.error("[host] root disposable error", err)
    }
  }
}

/**
 * Run `gracefulStop` with a cooperative deadline.  The `ctx.signal` is used
 * to track the deadline (which plugins can extend via `signal.extend(ms)`).
 * Once the deadline expires the function stops awaiting disposers and returns
 * — the caller should schedule process.exit().
 */
export async function gracefulStopWithTimeout(
  ctx: Context,
  reason: "stop" | "restart",
  initialMs = GRACEFUL_STOP_TIMEOUT_MS,
  hardCapMs = GRACEFUL_STOP_HARD_CAP_MS,
): Promise<void> {
  // Start the cooperative deadline clock.
  ctx.signal.begin(initialMs, hardCapMs, reason)

  const cleanup = gracefulStop(ctx)

  // A disposer belongs to third-party plugin code and cannot be safely
  // cancelled.  Once the deadline expires, stop awaiting it so the RPC handler
  // can schedule process.exit(); consume any eventual rejection instead.
  void cleanup.catch((err) => {
    console.error("[host] graceful cleanup completed with an error after timeout", err)
  })

  const outcome = await Promise.race([
    cleanup.then(() => "done" as const),
    ctx.signal.deadlinePromise!,
  ])

  if (outcome === "timeout") {
    console.error(`[host] graceful stop exceeded ${hardCapMs}ms hard cap; exiting anyway`)
  }
}