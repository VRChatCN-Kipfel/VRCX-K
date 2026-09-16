#!/usr/bin/env bun
/**
 * Contract-drift gate (M2-2, decision D3).
 *
 * The generated TS mirrors are checked in. That is only safe if something
 * notices when they fall out of step with the schemas they mirror — and until
 * now NOTHING did. The symptom was already present in this repo:
 * `host/src/contracts/hostLifecycle.ts` claims "Generated ... Do not hand-edit"
 * in its header while no script or CI step has ever produced it.
 *
 * So this gate regenerates every mirror into a temp tree and compares bytes.
 * Any difference fails, naming the file and how to fix it.
 *
 * Run: bun run scripts/check-contract-drift.ts
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

type Pair = { schema: string; generated: string; extraArgs?: string[] }

const repoRoot = join(import.meta.dir, "..")

/** The canonical schema -> mirror pairs. Add a row when a contract is added. */
export const CONTRACTS: Pair[] = [
  {
    schema: "contracts/tray-menu.schema.json",
    generated: "host/src/tray-contract.generated.ts",
    extraArgs: ["--maxItems", "-1"],
  },
  {
    schema: "contracts/plugin-manifest/v1/plugin-manifest.schema.json",
    generated: "host/src/contracts/pluginManifest.generated.ts",
  },
  {
    schema: "contracts/plugin-index/v1/plugin-index-entry.schema.json",
    generated: "host/src/contracts/pluginIndexEntry.generated.ts",
  },
  // NOT LISTED, DELIBERATELY: host/src/contracts/hostLifecycle.ts.
  //
  // Its header says "Generated ... Do not hand-edit", and json-schema-to-
  // typescript CAN regenerate its types — but the file also carries the
  // hand-written runtime guard (`isHostSnapshot` / `isHostExitSummary`), which
  // no generator emits. It is a HYBRID: ~31 generated lines plus ~30 hand-written
  // ones in one file, so it cannot be byte-compared against a fresh generation.
  //
  // It stays out of this gate until it is split into a generated type module and
  // a separate guard module. Until then its schema<->type agreement is pinned by
  // `host/tests/host-lifecycle-contract.test.ts` reading the schema at runtime.
]

export type DriftResult = { pair: Pair; status: "ok" | "drift" | "error"; detail?: string }

/**
 * Compare two generated files, ignoring line-ending differences.
 *
 * A generated artifact must not be platform-dependent, but the working tree is:
 * on Windows `core.autocrlf` rewrites checked-out files to CRLF while the
 * generator emits LF. Comparing raw bytes would therefore report a "drift" that
 * is really just the checkout, and the gate would be noisy enough to be ignored —
 * which is worse than not having it.
 */
export function sameIgnoringLineEndings(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n")
}

export function checkOne(pair: Pair, tmpDir: string): DriftResult {
  const out = join(tmpDir, basename(pair.generated))
  const args = [
    "json2ts",
    join(repoRoot, pair.schema),
    "-o",
    out,
    ...(pair.extraArgs ?? []),
  ]
  const proc = Bun.spawnSync(["bunx", ...args], { cwd: join(repoRoot, "host") })
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : ""
    return { pair, status: "error", detail: stderr.slice(0, 400) }
  }

  const fresh = readFileSync(out, "utf8")
  const committed = readFileSync(join(repoRoot, pair.generated), "utf8")
  if (!sameIgnoringLineEndings(fresh, committed)) {
    return {
      pair,
      status: "drift",
      detail: `committed mirror differs from a fresh generation of ${pair.schema}`,
    }
  }
  return { pair, status: "ok" }
}

if (import.meta.main) {
  const tmp = mkdtempSync(join(tmpdir(), "vrcxk-drift-"))
  let failed = 0
  try {
    for (const pair of CONTRACTS) {
      const result = checkOne(pair, tmp)
      if (result.status === "ok") {
        console.log(`[contracts] ok      ${pair.generated}`)
        continue
      }
      failed++
      console.error(`[contracts] ${result.status.toUpperCase()}  ${pair.generated}`)
      if (result.detail) console.error(`           ${result.detail}`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (failed > 0) {
    console.error(
      `\n[contracts] ${failed} mirror(s) out of date.\n` +
        `Regenerate with:  bun run --cwd host generate:contracts\n` +
        `Then commit the regenerated files.`,
    )
    process.exit(1)
  }
  console.log(`[contracts] all ${CONTRACTS.length} mirrors match their schemas`)
}
