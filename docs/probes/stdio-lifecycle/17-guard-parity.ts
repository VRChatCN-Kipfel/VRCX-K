// 17-guard-parity.ts — does the TS guard agree with the shared `extra` corpus?
//
// WHY THIS EXISTS: the TS guard and the Rust mirror once DISAGREED about `extra`
// — Rust accepted nested objects, arrays, non-camelCase keys and >32 entries that
// the schema and this guard both rejected. Testing each side against its own
// hand-written table could not have caught that, so the corpus now lives in ONE
// place (`contracts/host-ready/v1/guard-parity.corpus.json`) and BOTH sides read
// it: this probe plus `host/tests/host-ready-contract.test.ts` on the TS side, and
// `src-tauri/src/host_ready.rs` (via `include_str!`) on the Rust side.
//
// This probe deliberately holds NO cases of its own. A second inline table would
// be exactly the "second copy of the truth" the repo's single-source rule forbids,
// and it would drift from the corpus without anything failing.
//
// Run: bun run docs/probes/stdio-lifecycle/17-guard-parity.ts

import { isHostReady } from "../../../host/src/contracts/hostReady"
import { collectHostEnvironment } from "../../../host/src/host-environment"

const corpusPath = new URL("../../../contracts/host-ready/v1/guard-parity.corpus.json", import.meta.url)
const corpus = (await Bun.file(corpusPath).json()) as {
  maxProperties: number
  cases: Array<{ name: string; expect: boolean; extra: Record<string, unknown> }>
}

// A realistic handshake, filled with this process's own environment, so the
// corpus exercises `extra` against a payload the guard would otherwise accept.
const base = {
  schemaVersion: 1 as const,
  port: 43120,
  token: "a".repeat(64),
  hostVersion: "0.0.1",
  ...collectHostEnvironment(),
}

const results = corpus.cases.map((c) => ({
  name: c.name,
  expect: c.expect,
  got: isHostReady({ ...base, extra: c.extra }),
}))
for (const r of results) {
  console.log(`${r.got === r.expect ? "ok  " : "DIFF"}  ${r.name.padEnd(18)} expected=${r.expect} got=${r.got}`)
}

const bad = results.filter((r) => r.got !== r.expect)
console.log(
  `\n${results.length} corpus cases; maxProperties=${corpus.maxProperties}; disagreements=${bad.length}` +
    (bad.length ? `\n  ${bad.map((r) => `${r.name}: expected ${r.expect}, got ${r.got}`).join("\n  ")}` : ""),
)

// Fail loudly: a silent disagreement is exactly the bug this file was added for.
if (bad.length > 0) process.exitCode = 1
