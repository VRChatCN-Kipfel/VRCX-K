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
import { HOST_STDIO_LOST_EXIT } from "./api"
import type { ShutdownSignal } from "./signal"

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
 *
 * Since issue #11 the Include config is mounted as a loader-tree entry
 * (`cordis:include` builtin), so plugin fibers live in nested contexts inside
 * the loader tree rather than directly on the root registry. We therefore
 * first dispose every entry fiber across the loader tree (deepest/leaf
 * entries first, via reverse preorder of `ctx.loader.entries()`), then fall
 * back to the root registry loop for any remaining root-level plugins, then
 * clear the root disposables.
 */
export async function gracefulStop(ctx: Context): Promise<void> {
  const log = (line: string) => console.error("[host]", line)
  const loader = (ctx as Context & { loader?: { entries?(): Iterable<LoaderEntryLike> } }).loader

  // 1. Dispose every entry fiber in the loader tree (includes the include
  //    tree via recursion), leaves first.
  if (loader?.entries) {
    const entries = [...loader.entries()]
    log(`graceful stop: disposing ${entries.length} loader tree entr(ies)`)
    for (const entry of entries.reverse()) {
      const fiber = entry.fiber
      if (!fiber || fiber.uid === null) continue
      // Suppress Loader's config write-back (unload == disable).
      if (entry.options) entry.options.disabled = true
      log(`  dispose entry ${entry.id} (${entry.options.name ?? ""})`)
      try {
        await fiber.dispose()
      } catch (err) {
        console.error("[host] entry fiber dispose error", err)
      }
    }
  }

  // 2. All plugin runtimes registered directly on this context (legacy /
  //    non-loader-tree plugins; loader-tree fibers are already disposed).
  const runtimes = [...ctx.registry.values()]
  log(`graceful stop: disposing ${runtimes.length} root runtime(s)`)

  for (const runtime of runtimes.reverse()) {
    const fibers = [...runtime.fibers]
    log(`  runtime ${runtime.name ?? "(unnamed)"}: ${fibers.length} fiber(s)`)
    for (const fiber of fibers.reverse()) {
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

  // 3. Root fiber's own disposables (Loader/Include/heartbeat effect cleanup).
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

type LoaderEntryLike = {
  id: string
  fiber?: { uid: number | null; dispose(): Promise<void>; name: string } | null
  options?: { name?: string; disabled?: boolean }
}

/**
 * Run `gracefulStop` with a cooperative deadline.  The `ctx.signal` is used
 * to track the deadline (which plugins can extend via `signal.extend(ms)`).
 * Once the deadline expires the function stops awaiting disposers and returns
 * — the caller should schedule process.exit().
 *
 * The `ctx.signal.begin()` call doubles as the process-wide stopping gate:
 * the first caller acquires it and performs the cleanup; any concurrent
 * second call (stdio stop RPC vs dev-watch restart requester, or a repeated
 * RPC) sees `begin() === false` and returns immediately WITHOUT running
 * cleanup again.
 *
 * @returns `true` if this call performed the graceful stop (it owns the
 *          process exit); `false` if a shutdown was already in progress.
 */
export async function gracefulStopWithTimeout(
  ctx: Context,
  reason: "stop" | "restart",
  initialMs = GRACEFUL_STOP_TIMEOUT_MS,
  hardCapMs = GRACEFUL_STOP_HARD_CAP_MS,
): Promise<boolean> {
  // `ctx.signal` is declared via `declare module "cordis"`, which makes
  // TypeScript believe it is ALWAYS present. It is not: it is `provide`d during
  // bootstrap and then TORN DOWN by the first `gracefulStop`, because disposing
  // the root runtimes disposes the service that provides it. A SECOND stop
  // attempt — which `stopOnShellLost` introduced, and which any future second
  // caller would hit — therefore dereferenced `undefined` and crashed with
  // `TypeError: ctx.signal.begin` on a path that was already shutting down.
  //
  // Treat a missing signal as "a shutdown already owns this process": there is
  // nothing left to coordinate, and the caller must NOT schedule a competing
  // exit. This mirrors the `!acquired` branch below, which exists for exactly
  // the same reason.
  const signal: ShutdownSignal | undefined = ctx.signal
  if (!signal) {
    console.error(
      `[host] graceful stop requested (${reason}) after shutdown already tore down the signal — ignoring`,
    )
    return false
  }

  // Acquire the stopping gate. If another shutdown is already running (stop
  // RPC, restart RPC or the dev-watch restart requester), do nothing — the
  // first trigger owns cleanup and the process exit.
  const acquired = signal.begin(initialMs, hardCapMs, reason)
  if (!acquired) {
    console.error(
      `[host] graceful stop requested (${reason}) but a shutdown is already in progress — ignoring`,
    )
    return false
  }

  const cleanup = gracefulStop(ctx)

  // A disposer belongs to third-party plugin code and cannot be safely
  // cancelled.  Once the deadline expires, stop awaiting it so the RPC handler
  // can schedule process.exit(); consume any eventual rejection instead.
  void cleanup.catch((err) => {
    console.error("[host] graceful cleanup completed with an error after timeout", err)
  })

  // `begin()` returning true guarantees a deadline exists (`begin` assigns
  // `_deadline` before returning true), but the accessor still admits null, so
  // check instead of asserting. The `?? neverSettles` arm is unreachable in
  // practice; it exists so the race below cannot be handed a bare `null`.
  const deadline = signal.deadlinePromise
  const outcome = await Promise.race([
    cleanup.then(() => "done" as const),
    // Use the captured reference: `gracefulStop` above may already have torn
    // down the service, and re-reading `ctx.signal` here would dereference
    // `undefined` for the same reason guarded against at the top.
    deadline ?? new Promise<never>(() => {}),
  ])

  if (outcome === "timeout") {
    console.error(`[host] graceful stop exceeded ${hardCapMs}ms hard cap; exiting anyway`)
  }
  return true
}

/**
 * Stop the host because the far end of stdin is gone (issue #33): the shell
 * died (shell-attached runs) or the launcher went away (shell-less dev hosts).
 * EOF is observable only through the transport's own reader (stdio.ts) or the
 * dedicated stdin watch — `process.stdin`'s events never fire under the
 * transport's stream lock. Same stopping gate as the stop/restart RPCs, so a
 * concurrent trigger (stop RPC already in flight) can never double-run
 * cleanup or schedule a competing exit.
 */
export async function stopOnStdinLoss(ctx: Context, origin: "shell" | "launcher"): Promise<void> {
  console.error(`[host] stdin closed (${origin} is gone) — graceful shutdown`)
  const acquired = await gracefulStopWithTimeout(ctx, "stop")
  if (acquired) setTimeout(() => process.exit(0), 10)
}

/**
 * Stop the host because the shell became unreachable WHILE the startup handshake
 * was still in flight — the sending-side counterpart of `stopOnStdinLoss`.
 *
 * The teardown is the same graceful one; only the exit code differs, and that
 * difference is the point:
 *
 *   - NOT `0`: the handshake never completed, so the shell never learned our ws
 *     port and the app never started. Reporting a clean stop for a failed
 *     startup would be a lie — and it is the lie that made this case invisible.
 *   - NOT `1`: `classify_watch` reads every non-51 code as a crash and charges it
 *     to the restart-storm budget; eight of those inside the stable window park
 *     the host in `Failed`. The host did nothing wrong here, so it must not be
 *     billed for it.
 *
 * Hence `HOST_STDIO_LOST_EXIT`, which the shell maps to a distinct outcome that
 * relaunches without touching the storm counter.
 *
 * Same stopping gate as every other path, so if the read-side detector
 * (`onClose`) already claimed the exit this is a no-op and that path's code
 * stands — the first trigger owns the exit.
 */
export async function stopOnShellLost(ctx: Context): Promise<void> {
  console.error(
    "[host] shell went away during the ready handshake — graceful shutdown (stdio lost)",
  )
  const acquired = await gracefulStopWithTimeout(ctx, "stop")
  if (acquired) setTimeout(() => process.exit(HOST_STDIO_LOST_EXIT), 10)
}
