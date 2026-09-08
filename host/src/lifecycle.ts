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
//   - hang  -> caller (shell supervisor) force-kills after STOP_TIMEOUT
//   - logs  -> every step goes to stderr, stdout stays clean for kkrpc/stdio

import type { Context } from "cordis"

export const GRACEFUL_STOP_TIMEOUT_MS = 2000

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
      // `entry.disabled` is a read-only getter over the options chain; the
      // Loader write handler checks `fiber.entry.disabled`, so setting the
      // own `options.disabled` short-circuits it before the config write.
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
 * Run `gracefulStop` with a hard timeout. If fibers hang, the process exits
 * anyway — the shell supervisor's own STOP_TIMEOUT force-kill is the final
 * backstop, but we avoid lingering here too.
 */
export async function gracefulStopWithTimeout(ctx: Context): Promise<void> {
  const timer = setTimeout(() => {
    console.error(
      `[host] graceful stop exceeded ${GRACEFUL_STOP_TIMEOUT_MS}ms, exiting anyway`,
    )
  }, GRACEFUL_STOP_TIMEOUT_MS)
  timer.unref?.()
  await gracefulStop(ctx)
  clearTimeout(timer)
}
