// M2-2 (#18) decision evidence: is the cordis EntryTree FLAT, and do nested
// `ctx.plugin()` children get their OWN entry (hence their own manifest)?
//
// This is the crux of the "sub-plugin entry list" question:
//   - if `ctx.plugin()` children get their own entries  -> option B is possible
//   - if they INHERIT the enclosing entry               -> they are internal
//     implementation details, and a manifest-per-sub-plugin makes no sense
//
// Also establishes whether `group: true` entries form a real nested tree.
//
// RUN: bun run docs/probes/probe19.ts

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"

const out: Record<string, unknown> = {}
let root: string | undefined

const NESTED = `
export function apply(ctx: any) {
  const snap = (c: any) => ({
    entryId: c.fiber?.entry?.id ?? null,
    fiberName: c.fiber?.name ?? null,
  })
  ;(globalThis as any).__p19_entryOwn = snap(ctx)
  ctx.plugin(function namedSub(inner: any) { ;(globalThis as any).__p19_namedSub = snap(inner) })
  ctx.plugin((inner: any) => { ;(globalThis as any).__p19_anonArrow = snap(inner) })
  ctx.plugin({ apply(inner: any) { ;(globalThis as any).__p19_objectLiteral = snap(inner) } })
}
`

try {
  root = await mkdtemp(join(tmpdir(), "vrcxk-entries-"))
  await mkdir(join(root, "plugins"), { recursive: true })
  const files: Array<[string, string]> = [
    ["standalone.ts", `export function apply() {}\n`],
    ["child-a.ts", `export function apply() {}\n`],
    ["child-b.ts", `export function apply() {}\n`],
    ["nested.ts", NESTED],
  ]
  for (const [name, body] of files) await writeFile(join(root, "plugins", name), body)

  await writeFile(
    join(root, "cordis.yml"),
    [
      `- id: standalone`,
      `  name: ./plugins/standalone.ts`,
      `- id: mygroup`,
      `  group: true`,
      `  config:`,
      `    - id: child-a`,
      `      name: ./plugins/child-a.ts`,
      `    - id: child-b`,
      `      name: ./plugins/child-b.ts`,
      `- id: nested`,
      `  name: ./plugins/nested.ts`,
      ``,
    ].join("\n"),
  )

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + "/"
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const includeId = await ctx.loader.create({
    name: "cordis:include",
    config: { path: "./cordis.yml", enableLogs: false },
  })
  const includeEntry = ctx.loader.resolve(includeId)
  await new Promise((r) => setTimeout(r, 1500))

  // ── Flat view: every entry the loader knows, regardless of nesting.
  const store = (ctx.loader as unknown as { store?: Record<string, unknown> }).store ?? {}
  out.flatStore = Object.entries(store).map(([key, value]) => {
    const e = value as {
      id: string
      options?: { name?: string; group?: unknown }
      subgroup?: unknown
    }
    return {
      storeKey: key,
      id: e.id,
      name: e.options?.name,
      isGroup: Boolean(e.options?.group),
      hasSubgroup: e.subgroup !== undefined,
    }
  })

  // ── Tree view from the include entry.
  const rows: unknown[] = []
  const walk = (entry: unknown, depth: number) => {
    const e = entry as {
      id: string
      options?: { name?: string; group?: unknown }
      subgroup?: { data?: unknown[] }
      subtree?: { entries(): Generator<unknown> }
    }
    rows.push({
      depth,
      id: e.id,
      name: e.options?.name,
      isGroup: Boolean(e.options?.group),
      subgroupItems: e.subgroup?.data?.length ?? null,
    })
    const sub = e.subtree
    if (sub && typeof sub.entries === "function") {
      for (const child of sub.entries()) walk(child, depth + 1)
    }
  }
  const top = includeEntry.subtree
  if (top) for (const e of top.entries()) walk(e, 0)
  out.tree = rows

  // ── The nested `ctx.plugin()` children: do they own an entry id?
  const g = globalThis as Record<string, unknown>
  const nestedOwn = {
    entryOwn: g.__p19_entryOwn ?? null,
    namedSub: g.__p19_namedSub ?? null,
    anonArrow: g.__p19_anonArrow ?? null,
    objectLiteral: g.__p19_objectLiteral ?? null,
  }
  out.nestedOwn = nestedOwn

  // ── The load-bearing comparison.
  const parent = (nestedOwn.entryOwn as { entryId?: string } | null)?.entryId ?? null
  const subs = ["namedSub", "anonArrow", "objectLiteral"].map(
    (k) => ((nestedOwn as Record<string, { entryId?: string } | null>)[k]?.entryId ?? null),
  )
  out.inheritsParentEntry = subs.every((s) => s !== null && s === parent)
  out.subPluginsHaveOwnEntryId = subs.some((s) => s !== null && s !== parent)

  out.ok = true
} catch (e) {
  out.ok = false
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
} finally {
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(JSON.stringify(out, null, 2))
if (out.ok !== true) process.exitCode = 1
