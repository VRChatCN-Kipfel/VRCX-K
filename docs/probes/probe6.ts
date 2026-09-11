// M2-1 spike v7: close two ADR unknowns that option A/B depend on.
//
//   U1. Does `config.initial` seed a MISSING yml? And is it a string (yml text)?
//   U2. What happens when the yml is not writable — silent readonly, or an
//       immediate error? (ADR §1.3 says silent; that changes error UX design)
//   U3. Do `config.patches` survive a write(), or get baked into the file?
//       (option B depends on the answer)

import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"

const out: Record<string, unknown> = {}

function err(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

async function makeCtx(baseDir: string) {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(baseDir).href + "/"
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  return ctx
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-adr-"))

  // ─── U1: initial seeding of a MISSING file ────────────────────────────────
  {
    const dir = await mkdtemp(join(root, "u1-"))
    const ctx = await makeCtx(dir)
    const initial = "- id: seeded\n  name: ./plugins/seeded.ts\n"
    try {
      const id = await ctx.loader.create({
        name: "cordis:include",
        config: { path: "./cordis.yml", initial },
      })
      out.U1_entryId = id
      await new Promise((r) => setTimeout(r, 60))
      const entry = ctx.loader.resolve?.(id)
      out.U1_initialWasString = typeof initial
      out.U1_fileExists = await readFile(join(dir, "cordis.yml"), "utf8").then(
        (c) => ({ yes: true, content: c }),
        (e) => ({ yes: false, error: err(e) }),
      )
      // Does the tree actually contain the seeded entry (despite the plugin file
      // not existing — that entry should FAIL, but the tree should list it)?
      if (entry) {
        const tree = (entry.subtree as any)?.data
        out.U1_treeData = JSON.stringify(tree ?? null)
      }
    } catch (e) {
      out.U1_error = err(e)
    }
  }

  // ─── U2: unwritable file — silent readonly or immediate error? ────────────
  {
    const dir = await mkdtemp(join(root, "u2-"))
    const cfg = join(dir, "cordis.yml")
    await writeFile(cfg, "- id: ro\n  name: ./plugins/ro.ts\n", "utf8")
    await chmod(cfg, 0o444) // read-only attribute on Windows
    const ctx = await makeCtx(dir)
    try {
      const id = await ctx.loader.create({
        name: "cordis:include",
        config: { path: "./cordis.yml" },
      })
      await new Promise((r) => setTimeout(r, 60))
      const entry = ctx.loader.resolve?.(id)
      const includeInstance: any = entry?.subtree
      out.U2_loadedOk = true
      out.U2_readonlyFlag = includeInstance?.readonly ?? null
      // Now try to trigger a write through the tree.
      try {
        includeInstance?.write?.()
        await new Promise((r) => setTimeout(r, 80)) // writeFile is debounced by setTimeout(0)
        out.U2_writeThrew = false
      } catch (e) {
        out.U2_writeThrew = err(e)
      }
    } catch (e) {
      out.U2_loadError = err(e)
    } finally {
      await chmod(cfg, 0o644).catch(() => {})
    }
  }

  // ─── U3: do patches get baked into the file on write()? ───────────────────
  {
    const dir = await mkdtemp(join(root, "u3-"))
    const cfg = join(dir, "cordis.yml")
    await writeFile(cfg, "- id: base\n  name: ./plugins/base.ts\n", "utf8")
    const ctx = await makeCtx(dir)
    try {
      const id = await ctx.loader.create({
        name: "cordis:include",
        config: {
          path: "./cordis.yml",
          patches: [{ id: "base", disabled: true }],
        },
      })
      await new Promise((r) => setTimeout(r, 60))
      const entry = ctx.loader.resolve?.(id)
      const inst: any = entry?.subtree
      out.U3_readonly = inst?.readonly ?? null
      out.U3_treeAfterPatch = JSON.stringify(inst?.data ?? null)
      try {
        inst?.write?.()
      } catch (e) {
        out.U3_write_call_error = err(e)
      }
      await new Promise((r) => setTimeout(r, 120))
      out.U3_fileAfterWrite = await readFile(cfg, "utf8").then(
        (c) => c,
        (e) => `ERR ${err(e)}`,
      )
    } catch (e) {
      out.U3_error = err(e)
    }
  }

  console.log(JSON.stringify(out, (k, v) => (typeof v === "symbol" ? v.toString() : v), 2))
}

await main()
