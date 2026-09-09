// Shutdown signal — a Cordis service that any plugin can inject to
// participate in graceful shutdown cooperatively.
//
// Usage from a plugin:
//
//   export function apply(ctx: Context) {
//     ctx.effect(() => () => {
//       // ... begin cleanup ...
//       ctx.signal?.extend(5000)  // "I need 5 more seconds"
//       // ... continue cleanup ...
//     })
//   }
//
// The signal is always present on the context (provided at bootstrap).
// During normal operation `stopping` is false and `remaining` is Infinity.
// When `gracefulStopWithTimeout` begins, it calls `signal.begin()` which
// sets `stopping = true` and starts the cooperative deadline clock.
// A disposer that calls `extend(n)` pushes the deadline forward, up to
// the hard cap; the host stops awaiting the disposer and schedules exit
// once the deadline expires or cleanup finishes, whichever comes first.

// ── Context type extension ───────────────────────────────────────────────
// Every plugin that accesses `ctx.signal` sees the correct type without
// additional imports. (No `cordis` import is needed: the declaration below
// augments the module by specifier.)
declare module "cordis" {
  interface Context {
    signal: ShutdownSignal
  }
}

// ── Renewable deadline timer ─────────────────────────────────────────────
// A single-shot timer that can be pushed forward. Used internally by
// ShutdownSignal to implement the extend protocol.

export class RenewableDeadline {
  private _resolve: ((value: "timeout") => void) | null = null
  private _timer: ReturnType<typeof setTimeout> | undefined
  private _deadline: number
  private _hardCap: number
  readonly promise: Promise<"timeout">

  /** `initialMs` from now; cannot exceed `hardCapMs` from now. */
  constructor(initialMs: number, hardCapMs: number) {
    const now = Date.now()
    this._deadline = now + Math.min(initialMs, hardCapMs)
    this._hardCap = now + hardCapMs
    this.promise = new Promise((resolve) => {
      this._resolve = resolve
    })
    this._schedule()
  }

  /** Milliseconds until the current deadline. */
  get remaining(): number {
    return Math.max(0, this._deadline - Date.now())
  }

  /** Absolute epoch ms of the current deadline. */
  get deadline(): number {
    return this._deadline
  }

  /** Absolute epoch ms of the hard cap. */
  get hardCap(): number {
    return this._hardCap
  }

  /**
   * Push the deadline forward by `ms` (subject to the hard cap).
   * Returns the new remaining time — the caller can use this to decide
   * whether it has enough time to finish its work.
   */
  extend(ms: number): number {
    if (this._deadline <= Date.now()) return 0 // already expired
    const candidate = this._deadline + ms
    this._deadline = Math.min(candidate, this._hardCap)
    this._schedule()
    return this.remaining
  }

  // ── private ──

  private _schedule(): void {
    if (this._timer) clearTimeout(this._timer)
    const delay = Math.max(0, this._deadline - Date.now())
    if (delay <= 0) {
      this._resolve?.("timeout")
      this._resolve = null
      return
    }
    this._timer = setTimeout(() => {
      this._resolve?.("timeout")
      this._resolve = null
    }, delay)
    this._timer.unref?.()
  }
}

// ── ShutdownSignal service ───────────────────────────────────────────────

export class ShutdownSignal {
  private _deadline: RenewableDeadline | null = null
  private _stopping = false
  private _reason: "stop" | "restart" | null = null

  /** Whether the host is in the shutdown process. */
  get stopping(): boolean {
    return this._stopping
  }

  /** Remaining milliseconds before the cooperative deadline. `Infinity` when not shutting down. */
  get remaining(): number {
    return this._deadline?.remaining ?? Infinity
  }

  /** Absolute epoch ms of the current deadline, or `null` when not shutting down. */
  get deadline(): number | null {
    return this._deadline?.deadline ?? null
  }

  /** Absolute epoch ms of the hard cap, or `null` when not shutting down. */
  get hardCap(): number | null {
    return this._deadline?.hardCap ?? null
  }

  /** Why the shutdown was triggered. `null` when not shutting down. */
  get reason(): "stop" | "restart" | null {
    return this._reason
  }

  /**
   * Try to become the shutdown trigger (the process-wide stopping gate).
   *
   * The first caller wins: it sets `stopping`, records its `reason` and starts
   * the cooperative deadline clock. Any later call while a shutdown is already
   * in progress is a no-op — it returns `false` and does NOT reset the
   * deadline or overwrite the reason. This unifies every in-process shutdown
   * path (stdio stop RPC, stdio restart RPC, dev-watch restart requester) so a
   * concurrent second request can never double-run fiber cleanup.
   *
   * @returns `true` if this call acquired the gate (it owns cleanup + exit);
   *          `false` if a shutdown is already in progress.
   */
  begin(initialMs: number, hardCapMs: number, reason: "stop" | "restart"): boolean {
    if (this._stopping) {
      // Already shutting down: keep the first trigger's deadline and reason.
      return false
    }
    this._stopping = true
    this._reason = reason
    this._deadline = new RenewableDeadline(initialMs, hardCapMs)
    return true
  }

  /**
   * Request additional time for cleanup. Each call pushes the deadline
   * forward by `ms` milliseconds, but never beyond the hard cap.
   *
   * @returns New remaining time in ms. 0 means the deadline has already
   *          expired or the hard cap has been reached.
   */
  extend(ms: number): number {
    return this._deadline?.extend(ms) ?? 0
  }

  /** The promise that resolves when the cooperative deadline expires. */
  get deadlinePromise(): Promise<"timeout"> | null {
    return this._deadline?.promise ?? null
  }
}