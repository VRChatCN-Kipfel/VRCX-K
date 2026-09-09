import type { HostSnapshot } from "../host/src/contracts/hostLifecycle"

export type { HostCommand, HostCommandResult, HostDesiredState, HostExitSummary, HostLifecycleState, HostSnapshot } from "../host/src/contracts/hostLifecycle"

export const HOST_LIFECYCLE_SCHEMA_ID = "https://vrcx-k.dev/contracts/host-lifecycle/v1/host-lifecycle.schema.json"
export const HOST_LIFECYCLE_SCHEMA_VERSION = 1 as const
export const MAX_SAFE_INTEGER = 9_007_199_254_740_991

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
    && (candidate.pid === null || Number.isSafeInteger(candidate.pid))
    && (candidate.port === null || (Number.isSafeInteger(candidate.port) && (candidate.port ?? -1) >= 0 && (candidate.port ?? 65536) <= 65535))
    && Number.isSafeInteger(candidate.attempt) && (candidate.attempt ?? -1) >= 0
    && (candidate.nextRetryMs === null || (Number.isSafeInteger(candidate.nextRetryMs) && (candidate.nextRetryMs ?? -1) >= 0))
    && (candidate.lastExit === null || typeof candidate.lastExit === "object")
    && (candidate.lastError === null || typeof candidate.lastError === "string")
}
