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
      // be spawning. The event stream is authoritative and complete, so once it
      // has made the view live a response must never overwrite it: across the
      // mount race both carry the same generation, so `isStaleSnapshot` cannot
      // catch a response that is older *by value* (e.g. `starting` arriving
      // after the `ready` event for the same spawn).
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
      return { status: "error", snapshot: view.snapshot, notice: action.message }
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
