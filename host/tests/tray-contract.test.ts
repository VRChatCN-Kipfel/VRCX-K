import { describe, expect, test } from "bun:test"
import { assertTrayMenuSnapshot, validateTrayMenuSnapshot, type TrayMenuSnapshot } from "../src/tray_contract"

const action = (id: string) => ({
  kind: "action" as const,
  id,
  order: 0,
  label: id,
  enabled: true,
  visible: true,
  action: { target: "host" as const, command: "do.work", args: [], danger: "safe" as const, confirm: false },
})

const valid: TrayMenuSnapshot = {
  schemaVersion: 1,
  generation: 0,
  revision: 1,
  groups: [{ id: "host", order: 0, label: null, visible: true, source: "host", items: [action("host.action")] }],
}

describe("tray contract schema", () => {
  test("accepts a canonical snapshot", () => {
    expect(validateTrayMenuSnapshot(valid)).toBe(true)
    expect(() => assertTrayMenuSnapshot(valid)).not.toThrow()
  })

  test("rejects unknown fields", () => {
    const invalid = { ...valid, unexpected: true }
    expect(validateTrayMenuSnapshot(invalid)).toBe(false)
    expect(() => assertTrayMenuSnapshot(invalid)).toThrow(/invalid tray menu snapshot/)
  })

  test("rejects non-canonical casing", () => {
    const invalid = { ...valid, schema_version: 1 }
    expect(validateTrayMenuSnapshot(invalid)).toBe(false)
  })

  test("rejects unsafe generation and revision numbers", () => {
    expect(validateTrayMenuSnapshot({ ...valid, generation: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
    expect(validateTrayMenuSnapshot({ ...valid, revision: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
  })
})
