// M2-1 follow-up (review round 2): under a REAL Loader + Include, what identity
// does a capability call carry, and which naming strategy keeps callers distinct?
//
// Three strategies are compared on the same fixture:
//   R1  fiber.name                       — walks the parent chain; an apply-only
//                                          plugin resolves to the enclosing Include.
//   R2  entry.id                         — the installable unit (M2-8 registry key),
//                                          but a nested `ctx.plugin()` INHERITS it.
//   C   entry.id#fiber.runtime.name      — keeps nested plugins distinguishable
//                                          while entry.id stays the prefix.
//
// It also records that `entry.id` carries a per-run random prefix
// (plugin-loader/lib/index.js:176), so log consumers must treat the prefix as
// opaque and match on the suffix.
//
// Self-contained: builds its own fixture and removes it.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context, Service, symbols } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"

type Row = {
  label: string
  r1_fiberName: string | null
  r2_entryId: string | null
  ownRuntimeName: string | null
  composite: string | null
}

const out: Record<string, unknown> = {}
const rows: Row[] = []

class Recorder extends Service {
  constructor(c: any) {
    super(c, "recorder")
  }
  record(label: string) {
    const self: any = this
    const fiber: any = self[symbols.caller]?.fiber
    const entryId: string | null = fiber?.entry?.id ?? null
    const ownRuntimeName: string | null = fiber?.runtime?.name ?? null
    const r1 = fiber?.name ?? null
    const r2 = entryId ?? fiber?.name ?? null
    const composite = entryId
      ? ownRuntimeName
        ? `${entryId}#${ownRuntimeName}`
        : entryId
      : (fiber?.name ?? null)
    rows.push({ label, r1_fiberName: r1, r2_entryId: r2, ownRuntimeName, composite })
    return composite
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-probe8-"))
  await mkdir(join(root, "plugins"), { recursive: true })
  // Two apply-only entries; `alpha` also starts two DIFFERENT nested bare plugins.
  await writeFile(
    join(root, "plugins", "alpha.ts"),
    `export function apply(ctx: any) {
  void ctx.recorder.record("alpha")
  void ctx.plugin(function nestedOne(inner: any) { void inner.recorder.record("nestedOne") })
  void ctx.plugin(function nestedTwo(inner: any) { void inner.recorder.record("nestedTwo") })
}
`,
  )
  await writeFile(
    join(root, "plugins", "beta.ts"),
    `export function apply(ctx: any) { void ctx.recorder.record("beta") }\n`,
  )
  await writeFile(
    join(root, "cordis.yml"),
    `- id: alpha\n  name: ./plugins/alpha.ts\n- id: beta\n  name: ./plugins/beta.ts\n`,
  )

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + "/"
  new Recorder(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: "cordis:include", config: { path: "./cordis.yml", enableLogs: false } })

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && rows.length < 4) await new Promise((r) => setTimeout(r, 25))
  await new Promise((r) => setTimeout(r, 50))

  const distinct = (key: keyof Row) => new Set(rows.map((r) => r[key])).size
  out.rows = rows
  out.distinct = {
    r1_fiberName: distinct("r1_fiberName"),
    r2_entryId: distinct("r2_entryId"),
    composite: distinct("composite"),
  }
  out.r1_collapsesToInclude = rows.some((r) => r.r1_fiberName === "Include")
  out.r2_nestedCollapse = rows.filter((r) => r.label.startsWith("nested")).every(
    (r) => r.r2_entryId === rows.find((x) => x.label === "alpha")?.r2_entryId,
  )
  out.composite_nestedDistinct = new Set(
    rows.filter((r) => r.label.startsWith("nested")).map((r) => r.composite),
  ).size
  out.entryIdRandomPrefix = rows
    .map((r) => r.r2_entryId)
    .filter(Boolean)
    .every((id) => /^[0-9a-f]+:/.test(String(id)))

  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify(out, null, 2))
}

await main()
