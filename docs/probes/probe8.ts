// M2-1 follow-up (review round 3): which nested-plugin SHAPES actually get an
// identity suffix, and what does a root-level bare plugin look like?
//
// Round-2 claimed "entry.id#runtime.name keeps nested plugins distinct". That is
// only true when the fiber has its own `runtime.name` — a NAMED FUNCTION
// expression. An anonymous arrow, an object literal `{ apply() {} }`, and an
// apply-only module namespace all have no `runtime.name`, so they fall back to
// the bare `entry.id` and collapse onto their enclosing entry.
//
// It also checks the root-level bare plugin: the loader sets `entry` from
// `fiber.parent[Entry.key]`, so a plugin started on the root Context has NO
// entry even while a loader is live, and an anonymous one audits as "root" —
// the same identity a real host call resolves to.
//
// Self-contained: builds its own fixture and removes it. Errors are captured
// (never a success-shaped JSON on failure).
//
// Three strategies are compared on the same fixtures:
//   R1  fiber.name
//   R2  entry.id ?? fiber.name
//   C   entry.id#fiber.runtime.name   (M2-1's callerName)

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context, Service, symbols } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"

type Row = {
  scope: string
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
  record(scope: string, label: string) {
    const self: any = this
    const fiber: any = self[symbols.caller]?.fiber
    const entryId: string | null = fiber?.entry?.id ?? null
    const ownRuntimeName: unknown = fiber?.runtime?.name
    const r1 = fiber?.name ?? null
    const r2 = entryId ?? fiber?.name ?? null
    const composite = entryId
      ? ownRuntimeName
        ? `${entryId}#${String(ownRuntimeName)}`
        : entryId
      : (fiber?.name ?? null)
    rows.push({
      scope,
      label,
      r1_fiberName: r1,
      r2_entryId: r2,
      ownRuntimeName: ownRuntimeName === undefined ? null : String(ownRuntimeName),
      composite: composite === null ? null : String(composite),
    })
    return composite
  }
}

function distinct(key: keyof Row, scope: string) {
  const scoped = rows.filter((r) => r.scope === scope)
  return { calls: scoped.length, distinct: new Set(scoped.map((r) => r[key])).size }
}

async function main() {
  const fixtures: Array<[string, string]> = [
    // One entry that starts four DIFFERENT nested shapes.
    [
      "shapes.ts",
      `export function apply(ctx: any) {
  void ctx.recorder.record("entry", "entryOwn")
  void ctx.plugin(function namedFn(inner: any) { void inner.recorder.record("entry", "namedFn") })
  void ctx.plugin((inner: any) => { void inner.recorder.record("entry", "anonArrow") })
  void ctx.plugin({ apply(inner: any) { void inner.recorder.record("entry", "objectLiteral") } })
  void ctx.plugin(function explicitNamed(inner: any) { void inner.recorder.record("entry", "explicitNamed") })
}
`,
    ],
    ["beta.ts", `export function apply(ctx: any) { void ctx.recorder.record("entry", "beta") }\n`],
  ]

  let root: string | undefined
  try {
    root = await mkdtemp(join(tmpdir(), "vrcxk-probe8-"))
    await mkdir(join(root, "plugins"), { recursive: true })
    for (const [name, body] of fixtures) await writeFile(join(root, "plugins", name), body)
    await writeFile(
      join(root, "cordis.yml"),
      `- id: shapes\n  name: ./plugins/shapes.ts\n- id: beta\n  name: ./plugins/beta.ts\n`,
    )

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + "/"
    new Recorder(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({
      name: "cordis:include",
      config: { path: "./cordis.yml", enableLogs: false },
    })

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && rows.filter((r) => r.scope === "entry").length < 6) {
      await new Promise((r) => setTimeout(r, 25))
    }

    // Root-level bare plugins: the root Context has no `Entry.key`, so these get
    // no entry even though the loader is live.
    await ctx.plugin(function namedRootBare(inner: any) {
      void inner.recorder.record("root", "namedRootBare")
    })
    await ctx.plugin((inner: any) => {
      void inner.recorder.record("root", "anonRootBare")
    })
    await new Promise((r) => setTimeout(r, 50))

    const byLabel = (label: string) => rows.find((r) => r.scope === "entry" && r.label === label)
    const shapeIds = ["entryOwn", "anonArrow", "objectLiteral"]
      .map((label) => byLabel(label)?.composite)
      .filter((id): id is string => typeof id === "string")
    const compositeDistinct = distinct("composite", "entry").distinct
    const rootNamed = rows.find((r) => r.label === "namedRootBare")
    const rootAnon = rows.find((r) => r.label === "anonRootBare")

    out.rows = rows
    out.entryCallers = rows.filter((r) => r.scope === "entry").length
    out.distinct = {
      r1_fiberName: distinct("r1_fiberName", "entry").distinct,
      r2_entryId: distinct("r2_entryId", "entry").distinct,
      composite: compositeDistinct,
    }
    out.suffixOnlyForNamedFn = {
      namedFn: byLabel("namedFn")?.ownRuntimeName ?? null,
      explicitNamed: byLabel("explicitNamed")?.ownRuntimeName ?? null,
      anonArrow: byLabel("anonArrow")?.ownRuntimeName ?? null,
      objectLiteral: byLabel("objectLiteral")?.ownRuntimeName ?? null,
      entryOwn: byLabel("entryOwn")?.ownRuntimeName ?? null,
    }
    // The three shapeless callers collapse onto the bare enclosing entry id.
    out.shapelessCollapse = { ids: shapeIds, distinct: new Set(shapeIds).size }
    out.rootBare = {
      named: { entryId: rootNamed?.r2_entryId ?? null, identity: rootNamed?.composite ?? null },
      anonymous: { entryId: rootAnon?.r2_entryId ?? null, identity: rootAnon?.composite ?? null },
      collidesWithHostIdentity: rootAnon?.composite === "root",
    }
    out.ok =
      out.entryCallers === 6 &&
      compositeDistinct === 4 && // entryOwn, namedFn, explicitNamed, beta
      new Set(shapeIds).size === 1 && // entryOwn + anonArrow + objectLiteral collapse
      byLabel("namedFn")?.composite === `${byLabel("entryOwn")?.composite}#namedFn` &&
      rootNamed?.composite === "namedRootBare" &&
      rootAnon?.composite === "root"
  } catch (e) {
    out.ok = false
    out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  } finally {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
  }

  console.log(JSON.stringify(out, null, 2))
  if (out.ok !== true) process.exitCode = 1
}

await main()
