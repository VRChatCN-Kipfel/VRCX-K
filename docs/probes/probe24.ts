/**
 * Can a host ship base plugins as PATCHES instead of a second state file?
 *
 * The question this answers: if the host supplies `config.patches`, do base
 * entries appear, do `disabled`/`config` overrides take effect, and — the part
 * that decides whether `base-state.json` can be deleted — does the write-back
 * BAKE the patched entries into cordis.yml?
 *
 * Source facts that motivate each check:
 *   - PatchOptions (plugin-include/lib/index.d.ts:3-14) declares
 *     insert / config / disabled / group / name, so multi-source patching is
 *     supported by the type, and `patches` is an ARRAY (Config.patches).
 *   - Include.write() (index.js:179-182) writes `this.root.data` — the tree
 *     AFTER applyPatches ran — so if a write happens, patched entries can land
 *     in the file.
 *   - Loader's internal/plugin handler (plugin-loader) sets
 *     `entry.options.disabled = true` and writes back on fiber dispose, i.e.
 *     write-back happens on ordinary shutdown too, not only on user edits.
 *
 * Run: bun run docs/probes/probe24.ts
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"

const out: Record<string, unknown> = {}
const root = await mkdtemp(join(tmpdir(), "vrcxk-probe24-"))

/** A plugin that records whether it loaded, so we can see disabling work. */
const PLUGIN_SRC = `
export function apply(ctx) {
  ctx.provide("probe24", { loaded: true })
}
`

async function scenario(
  label: string,
  opts: { yml: string; patches?: unknown[]; extraFiles?: Record<string, string> },
): Promise<{ ok: boolean; error?: string; entries?: unknown[]; ymlAfter?: string; servicePresent?: boolean }> {
  const dir = join(root, label.replace(/[^a-z0-9]+/gi, "-"))
  await mkdir(join(dir, "plugins"), { recursive: true })
  await writeFile(join(dir, "plugins", "probe.ts"), PLUGIN_SRC)
  await writeFile(join(dir, "cordis.yml"), opts.yml)
  for (const [rel, body] of Object.entries(opts.extraFiles ?? {})) {
    await writeFile(join(dir, rel), body)
  }

  const ctx = new Context()
  ctx.baseUrl = new URL(`file://${dir.replace(/\\/g, "/")}/`).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include

  try {
    const includeId = await ctx.loader.create({
      name: "cordis:include",
      config: { path: "./cordis.yml", enableLogs: false, patches: opts.patches as never },
    })
    const entry = ctx.loader.resolve(includeId)

    // Wait for entries to appear and settle.
    const deadline = Date.now() + 5_000
    let entries: Array<{ id: string; name?: string; disabled?: boolean; config?: unknown }> = []
    for (;;) {
      entries = [...(entry.subtree?.entries() ?? [])].map((e) => ({
        id: e.id,
        name: (e.options as { name?: string })?.name,
        disabled: (e.options as { disabled?: boolean })?.disabled,
        config: (e.options as { config?: unknown })?.config,
      }))
      if (entries.length > 0 || Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 25))
    }

    // Force a write-back the way a shutdown would, then look at the file.
    const include = entry.subtree as unknown as { write?: () => void }
    include.write?.()
    await new Promise((r) => setTimeout(r, 300)) // write() goes through setTimeout(0)

    const ymlAfter = await readFile(join(dir, "cordis.yml"), "utf8")
    return { ok: true, entries, ymlAfter, servicePresent: ctx.get("probe24") != null }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  } finally {
    try {
      await ctx.stop?.()
    } catch {}
  }
}

// ── 1. Baseline: a plain yml entry ────────────────────────────────────────
out["1-plain-entry"] = await scenario("1-plain", {
  yml: `- id: probe\n  name: ./plugins/probe.ts\n`,
})

// ── 2. Does a host-supplied patch INSERT an entry the yml never had? ──────
// This is the "base plugins come from the host, not the user's yml" case.
out["2-patch-insert"] = await scenario("2-insert", {
  yml: `[]\n`,
  patches: [{ id: "seed", insert: [{ id: "probe", name: "./plugins/probe.ts" }] }],
})

// ── 3. Does a patch DISABLE an entry that the yml declares? ───────────────
out["3-patch-disable"] = await scenario("3-disable", {
  yml: `- id: probe\n  name: ./plugins/probe.ts\n`,
  patches: [{ id: "probe", disabled: true }],
})

// ── 4. Does a patch OVERRIDE config? ─────────────────────────────────────
out["4-patch-config"] = await scenario("4-config", {
  yml: `- id: probe\n  name: ./plugins/probe.ts\n  config:\n    value: from-yml\n`,
  patches: [{ id: "probe", config: { value: "from-patch" } }],
})

console.log(JSON.stringify(out, null, 2))

// ── The decisive question ────────────────────────────────────────────────
const inserted = out["2-patch-insert"] as { entries?: Array<{ id: string }>; ymlAfter?: string }
const baked = inserted?.ymlAfter?.includes("probe") ?? false
console.log("\n=== DECISIVE ===")
console.log("  patch-insert produced the entry :", (inserted?.entries?.length ?? 0) > 0)
console.log("  entry was BAKED into cordis.yml :", baked)
console.log(
  baked
    ? "  => write-back bakes patches; a pure patch file would drift into cordis.yml"
    : "  => patches do NOT reach the file; cordis.yml stays as the user wrote it",
)

await rm(root, { recursive: true, force: true })
