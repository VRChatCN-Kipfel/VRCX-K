/**
 * Host lifecycle contract — HYBRID file, read the note before editing.
 *
 * The TYPES below mirror `contracts/host-lifecycle/v1/*.schema.json` and can be
 * regenerated with json-schema-to-typescript.
 *
 * The GUARDS (`isHostSnapshot` / `isHostExitSummary`) are HAND-WRITTEN and are
 * NOT generated: they exist because the wire guard must also enforce semantics a
 * JSON Schema cannot express for this shape, and because a hand-written guard
 * keeps the check dependency-free at the call site.
 *
 * Because the two live in one file, it is deliberately excluded from
 * `scripts/check-contract-drift.ts` (which byte-compares a fresh generation and
 * would always report a false drift here). Its type/schema agreement is pinned
 * by `host/tests/host-lifecycle-contract.test.ts`, which reads the schema at
 * runtime. If you split this file, add it to that gate.
 */

export const HOST_LIFECYCLE_SCHEMA_VERSION = 1 as const
export const MAX_SAFE_INTEGER = 9_007_199_254_740_991
export const HOST_LIFECYCLE_SCHEMA_ID = "https://vrcx-k.dev/contracts/host-lifecycle/v1/host-lifecycle.schema.json"

export type HostLifecycleState = "stopped" | "starting" | "ready" | "stopping" | "backoff" | "failed"
export type HostDesiredState = "running" | "stopped" | "app_exit"
export type HostCommand = "start" | "graceful_stop" | "force_kill" | "restart" | "reload"
export type HostExitKind = "restart_requested" | "stopped" | "crashed"

export type HostExitSummary = {
  code: number | null
  signal: string | null
  kind: HostExitKind
}

export type HostSnapshot = {
  schemaVersion: typeof HOST_LIFECYCLE_SCHEMA_VERSION
  generation: number
  phase: HostLifecycleState
  desired: HostDesiredState
  pid: number | null
  port: number | null
  attempt: number
  nextRetryMs: number | null
  lastExit: HostExitSummary | null
  lastError: string | null
}

export type HostCommandResult =
  | { kind: "accepted"; generation: number }
  | { kind: "noop"; phase: HostLifecycleState }
  | { kind: "rejected"; phase: HostLifecycleState; reason: string }

export function isHostSnapshot(value: unknown): value is HostSnapshot {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<HostSnapshot> & Record<string, unknown>
  if (Object.keys(candidate).some((key) => key.includes("_") || !["schemaVersion", "generation", "phase", "desired", "pid", "port", "attempt", "nextRetryMs", "lastExit", "lastError"].includes(key))) return false
  return candidate.schemaVersion === HOST_LIFECYCLE_SCHEMA_VERSION
    && (candidate.phase === "stopped" || candidate.phase === "starting" || candidate.phase === "ready" || candidate.phase === "stopping" || candidate.phase === "backoff" || candidate.phase === "failed")
    && (candidate.desired === "running" || candidate.desired === "stopped" || candidate.desired === "app_exit")
    && Number.isSafeInteger(candidate.generation) && (candidate.generation ?? -1) >= 0 && (candidate.generation ?? MAX_SAFE_INTEGER + 1) <= MAX_SAFE_INTEGER
    && typeof candidate.phase === "string"
    && typeof candidate.desired === "string"
    && (candidate.pid === null || (Number.isSafeInteger(candidate.pid) && (candidate.pid ?? -1) >= 0))
    && (candidate.port === null || (Number.isSafeInteger(candidate.port) && (candidate.port ?? -1) >= 0 && (candidate.port ?? 65536) <= 65535))
    && Number.isSafeInteger(candidate.attempt) && (candidate.attempt ?? -1) >= 0
    && (candidate.nextRetryMs === null || (Number.isSafeInteger(candidate.nextRetryMs) && (candidate.nextRetryMs ?? -1) >= 0))
    && (candidate.lastExit === null || isHostExitSummary(candidate.lastExit))
    && (candidate.lastError === null || typeof candidate.lastError === "string")
}

function isHostExitSummary(value: unknown): value is HostExitSummary {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<HostExitSummary>
  return (candidate.code === null || typeof candidate.code === "number")
    && (candidate.signal === null || typeof candidate.signal === "string")
    && (candidate.kind === "restart_requested" || candidate.kind === "stopped" || candidate.kind === "crashed")
}
