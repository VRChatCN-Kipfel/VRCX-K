/**
 * Host ready handshake — runtime guard and constants.
 *
 * The TYPE lives in `hostReady.generated.ts`, which is a pure generation of
 * `contracts/host-ready/v1/host-ready.schema.json` and is byte-compared by
 * `scripts/check-contract-drift.ts`. Unlike `hostLifecycle.ts` (a hybrid that
 * the gate must skip), this file keeps the generated half pristine precisely so
 * the gate can cover it.
 *
 * The GUARD is hand-written for the same reason as `isHostSnapshot`: the shell
 * must be able to reject a malformed handshake at the wire boundary, before it
 * stores a port or token it would later act on, and a dependency-free check is
 * cheaper to call there than a schema validator.
 *
 * Rust mirrors this contract in `src-tauri/src/host_ready.rs`; that file's test
 * reads the same schema with `include_str!`, so both sides fail loudly if the
 * schema drifts away from either implementation.
 */

import type { VRCXKHostReady } from "./hostReady.generated"

/** The `schemaVersion` this build speaks. Mirrors the schema's `const`. */
export const HOST_READY_SCHEMA_VERSION = 1 as const

export const HOST_READY_SCHEMA_ID = "https://vrcx-k.dev/contracts/host-ready/v1/host-ready.schema.json"

/** The handshake the host sends and the shell validates. */
export type HostReady = VRCXKHostReady

/**
 * Whether `value` is a handshake this shell can act on.
 *
 * Rejects rather than coerces: a `port` of 0 is not "pick one for me", it is a
 * host that reported a bind failure as success, and `token` must be exactly the
 * 32-byte lowercase hex the host's own comparison expects — accepting a
 * near-miss here would only move the failure to a ws 1008 close later, where it
 * reads as a credential problem instead of a broken handshake.
 */
export function isHostReady(value: unknown): value is HostReady {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  // Strict key set: an unexpected field means the two sides disagree about the
  // handshake, which is exactly what this contract exists to catch.
  if (Object.keys(candidate).some((key) => !["schemaVersion", "port", "token", "hostVersion"].includes(key))) {
    return false
  }
  return (
    candidate.schemaVersion === HOST_READY_SCHEMA_VERSION &&
    Number.isSafeInteger(candidate.port) &&
    (candidate.port as number) >= 1 &&
    (candidate.port as number) <= 65535 &&
    typeof candidate.token === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.token) &&
    typeof candidate.hostVersion === "string" &&
    candidate.hostVersion.length >= 1 &&
    candidate.hostVersion.length <= 64
  )
}
