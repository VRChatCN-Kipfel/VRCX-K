// Frontend owner of the host-lifecycle wire contract (face side).
//
// The canonical definition lives in `host/src/contracts/hostLifecycle.ts`
// (generated from `contracts/host-lifecycle/v1/*.schema.json`) and is mirrored
// 1:1 by the Rust shell (`src-tauri/src/host_lifecycle.rs`). This module is the
// single import site for the face: it re-exports the canonical types,
// constants *and validator* — never a hand-forked copy — and adds the
// IPC-specific pieces (the `{ snapshot }` response envelope plus the pure
// reducer/formatting used by `hostLifecyclePanel.tsx`).
//
// Guard rule: `isHostSnapshot` must stay exactly as strict as the host
// validator, so it *is* the host validator. `{ lastExit: [] }` fails it (an
// array is not a `HostExitSummary`), while the envelope `{ snapshot }` fails it
// too — use `parseHostLifecyclePayload`/`isHostLifecycleEnvelope` for IPC
// payloads.

import {
  HOST_LIFECYCLE_SCHEMA_ID,
  HOST_LIFECYCLE_SCHEMA_VERSION,
  MAX_SAFE_INTEGER,
  isHostSnapshot,
} from "../host/src/contracts/hostLifecycle"
import type { HostSnapshot } from "../host/src/contracts/hostLifecycle"

export type {
  HostCommand,
  HostCommandResult,
  HostDesiredState,
  HostExitKind,
  HostExitSummary,
  HostLifecycleState,
  HostSnapshot,
} from "../host/src/contracts/hostLifecycle"

export { HOST_LIFECYCLE_SCHEMA_ID, HOST_LIFECYCLE_SCHEMA_VERSION, MAX_SAFE_INTEGER, isHostSnapshot }

/** Response of the Tauri command `get_host_lifecycle` and payload of the `host-lifecycle` event. */
export type HostLifecycleEnvelope = { snapshot: HostSnapshot }

/**
 * Strict envelope guard: exactly one own key, `snapshot`, holding a valid
 * snapshot. The bare-snapshot allow-list in `isHostSnapshot` has no `snapshot`
 * key, so the envelope must be unwrapped explicitly.
 */
export function isHostLifecycleEnvelope(value: unknown): value is HostLifecycleEnvelope {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate)
  if (keys.length !== 1 || keys[0] !== "snapshot") return false
  return isHostSnapshot(candidate.snapshot)
}

/**
 * Accept either IPC shape: the `{ snapshot }` envelope (current shell) or a
 * bare snapshot (tolerant of a shell that emits the DTO directly).
 * Returns null for anything that is not a valid snapshot — callers must not
 * throw on a malformed payload.
 */
export function parseHostLifecyclePayload(value: unknown): HostSnapshot | null {
  if (isHostSnapshot(value)) return value
  if (isHostLifecycleEnvelope(value)) return value.snapshot
  return null
}

/**
 * A snapshot whose generation is strictly older than the one already shown is
 * an out-of-order push (generation is allocated once per real host spawn and
 * only ever increases), so it must not overwrite newer state.
 */
export function isStaleSnapshot(current: HostSnapshot | null, next: HostSnapshot): boolean {
  return current !== null && next.generation < current.generation
}

// ── pure view reducer (unit-tested in hostLifecycle.test.ts) ────────────────

/**
 * `pending`: nothing answered yet.
 * `live`: at least one valid snapshot has been received.
 * `unsupported`: the shell has no `get_host_lifecycle` command (older shell).
 * `error`: the event listener could not be attached.
 */
export type HostLifecycleStatus = "pending" | "live" | "unsupported" | "error"

export type HostLifecycleView = {
  status: HostLifecycleStatus
  snapshot: HostSnapshot | null
  /** Human-readable detail for `unsupported`/`error`; rendered as text only. */
  notice: string | null
}

export const initialHostLifecycleView: HostLifecycleView = {
  status: "pending",
  snapshot: null,
  notice: null,
}

export type HostLifecycleAction =
  /** Result of `invoke("get_host_lifecycle")`. */
  | { kind: "response"; raw: unknown }
  /** Payload of the `host-lifecycle` event. */
  | { kind: "event"; raw: unknown }
  /** The command/listener is missing (older shell) or the runtime is not Tauri. */
  | { kind: "unsupported"; reason: string }
  /** Transport/listen failure. */
  | { kind: "error"; message: string }

export function reduceHostLifecycle(
  view: HostLifecycleView,
  action: HostLifecycleAction,
): HostLifecycleView {
  switch (action.kind) {
    case "response": {
      // The one-shot invoke is a mount-time seed, read while the host may still
      // be spawning. The event stream is the authoritative *change source*, but
      // it is NOT a complete state mirror: the snapshot fingerprint excludes
      // `nextRetryMs` (it ticks during backoff but is never re-emitted),
      // `stopping` is never published, and events emitted before the listener
      // registers are dropped (Tauri neither buffers nor replays). So once an
      // event has made the view live a response must never overwrite it: across
      // the mount race both carry the same generation, so `isStaleSnapshot`
      // cannot catch a response that is older *by value* (e.g. `starting`
      // arriving after the `ready` event for the same spawn).
      if (view.status === "live") return view
      const snapshot = parseHostLifecyclePayload(action.raw)
      if (!snapshot) {
        return {
          status: "unsupported",
          snapshot: null,
          notice: `get_host_lifecycle 返回了无法识别的快照`,
        }
      }
      if (isStaleSnapshot(view.snapshot, snapshot)) return view
      return { status: "live", snapshot, notice: null }
    }
    case "event": {
      const snapshot = parseHostLifecyclePayload(action.raw)
      // Malformed or out-of-order pushes never clear the last known good state.
      if (!snapshot || isStaleSnapshot(view.snapshot, snapshot)) return view
      return { status: "live", snapshot, notice: null }
    }
    case "unsupported":
      // A missing command must not clobber a snapshot already received from
      // the event stream (the two arrive concurrently on mount).
      if (view.status === "live") return view
      return { status: "unsupported", snapshot: null, notice: action.reason }
    case "error":
      // Deliberately unconditional, even when a snapshot is already live: a
      // listener failure is a real transport fault, not a mount-time race, so
      // it must stay visible (the dot turns red) rather than hide behind stale
      // data. This is the one exception to the "live is sticky" rule above.
      return { status: "error", snapshot: view.snapshot, notice: action.message }
  }
}

