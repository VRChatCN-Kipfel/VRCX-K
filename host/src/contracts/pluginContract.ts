import Ajv2020, { type ValidateFunction } from "ajv/dist/2020"
import indexEntrySchema from "../../../contracts/plugin-index/v1/plugin-index-entry.schema.json"
import manifestSchema from "../../../contracts/plugin-manifest/v1/plugin-manifest.schema.json"
import type { VRCXKPluginIndexEntry } from "./pluginIndexEntry.generated"
import type { VRCXKPluginManifest } from "./pluginManifest.generated"

/** Canonical schema revision for the author-owned plugin manifest. */
export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const
/** Canonical schema revision for a plugin source's index entry. */
export const PLUGIN_INDEX_SCHEMA_VERSION = 1 as const

// `strict: true` fails the build on a schema typo rather than silently accepting
// everything — the whole point of compiling the schema instead of hand-writing a
// guard.
const ajv = new Ajv2020({ allErrors: true, strict: true })

export const validatePluginManifest: ValidateFunction<VRCXKPluginManifest> =
  ajv.compile(manifestSchema)
export const validatePluginIndexEntry: ValidateFunction<VRCXKPluginIndexEntry> =
  ajv.compile(indexEntrySchema)

function describe(errors: ValidateFunction["errors"]): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")
}

export function assertPluginManifest(value: unknown): asserts value is VRCXKPluginManifest {
  if (!validatePluginManifest(value)) {
    throw new Error(`invalid plugin manifest: ${describe(validatePluginManifest.errors)}`)
  }
}

export function assertPluginIndexEntry(value: unknown): asserts value is VRCXKPluginIndexEntry {
  if (!validatePluginIndexEntry(value)) {
    throw new Error(`invalid plugin index entry: ${describe(validatePluginIndexEntry.errors)}`)
  }
}

/**
 * The restart classes a plugin may declare, and the subset the host can actually
 * honour TODAY.
 *
 * The schema carries the full vocabulary so it need not change when the host
 * catches up; the accepted subset is what widens. M3 opens `frontend`, M4 opens
 * `background` (architecture §2.2 — rolling replacement needs the C-class runner).
 *
 * Rejecting rather than downgrading is deliberate: a silent downgrade would tell
 * the author their declaration was honoured when it was not.
 */
export const RESTART_CLASSES = ["restartable", "frontend", "background"] as const
export type RestartClass = (typeof RESTART_CLASSES)[number]
export const SUPPORTED_RESTART_CLASSES: readonly RestartClass[] = ["restartable"]

export function assertSupportedRestartClass(manifest: VRCXKPluginManifest): void {
  const declared = (manifest.restartClass ?? "restartable") as RestartClass
  if (!SUPPORTED_RESTART_CLASSES.includes(declared)) {
    throw new Error(
      `restartClass "${declared}" is not supported yet (supported: ${SUPPORTED_RESTART_CLASSES.join(", ")}); ` +
        `see docs/plugin-source-and-index-design.md §5.6`,
    )
  }
}
