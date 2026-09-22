/**
 * Host ready handshake — runtime guard, environment collector, and constants.
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
 * The environment half of the handshake — TYPES and the vocabulary only.
 *
 * The COLLECTOR lives in `host/src/host-environment.ts`, not here, and that
 * split is load-bearing: this module is imported by the face (`src/host.ts`),
 * whose `tsconfig.json` deliberately carries no Bun/node types
 * ("Bun globals must not leak into shipped code"). Anything reading
 * `process`/`Bun`/`node:os` in this file would break the frontend typecheck.
 * Keeping `contracts/*` pure is also what lets `hostLifecycle.ts` be shared the
 * same way.
 */

type Platform = HostReady["host"]["platform"]
type Arch = HostReady["host"]["arch"]

/**
 * The one place `process.platform` becomes the contract's vocabulary.
 *
 * `contracts/plugin-manifest/v1` already fixed the spellings (`windows` /
 * `linux` / `macos`) and says outright that these are OUR names, not Node's.
 * Emitting `process.platform` directly would give the same machine two names in
 * two contracts, so the translation lives here and nowhere else. An unknown
 * platform throws rather than guessing: a wrong label would silently make
 * platform-conditional behaviour take the wrong branch.
 */
export function toPlatform(value: string): Platform {
  switch (value) {
    case "win32":
      return "windows"
    case "darwin":
      return "macos"
    case "linux":
      return "linux"
    default:
      throw new Error(`unsupported host platform: ${value}`)
  }
}

/**
 * Likewise for `process.arch`. Today the spellings coincide, but pinning our own
 * names means a Node rename cannot silently change what goes on the wire.
 */
export function toArch(value: string): Arch {
  switch (value) {
    case "x64":
      return "x64"
    case "arm64":
      return "arm64"
    default:
      throw new Error(`unsupported host architecture: ${value}`)
  }
}

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "port",
  "token",
  "hostVersion",
  "runtime",
  "host",
  "paths",
  "capacity",
  "extra",
]

const isShortString = (value: unknown, max = 64): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max

const isPathString = (value: unknown): value is string => isShortString(value, 4096)

/**
 * Whether `value` is a handshake this shell can act on.
 *
 * Rejects rather than coerces: a `port` of 0 is not "pick one for me", it is a
 * host that reported a bind failure as success, and `token` must be exactly the
 * 32-byte lowercase hex the host's own comparison expects — accepting a
 * near-miss here would only move the failure to a ws 1008 close later, where it
 * reads as a credential problem instead of a broken handshake.
 *
 * Mirrors the schema's `additionalProperties:false` by checking the key set at
 * every level, `extra` included (it is bounded, not unchecked).
 */
export function isHostReady(value: unknown): value is HostReady {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some((key) => !TOP_LEVEL_KEYS.includes(key))) return false

  if (
    candidate.schemaVersion !== HOST_READY_SCHEMA_VERSION ||
    !Number.isSafeInteger(candidate.port) ||
    (candidate.port as number) < 1 ||
    (candidate.port as number) > 65535 ||
    typeof candidate.token !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.token) ||
    !isShortString(candidate.hostVersion)
  ) {
    return false
  }

  return (
    isRuntime(candidate.runtime) &&
    isHostGroup(candidate.host) &&
    isPaths(candidate.paths) &&
    isCapacity(candidate.capacity) &&
    isExtra(candidate.extra)
  )
}

function isRuntime(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const group = value as Record<string, unknown>
  if (Object.keys(group).some((key) => !["bunVersion", "nodeVersion"].includes(key))) return false
  return isShortString(group.bunVersion) && isShortString(group.nodeVersion)
}

function isHostGroup(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const group = value as Record<string, unknown>
  if (Object.keys(group).some((key) => !["platform", "arch", "mode"].includes(key))) return false
  return (
    (group.platform === "windows" || group.platform === "linux" || group.platform === "macos") &&
    (group.arch === "x64" || group.arch === "arm64") &&
    (group.mode === "source" || group.mode === "compiled")
  )
}

function isPaths(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const group = value as Record<string, unknown>
  if (Object.keys(group).some((key) => !["cwd", "execPath"].includes(key))) return false
  return isPathString(group.cwd) && isPathString(group.execPath)
}

function isCapacity(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const group = value as Record<string, unknown>
  if (Object.keys(group).some((key) => !["capturedAtMs", "cpuCount", "totalMemBytes"].includes(key))) return false
  const safe = (v: unknown, min: number): boolean => Number.isSafeInteger(v) && (v as number) >= min
  return (
    safe(group.capturedAtMs, 0) &&
    safe(group.cpuCount, 1) &&
    safe(group.totalMemBytes, 1) &&
    (group.totalMemBytes as number) <= 9_007_199_254_740_991
  )
}

/**
 * The bounded forward-compatibility slot: camelCase keys, scalar values only,
 * at most 32 of them. Optional by design — its absence means "nothing extra",
 * not "malformed".
 */
function isExtra(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const group = value as Record<string, unknown>
  const keys = Object.keys(group)
  if (keys.length > 32) return false
  return keys.every((key) => {
    if (key.length < 1 || key.length > 64 || !/^[a-z][a-zA-Z0-9]*$/.test(key)) return false
    const item = group[key]
    return (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
  })
}
