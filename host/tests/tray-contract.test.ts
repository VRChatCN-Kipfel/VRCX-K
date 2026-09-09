import { describe, expect, test } from "bun:test"
import { assertTrayMenuSnapshot, validateTrayMenuSnapshot, type TrayMenuSnapshot } from "../src/tray_contract"

const action = (id: string, target: "host" | "core" | "app" = "host") => ({
  kind: "action" as const,
  id,
  order: 0,
  label: id,
  enabled: true,
  visible: true,
  action: { target, command: "do.work", args: [], danger: "safe" as const, confirm: false },
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

  test("allows core and app targets only in Rust-owned core groups", () => {
    const core = {
      ...valid,
      groups: [{ id: "core.application", order: 0, label: null, visible: true, source: "core", items: [action("core.app.restart", "app")] }],
    }
    expect(validateTrayMenuSnapshot(core)).toBe(true)

    const nestedCore = {
      ...core,
      groups: [{
        ...core.groups[0],
        items: [{ kind: "submenu", id: "core.submenu", order: 0, label: "Core", enabled: true, visible: true, items: [action("core.window.show", "core")] }],
      }],
    }
    expect(validateTrayMenuSnapshot(nestedCore)).toBe(true)
  })

  test("rejects source-target privilege escalation recursively", () => {
    const hostToCore = {
      ...valid,
      groups: [{ ...valid.groups[0], items: [action("host.escalate", "core")] }],
    }
    expect(validateTrayMenuSnapshot(hostToCore)).toBe(false)

    const pluginToApp = {
      ...valid,
      groups: [{ id: "plugin.menu", order: 0, label: null, visible: true, source: "plugin", items: [action("plugin.escalate", "app")] }],
    }
    expect(validateTrayMenuSnapshot(pluginToApp)).toBe(false)

    const nestedHostToCore = {
      ...valid,
      groups: [{
        ...valid.groups[0],
        items: [{ kind: "submenu", id: "host.submenu", order: 0, label: "Host", enabled: true, visible: true, items: [action("host.nested.escalate", "core")] }],
      }],
    }
    expect(validateTrayMenuSnapshot(nestedHostToCore)).toBe(false)

    const coreToHost = {
      ...valid,
      groups: [{ id: "core.window", order: 0, label: null, visible: true, source: "core", items: [action("core.window.show", "host")] }],
    }
    expect(validateTrayMenuSnapshot(coreToHost)).toBe(false)
  })
})
