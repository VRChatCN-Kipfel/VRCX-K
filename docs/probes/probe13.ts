// M2-5 / #19 decision evidence: can an EXTERNAL .ts plugin import a bare npm
// package?
//
// M0 established the distribution form: the host is compiled to an exe, plugins
// stay OUTSIDE it as .ts source, and the compiled host dynamically imports them
// (bun transpiles at runtime). So a plugin needs NO build step.
//
// But that only holds for a plugin whose imports are relative. The moment a
// plugin does `import x from "some-package"`, resolution has to find a
// node_modules. In the packaged app the host's own dependencies are inside the
// exe's virtual FS, NOT on disk — so the question is whether a plugin can
// resolve a bare specifier at all, and from where.
//
// This decides whether a plugin package must ship its own node_modules (a real
// "build"/install step, like Claude Code's lockfile install) or can be pure
// source.
//
// RUN: bun run docs/probes/probe13.ts

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"

/** Mirrors host/src/fiber.ts. */
const FIBER_PENDING = 0
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

type Row = { name: string; state: string; error: string | null; saw: string | null }

let root: string | undefined
const out: Record<string, unknown> = {}
try {
  root = await mkdtemp(join(tmpdir(), "vrcxk-deps-"))
  await mkdir(join(root, "plugins"), { recursive: true })

  // A plugin that imports a package the HOST already depends on (ajv is in
  // host/package.json), by bare specifier, with no node_modules of its own.
  await writeFile(
    join(root, "plugins", "bare-dep.ts"),
    `import Ajv from "ajv"\n` +
      `export function apply(ctx: any) {\n` +
      `  ;(globalThis as any).__probe13_bare = typeof Ajv\n` +
      `}\n`,
  )
  // Control: a plugin with only relative imports (the shape M0 verified).
  await writeFile(
    join(root, "plugins", "relative.ts"),
    `export function apply() { ;(globalThis as any).__probe13_rel = "ok" }\n`,
  )
  await writeFile(
    join(root, "cordis.yml"),
    `- id: relative\n  name: ./plugins/relative.ts\n- id: bare-dep\n  name: ./plugins/bare-dep.ts\n`,
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

  const rows: Row[] = []
  const deadline = Date.now() + 8000
  for (;;) {
    rows.length = 0
    const subtree = includeEntry.subtree
    if (subtree) {
      for (const entry of subtree.entries()) {
        const fiber = entry.fiber as { state?: number; await?(): Promise<unknown> } | null | undefined
        let error: string | null = null
        try {
          await fiber?.await?.()
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
        }
        // A failed module IMPORT leaves no fiber; its rejection lives on
        // `entry._initTask` instead, so read it from there.
        if (fiber === undefined || fiber === null) {
          const initTask = (entry as unknown as { _initTask?: Promise<unknown> })._initTask
          try {
            await initTask
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
          }
        }
        rows.push({
          name: entry.options.name,
          state:
            fiber === undefined || fiber === null
              ? // No fiber yet: the entry never finished initialising, which is
                // itself the signal that module IMPORT failed (before apply()).
                "NO_FIBER"
              : fiber.state === FIBER_ACTIVE
                ? "ACTIVE"
                : fiber.state === FIBER_FAILED
                  ? "FAILED"
                  : fiber.state === FIBER_PENDING
                    ? "PENDING"
                    : `UNKNOWN(${fiber.state})`,
          error,
          saw: null,
        })
      }
    }
    // Settled == every entry left PENDING/NO_FIBER. `[].every()` is `true`, so
    // the length guard is load-bearing.
    const settled = rows.length > 0 && rows.every((r) => r.state !== "PENDING" && r.state !== "NO_FIBER")
    if (settled || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 50))
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))

  const g = globalThis as Record<string, unknown>
  out.entries = rows
  out.relativePluginWorked = g.__probe13_rel === "ok"
  out.bareSpecifierResolved = g.__probe13_bare !== undefined
  out.bareTypeof = g.__probe13_bare ?? null

  const bareRow = rows.find((r) => r.name.includes("bare-dep"))
  // A failed module IMPORT leaves NO fiber, so the entry shows as NO_FIBER (not
  // FAILED) — checking only for FAILED here is what made this report
  // "inconclusive" while the real answer was already visible.
  out.barePluginFailed = bareRow?.state === "FAILED" || bareRow?.state === "NO_FIBER"
  out.barePluginState = bareRow?.state ?? null
  out.barePluginError = bareRow?.error ?? null

  // The load-bearing outcome: a plugin with no node_modules of its own CAN or
  // CANNOT resolve a bare specifier through the host's installed tree.
  out.verdict = !out.relativePluginWorked
    ? "control FAILED (the relative-import plugin should have loaded; probe is broken)"
    : out.bareSpecifierResolved
      ? "bare specifiers resolve (host's node_modules is reachable)"
      : out.barePluginFailed
        ? "bare specifiers DO NOT resolve (plugin must ship its own node_modules)"
        : `inconclusive (bare-dep state=${out.barePluginState}, no signal)`

  // Independently confirmed outside the loader: running a .ts file from a temp
  // dir with no node_modules fails with "Cannot find package". This probe's job
  // is to show the same thing happens through the REAL loader path.
  out.ok = true
} catch (e) {
  out.ok = false
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
} finally {
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(JSON.stringify(out, null, 2))
if (out.ok !== true) process.exitCode = 1
