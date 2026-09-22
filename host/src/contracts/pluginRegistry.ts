import type { Entry } from "@cordisjs/plugin-loader"
import { assertPluginManifest, assertSupportedRestartClass } from "./pluginContract"
import type { VRCXKPluginManifest } from "./pluginManifest.generated"

/**
 * The host-side manifest registry (M2-2).
 *
 * WHY A REGISTRY AND NOT `entry.options`
 *   Measured (`docs/cordis-runtime-findings.md` §1.12): `EntryOptions` has no slot
 *   for custom fields — its own keys are only `id`/`name`/`inject`/`config` (plus
 *   `group`/`disabled`). So a manifest cannot ride on the entry; the host keeps its
 *   own table keyed by entry id.
 *
 * WHY THE KEY IS THE **SUFFIX**
 *   Measured (`docs/probes/probe11.ts`): the full `entry.id` is
 *   `<random-prefix>:<yaml-id>` and the prefix changes every run — it even equals
 *   the Include entry's own id. Persisting or matching on the full id would break
 *   on every restart. Consumers must treat the prefix as opaque and key on the
 *   part after the last ":".
 *
 * An entry with no manifest is NOT an error here. A plugin without a declaration
 * simply has no capabilities to compare against, and the caller decides what that
 * means (M2-8 reports it; nothing is blocked — design P2).
 */
export class PluginManifestRegistry {
  private readonly bySuffix = new Map<string, VRCXKPluginManifest>()

  /**
   * The stable part of an `entry.id`: everything after the last ":".
   *
   * A bare `ctx.plugin()` has no entry at all, and an id with no ":" is already
   * its own suffix — both fall through unchanged rather than erroring.
   */
  static keyOf(entryId: string): string {
    const index = entryId.lastIndexOf(":")
    return index === -1 ? entryId : entryId.slice(index + 1)
  }

  /** Register a manifest for an entry id. Throws if the manifest is invalid. */
  register(entryId: string, manifest: unknown): VRCXKPluginManifest {
    assertPluginManifest(manifest)
    assertSupportedRestartClass(manifest)
    this.bySuffix.set(PluginManifestRegistry.keyOf(entryId), manifest)
    return manifest
  }

  unregister(entryId: string): void {
    this.bySuffix.delete(PluginManifestRegistry.keyOf(entryId))
  }

  get(entryId: string): VRCXKPluginManifest | undefined {
    return this.bySuffix.get(PluginManifestRegistry.keyOf(entryId))
  }

  has(entryId: string): boolean {
    return this.bySuffix.has(PluginManifestRegistry.keyOf(entryId))
  }

  get size(): number {
    return this.bySuffix.size
  }

  /** Registered suffixes, sorted — for diagnostics and tests. */
  keys(): string[] {
    return [...this.bySuffix.keys()].sort()
  }

  /**
   * The cordis `inject` implied by `services.required`.
   *
   * This is decision D2, option A: the manifest is authoritative and the host
   * DERIVES the entry's inject from it, in one direction, so the two cannot drift.
   * `required` is a readiness gate — a plugin is not started until those services
   * are provided — which is exactly what cordis `inject` means
   * (`cordis-runtime-findings.md` §1.5).
   *
   * `optional` is deliberately NOT included: injecting an absent service would
   * park the fiber in PENDING forever, whereas an optional service must merely be
   * used-if-present.
   */
  static injectFor(manifest: VRCXKPluginManifest): string[] {
    return [...(manifest.services?.required ?? [])]
  }

  /**
   * Read a manifest from a plugin directory. Separated from `register` so a
   * caller can parse without mutating the registry.
   */
  static async readFrom(pluginDir: string): Promise<VRCXKPluginManifest> {
    const path = `${pluginDir.replace(/[\\/]+$/, "")}/.vrcxk/manifest.json`
    const file = Bun.file(path)
    if (!(await file.exists())) {
      throw new Error(`plugin manifest not found at ${path}`)
    }
    const parsed: unknown = JSON.parse(await file.text())
    assertPluginManifest(parsed)
    assertSupportedRestartClass(parsed)
    return parsed
  }

  /**
   * Populate the registry from the live entry tree.
   *
   * Only entries whose plugin directory actually carries a manifest are recorded;
   * base/host-internal entries without one are skipped rather than failing, so a
   * partially-migrated tree still boots.
   */
  async loadFromEntries(
    entries: Iterable<Entry>,
    resolveDir: (entry: Entry) => string | undefined,
  ): Promise<{ loaded: string[]; skipped: string[] }> {
    const loaded: string[] = []
    const skipped: string[] = []
    for (const entry of entries) {
      const dir = resolveDir(entry)
      if (!dir) {
        skipped.push(entry.id)
        continue
      }
      try {
        this.register(entry.id, await PluginManifestRegistry.readFrom(dir))
        loaded.push(PluginManifestRegistry.keyOf(entry.id))
      } catch {
        // A missing or invalid manifest is not fatal here: M2-8 surfaces it and
        // nothing is blocked (design P2). Refusing to load is a separate,
        // deliberate decision made before the entry is created.
        skipped.push(entry.id)
      }
    }
    return { loaded, skipped }
  }
}
