import { expect, test } from "bun:test"
import {
  HOST_LIFECYCLE_SCHEMA_ID,
  HOST_LIFECYCLE_SCHEMA_VERSION,
  MAX_SAFE_INTEGER,
  isHostSnapshot,
  type HostSnapshot,
} from "../src/contracts/hostLifecycle"

const validSnapshot: HostSnapshot = {
  schemaVersion: HOST_LIFECYCLE_SCHEMA_VERSION,
  generation: 1,
  phase: "ready",
  desired: "running",
  pid: 42,
  port: 43120,
  attempt: 0,
  nextRetryMs: null,
  lastExit: null,
  lastError: null,
}

test("lifecycle guard accepts canonical camelCase snapshot", () => {
  expect(isHostSnapshot(validSnapshot)).toBe(true)
  expect(HOST_LIFECYCLE_SCHEMA_ID).toContain("/host-lifecycle/v1/")
})

test("lifecycle guard rejects snake_case or unsafe generation", () => {
  expect(isHostSnapshot({ ...validSnapshot, schema_version: 1 })).toBe(false)
  expect(isHostSnapshot({ ...validSnapshot, generation: MAX_SAFE_INTEGER + 1 })).toBe(false)
  expect(isHostSnapshot({ ...validSnapshot, phase: "unknown" })).toBe(false)
  expect(isHostSnapshot({ ...validSnapshot, port: 65536 })).toBe(false)
})
