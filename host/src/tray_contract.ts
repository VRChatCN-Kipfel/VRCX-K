import Ajv2020, { type ValidateFunction } from "ajv/dist/2020"
import schema from "../../contracts/tray-menu.schema.json"
import type { TrayMenuSnapshot } from "./tray-contract.generated"

/** Canonical schema revision for host ↔ Rust tray payloads. */
export const TRAY_SCHEMA_VERSION = 1 as const

const ajv = new Ajv2020({ allErrors: true, strict: true })
export const validateTrayMenuSnapshot: ValidateFunction<TrayMenuSnapshot> = ajv.compile(schema)

export function assertTrayMenuSnapshot(value: unknown): asserts value is TrayMenuSnapshot {
  if (!validateTrayMenuSnapshot(value)) {
    const details = (validateTrayMenuSnapshot.errors ?? []).map((error) => `${error.instancePath} ${error.message}`).join("; ")
    throw new Error(`invalid tray menu snapshot: ${details}`)
  }
}
