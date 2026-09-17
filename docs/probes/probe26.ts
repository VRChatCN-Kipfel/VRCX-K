/**
 * DECISIVE TEST: if the host injects base entries via root-level `insert`, does a
 * write-back bake them into the user's cordis.yml?
 *
 * probe25 looked like it answered "no", but probe25 never triggered a write —
 * so that was not evidence, it was a missing step. probe24 DID write and saw
 * overrides baked. The distinction that matters:
 *
 *   - `applyPatches` runs on a SHALLOW COPY: `applyPatches([...this.data])`.
 *     `data.push(...insert)` therefore pushes onto the copy, not onto this.data.
 *   - but it MUTATES entry objects in place (`target[key] = value`), and those
 *     objects are shared with this.data.
 *
 * So inserts may be safe while overrides are not. `Include.write()` writes
 * `this.root.data` — and root.data was handed the patched copy — so the question
 * is whether the tree adopted the copy as its data.
 *
 * Each case uses a DISTINCT plugin file so a duplicate service registration
 * cannot masquerade as a patch failure (that was probe25's bug in case C).
 *
 * Run: bun run docs/probes/probe26.ts
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"

const root = await mkdtemp(join(tmpdir(), "vrcxk-probe26-"))
const out: Record<string, unknown> = {}

/** Distinct service name per plugin file, so two entries never collide. */
const pluginSrc = (svc: string) => `export function apply(ctx) { ctx.provide("${svc}", { ok: true }) }\n`

async function run(
  label: string,
  yml: string,
  patches: unknown[],
  opts: { write?: boolean } = {},
) {
  const dir = join(root, label)
  await mkdir(join(dir, "plugins"), { recursive: true })
  await writeFile(join(dir, "plugins", "user.ts"), pluginSrc("svcUser"))
  await writeFile(join(dir, "plugins", "base.ts"), pluginSrc("svcBase"))
  await writeFile(join(dir, "cordis.yml"), yml)

  const ctx = new Context()
  ctx.baseUrl = new URL(`file://${dir.replace(/\\/g, "/")}/`).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include

  try {
    const id = await ctx.loader.create({
      name: "cordis:include",
      config: { path: "./cordis.yml", enableLogs: false, patches: patches as never },
    })
    const entry = ctx.loader.resolve(id)

    const deadline = Date.now() + 4_000
    let ids: string[] = []
    for (;;) {
      ids = [...(entry.subtree?.entries() ?? [])].map((e) => e.id.split(":").pop() ?? e.id)
      if (ids.length > 0 || Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 25))
    }

    const ymlBeforeWrite = await readFile(join(dir, "cordis.yml"), "utf8")

    // Simulate an ordinary shutdown write-back.
    if (opts.write !== false) {
      ;(entry.subtree as unknown as { write?: () => void }).write?.()
      await new Promise((r) => setTimeout(r, 400))
    }

    out[label] = {
      entryIds: ids,
      userServiceLoaded: ctx.get("svcUser") != null,
      baseServiceLoaded: ctx.get("svcBase") != null,
      ymlBeforeWrite,
      ymlAfterWrite: await readFile(join(dir, "cordis.yml"), "utf8").catch(() => "(none)"),
    }
  } catch (error) {
    out[label] = { error: (error as Error).message }
  }
}

// 1. Pure host-injected base entry; user's yml is empty. Then WRITE.
await run("1-insert-then-write", "[]\n", [{ insert: [{ id: "base", name: "./plugins/base.ts" }] }])

// 2. Host injects base; user also has their own entry. Then WRITE.
await run("2-insert-with-user-then-write", "- id: user\n  name: ./plugins/user.ts\n", [
  { insert: [{ id: "base", name: "./plugins/base.ts" }] },
])

// 3. Patch DISABLES the injected base entry, then WRITE.
//    (overrides mutate shared objects, so this is the case probe24 showed baking)
await run("3-insert-then-disable-then-write", "[]\n", [
  { insert: [{ id: "base", name: "./plugins/base.ts" }] },
  { id: "base", disabled: true },
])

console.log(JSON.stringify(out, null, 2))

console.log("\n=== DECISIVE ===")
for (const [label, v] of Object.entries(out)) {
  const r = v as { entryIds?: string[]; ymlBeforeWrite?: string; ymlAfterWrite?: string; baseServiceLoaded?: boolean }
  if (!r.entryIds) {
    console.log(`  ${label}: ERROR ${(v as { error?: string }).error}`)
    continue
  }
  const baked = (r.ymlAfterWrite ?? "").includes("base")
  const grew = (r.ymlAfterWrite ?? "").length !== (r.ymlBeforeWrite ?? "").length
  console.log(
    `  ${label}\n    entries=${JSON.stringify(r.entryIds)} baseLoaded=${r.baseServiceLoaded}` +
      `\n    yml changed on write: ${grew}   base baked into yml: ${baked}` +
      `\n    yml after: ${JSON.stringify(r.ymlAfterWrite)}`,
  )
}

await rm(root, { recursive: true, force: true })
