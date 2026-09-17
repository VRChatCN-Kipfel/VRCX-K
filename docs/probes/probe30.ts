/**
 * Plan B, take two — probe29 was invalid for the load questions because its
 * plugins read `ctx.config` without `inject`, which throws
 * ("cannot get property 'config' without inject"). Every plugin failed, so
 * `services: {}` proved nothing. (Its write-back result WAS valid: it does not
 * depend on plugins loading.)
 *
 * This version:
 *   - uses plugins that cannot throw (no ctx.config; marker comes from the file)
 *   - waits for the group's OWN context before walking children
 *   - inspects `entry.subgroup` directly, so "no children" is distinguishable
 *     from "my walk never reached them"
 *
 * Questions:
 *   Q1 Are group children their OWN entries (own entry.id), or do they inherit
 *      the group's entry the way `ctx.plugin()` children do (probe19)?
 *   Q2 Can one child be disabled without the sibling?
 *   Q3 Can one child carry its own config?
 *   Q4 Does disabling the GROUP disable all children?
 *   Q5 Does write() bake host-inserted groups into cordis.yml? (probe29 said yes;
 *      re-confirm now that the probe is otherwise sound, because this decides
 *      whether plan B also pollutes the user's file.)
 *
 * Run: bun run docs/probes/probe30.ts
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"
import { Group } from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"

const root = await mkdtemp(join(tmpdir(), "vrcxk-probe30-"))
const out: Record<string, unknown> = {}

/** Marker baked into the file; nothing is read from ctx, so apply() cannot throw. */
const plugin = (svc: string, marker: string) => `
export function apply(ctx) {
  ctx.provide(${JSON.stringify(svc)}, { marker: ${JSON.stringify(marker)} })
}
`

async function scenario(label: string, yml: string, patches: unknown[], write: boolean) {
  const dir = join(root, label)
  await mkdir(join(dir, "plugins"), { recursive: true })
  await writeFile(join(dir, "plugins", "a.ts"), plugin("svcA", "a"))
  await writeFile(join(dir, "plugins", "b.ts"), plugin("svcB", "b"))
  await writeFile(join(dir, "cordis.yml"), yml)

  const ctx = new Context()
  ctx.baseUrl = new URL(`file://${dir.replace(/\\/g, "/")}/`).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // A `group: true` entry resolves to the `cordis:group` builtin. probe29/30's
  // first runs omitted this, so the group never materialised and every
  // "children == []" reading was a probe bug, not a framework fact.
  ctx.loader.builtins.group = Group

  try {
    const id = await ctx.loader.create({
      name: "cordis:include",
      config: { path: "./cordis.yml", enableLogs: false, patches: patches as never },
    })
    const includeEntry = ctx.loader.resolve(id)

    // Give the tree time to build the group AND its subgroup.
    const deadline = Date.now() + 6_000
    let topLevel: string[] = []
    for (;;) {
      topLevel = [...(includeEntry.subtree?.entries() ?? [])].map((e) => e.id.split(":").pop() ?? e.id)
      if (topLevel.length > 0 || Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 25))
    }
    await new Promise((r) => setTimeout(r, 800)) // let subgroups attach

    // Walk the tree directly instead of resolving by short id: the real id
    // carries Include's per-run random prefix, so `resolve("base")` cannot work.
    const groupEntry = [...(includeEntry.subtree?.entries() ?? [])].find(
      (e) => (e as { subgroup?: unknown }).subgroup !== undefined || (e.options as { name?: string })?.name === "cordis:group",
    ) as EntryLike | undefined

    type EntryLike = {
      id: string
      options?: { group?: boolean; disabled?: boolean; config?: unknown }
      subgroup?: { data?: unknown[]; tree?: { resolve(id: string): EntryLike } }
      fiber?: { state?: number; uid?: unknown }
    }

    const describe = (e: EntryLike) => ({
      id: e.id,
      shortId: e.id.split(":").pop() ?? e.id,
      group: e.options?.group,
      disabled: e.options?.disabled,
      config: e.options?.config,
      hasSubgroup: !!e.subgroup,
      fiberState: e.fiber?.state,
    })

    let children: unknown[] = []
    let subgroupPresent = false
    if (groupEntry?.subgroup) {
      subgroupPresent = true
      // EntryGroup exposes `data` (EntryOptions[]) and `tree`, NOT entries().
      const sg = groupEntry.subgroup
      const ids = (sg.data ?? []).map((o) => (o as { id?: string }).id).filter(Boolean) as string[]
      children = ids.map((cid) => {
        try {
          return describe(groupEntry.subgroup!.tree!.resolve(cid))
        } catch {
          return { id: `(unresolved) ${cid}`, shortId: cid }
        }
      })
    }

    const services: Record<string, { marker?: string }> = {}
    for (const n of ["svcA", "svcB"]) {
      const v = ctx.get(n) as { marker?: string } | undefined
      if (v != null) services[n] = v
    }

    const ymlBefore = await readFile(join(dir, "cordis.yml"), "utf8")
    if (write) {
      ;(includeEntry.subtree as unknown as { write?: () => void }).write?.()
      await new Promise((r) => setTimeout(r, 400))
    }
    const ymlAfter = await readFile(join(dir, "cordis.yml"), "utf8").catch(() => "(none)")

    out[label] = {
      topLevel,
      groupEntry: groupEntry ? describe(groupEntry) : null,
      subgroupPresent,
      children,
      services,
      ymlBefore,
      ymlAfter,
    }
  } catch (error) {
    out[label] = { error: (error as Error).message }
  }
}

