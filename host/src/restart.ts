// Whole-host restart requester for dev-watch `restart-required` outcomes
// (issue #11 wiring; separated from index.ts so it can be unit-tested without
// executing the host entry script).
//
// Restart storms are capped on the Rust side (#7 stable-window logic), but we
// still rate-limit per entry here (60s) and add a grace period after startup
// so an early dev error does not immediately burn a restart. When a shell is
// attached we reuse the existing exit-51 path (graceful stop, then 51); the
// shell supervisor owns the actual restart — we never spawn or supervise.

import { HOST_RESTART_EXIT } from "./api"
import { gracefulStopWithTimeout } from "./lifecycle"
import type { Context } from "cordis"

/** How long a dev `restart-required` outcome is suppressed after boot. */
export const RESTART_GRACE_MS = 10_000
/** Per-entry minimum interval between accepted restart requests. */
export const RESTART_RATE_LIMIT_MS = 60_000

export type RestartRequester = (info: { entryId: string; error?: unknown }) => void

export type RestartRequesterOptions = {
  shellAttached: boolean
  now?: () => number
  exitProcess?: (code: number) => void
  /** Injectable graceful teardown (tests pass a fake; default is the real host stop). */
  gracefulStop?: (reason: "stop" | "restart") => Promise<void>
}

export function makeRestartRequester(ctx: Context, options: RestartRequesterOptions): RestartRequester {
  const shellAttached = options.shellAttached
  const now = options.now ?? Date.now
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code))
  const gracefulStop = options.gracefulStop ?? ((reason: "stop" | "restart") => gracefulStopWithTimeout(ctx, reason))
  const lastRequest = new Map<string, number>()
  const startedAt = now()
  let restarting = false

  return (info: { entryId: string; error?: unknown }) => {
    const current = now()
    // First request for an entry has no previous timestamp — treat it as
    // "long ago" so the rate-limit arm never suppresses a first request
    // (a bare 0 would suppress everything until the clock passes 60s).
    const last = lastRequest.get(info.entryId) ?? Number.NEGATIVE_INFINITY
    const reason = info.error instanceof Error ? info.error.message : info.error === undefined ? "unknown error" : String(info.error)
    const log = (line: string) => console.error("[host]", line)
    if (current - last < RESTART_RATE_LIMIT_MS || current - startedAt < RESTART_GRACE_MS) {
      log(`dev restart-required ${info.entryId} suppressed (rate limit / startup grace): ${reason}`)
      return
    }
    lastRequest.set(info.entryId, current)
    log(`dev restart-required ${info.entryId}: ${reason}`)
    if (!shellAttached) {
      // No shell: the exit-51 path is unavailable. Never swallow silently —
      // log clearly; the watcher stays up and keeps serving.
      log(`dev restart-required ${info.entryId} not actioned (no shell attached)`)
      return
    }
    if (restarting) {
      log(`dev restart-required ${info.entryId} ignored (restart already in progress)`)
      return
    }
    restarting = true
    log("requesting host restart (exit 51)")
    void gracefulStop("restart").finally(() => {
      setTimeout(() => {
        exitProcess(HOST_RESTART_EXIT)
        // In the real host this line never runs (the process is gone). In
        // tests (or if the exit is deferred/fails) it lets a later
        // restart-required be evaluated again instead of latching forever.
        restarting = false
      }, 10)
    })
  }
}