// ── mount orchestration (pure, injectable — unit-tested) ───────────────────

export type HostLifecycleSubscribeDeps = {
  /** Attach the `host-lifecycle` listener; resolves to an unsubscribe fn. */
  listen: (onEvent: (raw: unknown) => void) => Promise<() => void>
  /** One-shot read of the current snapshot (`get_host_lifecycle`). */
  readSeed: () => Promise<unknown>
  /** Deliver a reducer action to the view. */
  apply: (action: HostLifecycleAction) => void
  /** Called when `listen` rejects (log it here; the seed is still read). */
  onListenError?: (err: unknown) => void
}

/**
 * Wire the panel's mount sequence. Split out of `hostLifecyclePanel.tsx` so the
 * ordering rules — which are the subtle part — are testable without React.
 *
 * The listener is registered BEFORE the seed is read: Tauri neither buffers nor
 * replays events, so anything emitted before registration is gone for good.
 * Reading the seed only after `listen` resolves makes it reflect current state
 * instead of a spawn-time snapshot that the fingerprint feed (re-emits only on
 * change) will never correct. `reduceHostLifecycle` ignores a response once an
 * event has made the view live, so an event landing in between still wins.
 *
 * On a listen failure the seed is read anyway — the command may still work, and
 * the `error` reducer branch keeps `view.snapshot` (last known state). The
 * `readSeed` helper swallows its own failure, so the `.catch` below only ever
 * sees listen failures.
 */
export function subscribeHostLifecycle(deps: HostLifecycleSubscribeDeps): () => void {
  let cancelled = false
  let unlisten: (() => void) | undefined
  const applyIfLive = (action: HostLifecycleAction) => {
    if (!cancelled) deps.apply(action)
  }
  const seed = () =>
    deps
      .readSeed()
      .then((raw) => applyIfLive({ kind: "response", raw }))
      .catch((err: unknown) => {
        // Missing command on an older shell → unsupported, never a crash.
        applyIfLive({ kind: "unsupported", reason: `get_host_lifecycle 不可用：${String(err)}` })
      })

  void deps
    .listen((raw) => applyIfLive({ kind: "event", raw }))
    .then((fn) => {
      if (cancelled) {
        fn()
        return
      }
      unlisten = fn
      return seed()
    })
    .catch((err: unknown) => {
      deps.onListenError?.(err)
      return seed().then(() =>
        applyIfLive({ kind: "error", message: `无法监听 host-lifecycle：${String(err)}` }),
      )
    })

  return () => {
    cancelled = true
    unlisten?.()
  }
}

// ── pure formatting (unit-tested in hostLifecycle.test.ts) ─────────────────

export type HostLifecycleField = { key: string; label: string; value: string }

/** Placeholder for absent optional values. */
export const HOST_ABSENT = "—"

export function formatHostSnapshot(snapshot: HostSnapshot): HostLifecycleField[] {
  return [
    { key: "phase", label: "phase", value: snapshot.phase },
    { key: "desired", label: "desired", value: snapshot.desired },
    { key: "generation", label: "generation", value: String(snapshot.generation) },
    { key: "attempt", label: "attempt", value: String(snapshot.attempt) },
    { key: "pid", label: "pid", value: snapshot.pid === null ? HOST_ABSENT : String(snapshot.pid) },
    { key: "port", label: "port", value: snapshot.port === null ? HOST_ABSENT : String(snapshot.port) },
    {
      key: "nextRetryMs",
      label: "nextRetryMs",
      value: snapshot.nextRetryMs === null ? HOST_ABSENT : `${snapshot.nextRetryMs} ms`,
    },
    {
      key: "lastError",
      label: "lastError",
      value: snapshot.lastError === null ? HOST_ABSENT : snapshot.lastError,
    },
  ]
}

/** One-line state used as the panel heading and the dot's accessible label. */
export function hostLifecycleSummary(view: HostLifecycleView): string {
  switch (view.status) {
    case "pending":
      return "正在读取宿主生命周期…"
    case "unsupported":
      return `不可用：${view.notice ?? "壳未提供 get_host_lifecycle"}`
    case "error":
      return `读取失败：${view.notice ?? "未知错误"}`
    case "live": {
      const snapshot = view.snapshot
      if (!snapshot) return "正在读取宿主生命周期…"
      const parts = [`${snapshot.phase} · desired ${snapshot.desired} · gen ${snapshot.generation}`]
      if (snapshot.pid !== null) parts.push(`pid ${snapshot.pid}`)
      if (snapshot.port !== null) parts.push(`port ${snapshot.port}`)
      return parts.join(" · ")
    }
  }
}
