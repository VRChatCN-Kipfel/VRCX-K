// M2-2 (#18) decision evidence: is `entry.id` STABLE across host runs?
//
// WHY THIS MATTERS
//   #18 says "the host builds the manifest registry keyed by `entry.id`", and
//   docs/cordis-runtime-findings.md §1.12 says the same. Separately,
//   docs/adr-plugin-layout.md persists `base-state.json` — the base plugins'
//   enable/config overrides — next to that registry.
//
//   If `entry.id` is NOT stable across runs, a PERSISTED mapping keyed by the
//   full `entry.id` breaks on every restart: the ADR and #18 would contradict
//   each other.
//
// WHAT IT MEASURES
//   1. The id of the Include entry and of every yml-authored entry, on TWO
//      fresh boots of the identical cordis.yml (explicit, human-authored ids).
//   2. Whether an explicit `id` passed to `ctx.loader.create()` survives
//      verbatim (the shape the ADR uses for host-assembled base entries).
//
// RUN: bun run docs/probes/probe11.ts

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"

type EntryRow = { name: string; id: string }

async function boot(root: string): Promise<{ includeId: string; entries: EntryRow[]; explicitId: string }> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + "/"
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include

  // EXACTLY the shape host/src/index.ts uses: no explicit id on the include entry.
  const includeId = await ctx.loader.create({
    name: "cordis:include",
    config: { path: "./cordis.yml", enableLogs: false },
  })
  const includeEntry = ctx.loader.resolve(includeId)

  // Host-assembled entry shape (ADR §4.3 step 3): an explicit id.
  const explicitId = await ctx.loader.create({
    id: "host-assembled-base",
    name: "./plugins/alpha.ts",
  })

  const entries: EntryRow[] = []
  const deadline = Date.now() + 10_000
  for (;;) {
    entries.length = 0
    const subtree = includeEntry.subtree
    if (subtree) {
      for (const entry of subtree.entries()) entries.push({ name: entry.options.name, id: entry.id })
    }
    if (entries.length >= 2 || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 25))
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { includeId, entries, explicitId }
}

let root: string | undefined
const out: Record<string, unknown> = {}
try {
  root = await mkdtemp(join(tmpdir(), "vrcxk-entryid-"))
  await mkdir(join(root, "plugins"), { recursive: true })
  await writeFile(join(root, "plugins", "alpha.ts"), `export function apply() {}\n`)
  await writeFile(join(root, "plugins", "beta.ts"), `export function apply() {}\n`)
  // Explicit, human-authored ids — exactly like host/cordis.yml (`- id: heartbeat`).
  await writeFile(
    join(root, "cordis.yml"),
    `- id: alpha\n  name: ./plugins/alpha.ts\n- id: beta\n  name: ./plugins/beta.ts\n`,
  )

  const run1 = await boot(root)
  const run2 = await boot(root)

  const shape = (r: Awaited<ReturnType<typeof boot>>) => ({
    include: r.includeId,
    ymlEntries: Object.fromEntries(r.entries.map((e) => [e.name, e.id])),
    explicit: r.explicitId,
  })
  const a = shape(run1)
  const b = shape(run2)

  /** The part after the last ":" — the human-authored / explicit segment. */
  const suffix = (id: string) => (id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id)

  out.run1 = a
  out.run2 = b
  out.fullIdStable = JSON.stringify(a) === JSON.stringify(b)
  out.suffixStable = JSON.stringify(
    Object.fromEntries(Object.entries(a.ymlEntries).map(([k, v]) => [k, suffix(String(v))])),
  ) === JSON.stringify(
    Object.fromEntries(Object.entries(b.ymlEntries).map(([k, v]) => [k, suffix(String(v))])),
  )
  out.explicitIdSurvivesVerbatim = a.explicit === "host-assembled-base" && b.explicit === "host-assembled-base"
  out.prefixEqualsIncludeId = Object.values(a.ymlEntries).every((id) =>
    String(id).startsWith(`${a.include}:`),
  )
  out.ok =
    out.fullIdStable === false && // the raw id is NOT a safe persisted key
    out.suffixStable === true && // the suffix IS
    out.explicitIdSurvivesVerbatim === true &&
    out.prefixEqualsIncludeId === true
} catch (e) {
  out.ok = false
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
} finally {
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(JSON.stringify(out, null, 2))
if (out.ok !== true) process.exitCode = 1
