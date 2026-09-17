/**
 * The manifest registry must actually be WIRED, not merely implemented.
 *
 * The registry and its contract were already tested, but nothing proved the host
 * reads declarations for the plugins in its own include tree. This closes that
 * gap: it boots the real `loadManifests` against a temp host root and asserts
 * what got registered, keyed by the STABLE part of each entry id.
 */
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context } from "cordis"
import Loader from "@cordisjs/plugin-loader"
import Include from "@cordisjs/plugin-include"
import { loadManifests } from "../src/manifests"
import { PluginManifestRegistry } from "../src/contracts/pluginRegistry"

type Fixture = {
  root: string
  /** Every entry in the tree — needed because the entries only exist after boot. */
  entries: () => Iterable<import("@cordisjs/plugin-loader").Entry>
  dispose: () => Promise<void>
}

async function bootWith(yml: string, files: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-manifests-"))
  await mkdir(join(root, "plugins"), { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, body)
  }
  await writeFile(join(root, "cordis.yml"), yml)

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + "/"
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const includeId = await ctx.loader.create({
    name: "cordis:include",
    config: { path: "./cordis.yml", enableLogs: false },
  })
  const includeEntry = ctx.loader.resolve(includeId)
  const subtree = includeEntry.subtree!

  // The entries do not exist until the include tree settles — the real host
  // waits in `waitForIncludeReady` before calling us. Without this the iteration
  // is empty and every case would look like "nothing to do".
  const deadline = Date.now() + 8_000
  for (;;) {
    if ([...subtree.entries()].length > 0 || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 25))
  }

  return {
    root,
    entries: () => subtree.entries(),
    dispose: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: "with-manifest", version: "1.0.0", author: "a", name: "N", ...over })

describe("loadManifests wiring", () => {
  test("registers a plugin that declares a manifest, keyed by the entry-id SUFFIX", async () => {
    const f = await bootWith(
      `- id: with-manifest\n  name: ./plugins/with-manifest.ts\n`,
      {
        "plugins/with-manifest.ts": `export function apply() {}\n`,
        "plugins/.vrcxk/manifest.json": "{}", // unused, keeps the dir creation obvious
      },
    )
    try {
      // The manifest lives beside the plugin FILE's directory, i.e. plugins/.
      const manifestPath = join(f.root, "plugins", ".vrcxk", "manifest.json")
      await writeFile(manifestPath, manifest())
      expect(await Bun.file(manifestPath).exists()).toBe(true)

      const ctx = new Context()
      // The real host sets baseUrl to a file URL of its cwd (index.ts). A bare
      // Context has no usable baseUrl, and discovering that is what made this
      // test fail before `resolvePluginDir` reported the two cases separately.
      ctx.baseUrl = pathToFileURL(f.root).href + "/"
      const result = await loadManifests(ctx, { subtree: { entries: f.entries } } as never)

      expect(result.skipped).toEqual([])
      expect(result.loaded).toEqual(["with-manifest"])
      const registry = (await import("../src/manifests")).manifestRegistryOf(ctx)!
      expect(registry).toBeInstanceOf(PluginManifestRegistry)
      // Reachable through ANY run's prefix, because the key is the suffix.
      expect(registry.get("deadbeef:with-manifest")?.id).toBe("with-manifest")
    } finally {
      await f.dispose()
    }
  }, 30_000)

  test("a plugin WITHOUT a manifest is skipped, not fatal", async () => {
    const f = await bootWith(`- id: bare\n  name: ./plugins/bare.ts\n`, {
      "plugins/bare.ts": `export function apply() {}\n`,
    })
    try {
      const ctx = new Context()
      ctx.baseUrl = pathToFileURL(f.root).href + "/"
      const result = await loadManifests(ctx, { subtree: { entries: f.entries } } as never)
      // Absent declaration simply means nothing to compare against (design P2);
      // refusing to load is a decision made BEFORE the entry exists.
      expect(result.loaded).toEqual([])
      expect(result.skipped.length).toBe(1)
    } finally {
      await f.dispose()
    }
  }, 30_000)

  test("a manifest whose id disagrees with the entry is REJECTED", async () => {
    const f = await bootWith(`- id: real-id\n  name: ./plugins/real-id.ts\n`, {
      "plugins/real-id.ts": `export function apply() {}\n`,
      "plugins/.vrcxk/manifest.json": "{}",
    })
    try {
      // id is the identity every other layer keys on. If a manifest could claim
      // a different id than its entry, one plugin's declaration would be applied
      // to another's usage — surfacing much later as unexplained warnings.
      await writeFile(join(f.root, "plugins", ".vrcxk", "manifest.json"), manifest({ id: "some-other-id" }))
      const ctx = new Context()
      ctx.baseUrl = pathToFileURL(f.root).href + "/"
      const result = await loadManifests(ctx, { subtree: { entries: f.entries } } as never)
      expect(result.loaded).toEqual([])
      expect(result.skipped.length).toBe(1)
    } finally {
      await f.dispose()
    }
  }, 30_000)

  test("a MALFORMED manifest is skipped rather than crashing the host", async () => {
    const f = await bootWith(`- id: with-manifest\n  name: ./plugins/with-manifest.ts\n`, {
      "plugins/with-manifest.ts": `export function apply() {}\n`,
      "plugins/.vrcxk/manifest.json": "{}",
    })
    try {
      await writeFile(join(f.root, "plugins", ".vrcxk", "manifest.json"), manifest({ version: "not-a-version" }))
      const ctx = new Context()
      ctx.baseUrl = pathToFileURL(f.root).href + "/"
      const result = await loadManifests(ctx, { subtree: { entries: f.entries } } as never)
      expect(result.loaded).toEqual([])
      expect(result.skipped.length).toBe(1)
    } finally {
      await f.dispose()
    }
  }, 30_000)

  test("no subtree means nothing to do", async () => {
    // No fixture here: the point is that a context without an include subtree is
    // handled without touching the filesystem at all.
    const ctx = new Context()
    const result = await loadManifests(ctx, {} as never)
    expect(result).toEqual({ loaded: [], skipped: [] })
  })
})
