/**
 * Two questions the previous patch probes left open.
 *
 * A. `insert` then override IN THE SAME patches array.
 *    Source (plugin-include/lib/index.js:83-93) builds `entryMap` ONCE before the
 *    loop and never rebuilds it, so an entry added by `insert` cannot be found by
 *    a later patch in the same batch. probe27 appeared to confirm this, but its
 *    plugin had an unrelated bug (reading ctx.config without inject) that made the
 *    result ambiguous. This isolates the ordering question with a plugin that
 *    cannot fail for other reasons.
 *
 * B. Does a baked cordis.yml cause DUPLICATION on the next boot?
 *    probe26 showed write() bakes inserted entries into cordis.yml. probe27 booted
 *    twice and saw no duplication, which is the difference between "cosmetic
 *    pollution" and "the scheme is broken". Re-confirm deliberately, and look at
 *    what the second boot's tree actually contains.
 *
 * Run: bun run docs/probes/probe28.ts
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"

const root = await mkdtemp(join(tmpdir(), "vrcxk-probe28-"))
const out: Record<string, unknown> = {}

/**
 * Pure-JS plugin factory: a closure over the value, so nothing depends on
 * `ctx.config` being readable (the bug that muddied probe27).
 */
function makePluginFile(svc: string, marker: string): string {
  return `
export const marker = ${JSON.stringify(marker)}
export function apply(ctx) {
  ctx.provide(${JSON.stringify(svc)}, { marker: ${JSON.stringify(marker)} })
}
`
}

async function boot(dir: string, patches: unknown[], write: boolean) {
  const ctx = new Context()
  ctx.baseUrl = new URL(`file://${dir.replace(/\\/g, "/")}/`).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include

  const id = await ctx.loader.create({
    name: "cordis:include",
    config: { path: "./cordis.yml", enableLogs: false, patches: patches as never },
  })
  const entry = ctx.loader.resolve(id)

  const deadline = Date.now() + 4_000
  let entries: string[] = []
  for (;;) {
    entries = [...(entry.subtree?.entries() ?? [])].map((e) => e.id.split(":").pop() ?? e.id)
    if (entries.length > 0 || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 25))
  }

  const svc = ctx.get("svc") as { marker?: string } | undefined

  if (write) {
    ;(entry.subtree as unknown as { write?: () => void }).write?.()
    await new Promise((r) => setTimeout(r, 400))
  }

  return { entries, marker: svc?.marker ?? null, yml: await readFile(join(dir, "cordis.yml"), "utf8") }
}

// ── A. insert followed by an override of the SAME id, one batch ───────────
{
  const dir = join(root, "A")
  await mkdir(join(dir, "plugins"), { recursive: true })
  await writeFile(join(dir, "plugins", "v1.ts"), makePluginFile("svc", "v1"))
  await writeFile(join(dir, "plugins", "v2.ts"), makePluginFile("svc", "v2"))
  await writeFile(join(dir, "cordis.yml"), "[]\n")

  // Insert v1, then try to override the inserted entry to point at v2.
  const r = await boot(
    dir,
    [{ insert: [{ id: "base", name: "./plugins/v1.ts" }] }, { id: "base", name: "./plugins/v2.ts" }],
    false,
  )
  out["A-insert-then-override"] = r
}

// ── A2. Control: two separate boots, override in the SECOND batch ────────
// If the entry already exists in cordis.yml, a later batch CAN override it.
{
  const dir = join(root, "A2")
  await mkdir(join(dir, "plugins"), { recursive: true })
  await writeFile(join(dir, "plugins", "v1.ts"), makePluginFile("svc", "v1"))
  await writeFile(join(dir, "plugins", "v2.ts"), makePluginFile("svc", "v2"))
  await writeFile(join(dir, "cordis.yml"), "- id: base\n  name: ./plugins/v1.ts\n")

  const r = await boot(dir, [{ id: "base", name: "./plugins/v2.ts" }], false)
  out["A2-existing-then-override"] = r
}

// ── B. bake, then boot again from the baked file ─────────────────────────
{
  const dir = join(root, "B")
  await mkdir(join(dir, "plugins"), { recursive: true })
  await writeFile(join(dir, "plugins", "base.ts"), makePluginFile("svc", "base"))
  await writeFile(join(dir, "cordis.yml"), "[]\n")

  const patches = [{ insert: [{ id: "base", name: "./plugins/base.ts" }] }]
  const first = await boot(dir, patches, true) // force the write-back
  const second = await boot(dir, patches, false) // same patches, baked yml
  out["B-boot1"] = first
  out["B-boot2"] = second
}

console.log(JSON.stringify(out, null, 2))

console.log("\n=== VERDICT ===")
const a = out["A-insert-then-override"] as { marker: string | null; entries: string[] }
const a2 = out["A2-existing-then-override"] as { marker: string | null }
const b1 = out["B-boot1"] as { entries: string[]; yml: string }
const b2 = out["B-boot2"] as { entries: string[] }

console.log(
  `A  insert+override in ONE batch -> marker=${a.marker}`,
  a.marker === "v2" ? "(later patch DID win)" : "(later patch did NOT apply — entryMap is stale)",
)
console.log(
  `A2 override an EXISTING entry   -> marker=${a2.marker}`,
  a2.marker === "v2" ? "(override works on pre-existing entries)" : "(unexpected)",
)
console.log(`B  boot1 yml baked              : ${b1.yml.includes("base")}`)
console.log(
  `B  boot2 entries                : ${JSON.stringify(b2.entries)}`,
  b2.entries.length === 1 ? "(no duplication on reboot)" : "(DUPLICATED)",
)

await rm(root, { recursive: true, force: true })
