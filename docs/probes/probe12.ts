// M2-2 (#18) decision evidence: what is the BLAST RADIUS of a failed plugin?
//
// The proposal under discussion is: "no manifest / malformed manifest => refuse
// to load". That is fine ONLY IF a refused plugin cannot take the rest of the
// host down with it.
//
// TWO LAYERS, and they disagree (see docs/cordis-runtime-findings.md §1.15):
//
//   1. FIBER layer  — cordis CONTAINS the failure. The broken entry goes FAILED,
//      its siblings stay ACTIVE, and the include tree still settles.
//   2. PROCESS layer — the error still escapes as an `unhandledRejection`, and
//      the real host has NO handler for it. Worse, host/src/index.ts's
//      `waitForIncludeReady` throws on any FAILED entry, so the failure is
//      escalated to a fatal bootstrap error: the host exits 1 and the app does
//      not start.
//
// So layer 1 alone is NOT the answer to "is refusing safe?" — the escalation in
// layer 2 is what actually kills the host, and it is our code, not cordis.
//
// DECIDED SEMANTICS: every plugin is treated the same — base packages, their
// sub-packages and plugins get NO special treatment. A failure is always
// contained and must be attributable, so that a conflict between our plugin and
// an external one never yields an unstartable app with no way to diagnose it.
//
// RUN: bun run docs/probes/probe12.ts
//
// It boots a cordis.yml with THREE entries —
//   - good-one : healthy
//   - broken   : apply() throws
//   - good-two : healthy
// — and reports which entries reached ACTIVE, whether the include tree settled,
// and what (if anything) escaped to the process boundary.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"
import Include from "../../host/node_modules/@cordisjs/plugin-include/lib/index.js"

/** Mirrors host/src/fiber.ts — keep in sync if the constants move. */
const FIBER_PENDING = 0
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

const STATE_NAMES: Record<number, string> = {
  [FIBER_PENDING]: "PENDING",
  [FIBER_ACTIVE]: "ACTIVE",
  [FIBER_FAILED]: "FAILED",
}

type Row = { name: string; id: string; state: string; error: string | null }

let root: string | undefined
const out: Record<string, unknown> = {}

// A FAILED entry's error is contained at the FIBER level (state=FAILED, tree
// settles, siblings ACTIVE) — but it still surfaces at the PROCESS level. Trace
// where, because "refuse to load" is only safe if the refusal does not reach the
// process boundary.
const escaped: string[] = []
process.on("unhandledRejection", (reason) => {
  escaped.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`)
})
process.on("uncaughtException", (error) => {
  escaped.push(`uncaughtException: ${error instanceof Error ? error.message : String(error)}`)
})

try {
  root = await mkdtemp(join(tmpdir(), "vrcxk-blast-"))
  await mkdir(join(root, "plugins"), { recursive: true })
  await writeFile(join(root, "plugins", "good-one.ts"), `export function apply() {}\n`)
  await writeFile(join(root, "plugins", "good-two.ts"), `export function apply() {}\n`)
  await writeFile(
    join(root, "plugins", "broken.ts"),
    `export function apply() { throw new Error("boom: broken plugin") }\n`,
  )
  await writeFile(
    join(root, "cordis.yml"),
    `- id: good-one\n  name: ./plugins/good-one.ts\n` +
      `- id: broken\n  name: ./plugins/broken.ts\n` +
      `- id: good-two\n  name: ./plugins/good-two.ts\n`,
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

  // Did the include plugin ITSELF assemble, or did one bad entry sink it?
  let includeError: string | null = null
  try {
    await (includeEntry.fiber as { await?(): Promise<unknown> } | undefined)?.await?.()
  } catch (e) {
    includeError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  }

  const rows: Row[] = []
  const deadline = Date.now() + 8000
  for (;;) {
    rows.length = 0
    const subtree = includeEntry.subtree
    if (subtree) {
      for (const entry of subtree.entries()) {
        const fiber = entry.fiber as { state?: number } | null | undefined
        let error: string | null = null
        try {
          await (fiber as { await?(): Promise<unknown> } | null | undefined)?.await?.()
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
        }
        rows.push({
          name: entry.options.name,
          id: entry.id,
          state: STATE_NAMES[fiber?.state ?? -1] ?? `UNKNOWN(${fiber?.state})`,
          error,
        })
      }
    }
    // ⚠ `[].every(...)` is `true`, so an empty first iteration would break
    // immediately and report zero entries as if that were the answer. The
    // length guard is load-bearing, not defensive.
    const settled = rows.length > 0 && rows.every((r) => r.state !== "PENDING")
    if (settled || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 50))
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))

  const byName = (n: string) => rows.find((r) => r.name.endsWith(n))
  out.includeOwnFiber = includeError === null ? "settled (ok)" : `REJECTED: ${includeError}`
  out.entries = rows
  out.survivors = rows.filter((r) => r.state === "ACTIVE").map((r) => r.name)
  out.failed = rows.filter((r) => r.state === "FAILED").map((r) => r.name)

  // The load-bearing question: does ONE broken entry stop the OTHERS?
  out.oneBrokenEntryDoesNotSinkTheTree =
    byName("good-one.ts")?.state === "ACTIVE" &&
    byName("good-two.ts")?.state === "ACTIVE" &&
    byName("broken.ts")?.state === "FAILED" &&
    includeError === null

  // The broken plugin's error is reported by cordis's own logger as well. Capture
  // what reached the process boundary rather than the fiber boundary.
  //
  // `unhandledRejection` fires on a LATER tick than the fiber settling, so reading
  // `escaped` immediately would race and always see []. Drain the queue first.
  await new Promise((r) => setTimeout(r, 100))
  out.escapedToProcessLevel = [...escaped]
  out.errorIsContainedAtProcessLevel = escaped.length === 0

  out.ok = true
} catch (e) {
  out.ok = false
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
} finally {
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(JSON.stringify(out, null, 2))
if (out.ok !== true) process.exitCode = 1
