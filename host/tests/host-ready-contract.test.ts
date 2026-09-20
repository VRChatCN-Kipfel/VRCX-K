// The host ready handshake is the FIRST frame the host sends and the only place
// the shell — and the face — learn how to reach the host's ws surface. It used
// to be an undocumented `{ port, token }` literal duplicated in three files with
// no schema and no drift gate; these tests pin the contract that replaced it.
//
// Same shape as host-lifecycle-contract.test.ts: the committed mirror is checked
// against the canonical schema at RUNTIME, so the schema and the TypeScript
// cannot quietly diverge (the generated file is also byte-gated by
// `bun run check:contracts`).

import { expect, test } from "bun:test"
import { HOST_READY_SCHEMA_ID, HOST_READY_SCHEMA_VERSION, isHostReady } from "../src/contracts/hostReady"

const schemaPath = new URL("../../contracts/host-ready/v1/host-ready.schema.json", import.meta.url)
const schema = (await Bun.file(schemaPath).json()) as {
  $id: string
  additionalProperties: boolean
  required: string[]
  properties: Record<string, { const?: unknown; minimum?: unknown; maximum?: unknown; pattern?: string }>
}

const valid = {
  schemaVersion: HOST_READY_SCHEMA_VERSION,
  port: 43120,
  token: "a".repeat(64),
  hostVersion: "0.0.1",
}

test("the schema is the versioned canonical contract", () => {
  expect(schema.$id).toBe(HOST_READY_SCHEMA_ID)
  expect(schema.properties.schemaVersion.const).toBe(1)
  // additionalProperties:false is what makes an unexpected field a contract
  // violation rather than something both sides silently ignore.
  expect(schema.additionalProperties).toBe(false)
  expect(schema.required).toEqual(["schemaVersion", "port", "token", "hostVersion"])
})

test("the guard accepts the canonical handshake", () => {
  expect(isHostReady(valid)).toBe(true)
  // Port bounds and token pattern are part of the schema, so the guard must
  // agree with them rather than being a looser hand-rolled check.
  expect(schema.properties.port.minimum).toBe(1)
  expect(schema.properties.port.maximum).toBe(65535)
  expect(schema.properties.token.pattern).toBe("^[0-9a-f]{64}$")
})

test("the guard rejects a wrong schema version", () => {
  expect(isHostReady({ ...valid, schemaVersion: 2 })).toBe(false)
  expect(isHostReady({ ...valid, schemaVersion: "1" })).toBe(false)
})

test("the guard rejects a port the shell could not connect to", () => {
  // 0 is not "pick any port": the host binds an ephemeral port and reports what
  // the OS assigned, so 0 means the bind result was lost.
  expect(isHostReady({ ...valid, port: 0 })).toBe(false)
  expect(isHostReady({ ...valid, port: 65536 })).toBe(false)
  expect(isHostReady({ ...valid, port: "43120" })).toBe(false)
})

test("the guard rejects a token that is not the promised shape", () => {
  expect(isHostReady({ ...valid, token: "A".repeat(64) })).toBe(false)
  expect(isHostReady({ ...valid, token: "a".repeat(63) })).toBe(false)
  expect(isHostReady({ ...valid, token: "z".repeat(64) })).toBe(false)
  expect(isHostReady({ ...valid, token: 42 })).toBe(false)
})

test("the guard rejects a missing or oversized hostVersion", () => {
  expect(isHostReady({ ...valid, hostVersion: "" })).toBe(false)
  expect(isHostReady({ ...valid, hostVersion: "v".repeat(65) })).toBe(false)
  const { hostVersion: _drop, ...withoutVersion } = valid
  expect(isHostReady(withoutVersion)).toBe(false)
})

test("the guard rejects extra fields and non-objects", () => {
  // An unexpected key means the two sides disagree about the handshake, which
  // is exactly what this contract exists to catch.
  expect(isHostReady({ ...valid, extra: true })).toBe(false)
  expect(isHostReady({ ...valid, schema_version: 1 })).toBe(false)
  expect(isHostReady(null)).toBe(false)
  expect(isHostReady([valid])).toBe(false)
  expect(isHostReady("ready")).toBe(false)
})
