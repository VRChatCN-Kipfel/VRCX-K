import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { Entry } from "@cordisjs/plugin-loader"
import type { Context } from "cordis"
import { PluginManifestRegistry } from "./contracts/pluginRegistry"
import { canonicalPath } from "./watch-path"

/**
 * Manifests are read from a plugin's own directory:
 *
 *     <plugin-dir>/.vrcxk/manifest.json
 *
 * WHY THE SUFFIX IS THE KEY
 *   `entry.id` is `<random-prefix>:<yaml-id>`, and the prefix changes on every
 *   boot (probe11 — it is the Include entry's own generated id). Persisting or
 *   matching on the full id breaks across restarts, so the registry keys on the
 *   part after the last ":".
 *
 * RESOLVING A PLUGIN DIRECTORY FROM AN ENTRY
 *   `entry.options.name` is a specifier resolved against `ctx.baseUrl`, which
 *   Include rewrites to the yml's directory. So the plugin directory is the
 *   specifier's dirname, canonicalised through the same helper the watcher uses
 *   (Windows drive-letter casing and mixed separators would otherwise produce
 *   two spellings of one path).
 *
 *   Bare package names (no "./") cannot be resolved this way and are skipped:
 *   the loader resolves those through node resolution, not a filesystem path.
 */
export async function loadManifests(
  ctx: Context,
  includeEntry: Entry,
): Promise<{
  loaded: string[]
  skipped: string[]
}> {
  const registry = new PluginManifestRegistry()
  const loaded: string[] = []
  const skipped: string[] = []

  const subtree = includeEntry.subtree
  if (!subtree) return { loaded, skipped }

  for (const entry of subtree.entries()) {
    const resolved = resolvePluginDir(ctx, entry)
    if (resolved.kind === "not-a-path") {
      // Bare package names are resolved by the loader through node resolution,
      // so there is no directory to look in. Expected, not a problem.
      skipped.push(entry.id)
      continue
    }
    if (resolved.kind === "unresolvable") {
      // NOT silently skipped: this means the entry names a path we cannot turn
      // into a directory, which is a host problem rather than a plugin one.
      skipped.push(entry.id)
      ctx
        .logger?.("manifest")
        ?.warn?.(
          "%s: cannot resolve plugin directory from %s (baseUrl %s): %s",
          entry.id,
          entry.options?.name,
          ctx.baseUrl,
          resolved.reason,
        )
      continue
    }
    try {
      const manifest = await PluginManifestRegistry.readFrom(resolved.dir)
      assertIdMatchesEntrySuffix(entry.id, manifest.id)
      registry.register(entry.id, manifest)
      loaded.push(PluginManifestRegistry.keyOf(entry.id))
    } catch (error) {
      // Not fatal (design P2). Rejecting a plugin is a decision made BEFORE its
      // entry exists; by this point it is running, so the honest thing is to
      // record why it has no declaration.
      skipped.push(entry.id)
      const reason = error instanceof Error ? error.message : String(error)
      // A MISSING manifest is the normal case today (base plugins do not have
      // one yet); only a PRESENT-but-broken manifest is worth a warning, or the
      // log fills with noise and stops being read.
      if (!reason.includes("not found")) {
        ctx.logger?.("manifest")?.warn?.("%s: %s", entry.id, reason)
      }
    }
  }

  registryByCtx.set(ctx, registry)
  return { loaded, skipped }
}

type Resolved =
  | { kind: "path"; dir: string }
  /** A bare specifier (package name): node resolution, not a filesystem path. */
  | { kind: "not-a-path" }
  /** A path specifier we could not turn into a directory. */
  | { kind: "unresolvable"; reason: string }

/**
 * The plugin directory for an entry.
 *
 * The three outcomes are kept distinct on purpose. An earlier version returned
 * `undefined` for both "bare package name" and "resolution failed", which meant a
 * bad `baseUrl` silently skipped EVERY plugin and looked identical to "these
 * plugins simply have no manifest". That is the failure mode this file exists to
 * avoid, so the two cases are now reported differently.
 */
function resolvePluginDir(ctx: Context, entry: Entry): Resolved {
  const name = entry.options?.name
  if (typeof name !== "string" || name.length === 0) return { kind: "not-a-path" }
  if (!name.startsWith(".")) return { kind: "not-a-path" }
  try {
    const specifier = new URL(name, ctx.baseUrl).href
    return { kind: "path", dir: canonicalPath(dirname(fileURLToPath(specifier))) }
  } catch (error) {
    return { kind: "unresolvable", reason: error instanceof Error ? error.message : String(error) }
  }
}
/**
 * The manifest's `id` must agree with the id the yml gave the entry.
 *
 * Not a stylistic check: `id` is the identity every other layer keys on (the
 * index entry, the install directory, the tag). If a manifest could quietly
 * claim a different id than the entry it was loaded for, the registry would map
 * one plugin's declaration onto another's usage — and the mismatch would only
 * surface much later, as unexplained over-privilege warnings.
 */
function assertIdMatchesEntrySuffix(entryId: string, manifestId: string): void {
  const suffix = PluginManifestRegistry.keyOf(entryId)
  if (suffix !== manifestId) {
    throw new Error(`manifest id "${manifestId}" does not match entry id "${suffix}"`)
  }
}

// The registry is reached through a WeakMap rather than a Context property:
// `EntryOptions` has no slot for custom fields, and hanging a non-service on the
// context would make it look like a capability plugins may inject.
const registryByCtx = new WeakMap<Context, PluginManifestRegistry>()

/** The manifest registry built during bootstrap, if the host has one. */
export function manifestRegistryOf(ctx: Context): PluginManifestRegistry | undefined {
  return registryByCtx.get(ctx)
}