// 1. Group in the yml, two children, all enabled.
await scenario(
  "1-group-two-children",
  `- id: base\n  name: cordis:group\n  config:\n    - id: a\n      name: ./plugins/a.ts\n    - id: b\n      name: ./plugins/b.ts\n`,
  [],
  false,
)

// 2. One child disabled; sibling untouched. Does only svcA load?
await scenario(
  "2-child-b-disabled",
  `- id: base\n  name: cordis:group\n  config:\n    - id: a\n      name: ./plugins/a.ts\n    - id: b\n      name: ./plugins/b.ts\n      disabled: true\n`,
  [],
  false,
)

// 3. THE assertion probe29 could not make: whole group disabled.
await scenario(
  "3-group-disabled",
  `- id: base\n  name: cordis:group\n  disabled: true\n  config:\n    - id: a\n      name: ./plugins/a.ts\n    - id: b\n      name: ./plugins/b.ts\n`,
  [],
  false,
)

// 4. Host inserts the group via patch, then a write-back happens.
await scenario(
  "4-host-inserted-group-then-write",
  "[]\n",
  [
    {
      insert: [
        {
          id: "base",
          name: "cordis:group",
          config: [
            { id: "a", name: "./plugins/a.ts" },
            { id: "b", name: "./plugins/b.ts" },
          ],
        },
      ],
    },
  ],
  true,
)

console.log(JSON.stringify(out, null, 2))

console.log("\n=== VERDICT ===")
for (const [label, raw] of Object.entries(out)) {
  const r = raw as {
    services?: Record<string, unknown>
    children?: Array<{ shortId: string; id: string }>
    subgroupPresent?: boolean
    ymlAfter?: string
    error?: string
  }
  if (r.error) {
    console.log(`${label}: ERROR ${r.error}`)
    continue
  }
  const loaded = Object.keys(r.services ?? {})
  const childIds = (r.children ?? []).map((c) => c.shortId)
  console.log(
    `${label}\n   loaded=${JSON.stringify(loaded)}` +
      `\n   subgroupPresent=${r.subgroupPresent} childShortIds=${JSON.stringify(childIds)}` +
      `\n   group+children baked into yml=${(r.ymlAfter ?? "").includes("config")}`,
  )
}
console.log("\nQ1 own entries : childShortIds above (independent ids => own entries)")
console.log("Q2 child off   : '2-child-b-disabled' loaded should be ['svcA'] only")
console.log("Q3 child config: inspect entry b.config in scenario 2")
console.log("Q4 group off   : '3-group-disabled' loaded should be []")
console.log("Q5 baking      : '4-host-inserted-group-then-write'")

await rm(root, { recursive: true, force: true })
