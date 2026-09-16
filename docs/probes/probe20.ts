// Adversarial check on the two hand-written path patterns.
//
// A pattern that "passes the tests" can still be wrong. This probe covers the
// classic traversal shapes INCLUDING ones the contract test does not, and it
// separates two very different things:
//
//   A) shapes the PATTERN must reject  -> a mismatch here is a schema bug
//   B) shapes a path regex CANNOT catch (percent-encoding, Windows drive, UNC)
//      -> the loader must re-check containment after resolution. These are
//         recorded, not silently accepted.
//
// RUN: bun run docs/probes/probe20.ts
import { validatePluginManifest, validatePluginIndexEntry } from "../../host/src/contracts/pluginContract"

const baseManifest = { id: "x", version: "1.0.0", author: "a", name: "X" }
const baseEntry = {
  id: "x",
  type: "tool",
  source: { url: "https://github.com/a/b.git" },
  name: "X",
  description: "d",
  author: "a",
  repository: "https://github.com/a/b",
}

let mismatches = 0
let uncaught = 0

function check(label: string, value: string, got: boolean, want: boolean, group: "mustReject" | "knownLimitation") {
  const ok = got === want
  if (!ok) mismatches++
  const mark = ok ? "ok  " : "MISMATCH"
  console.log(`  ${mark} [${group}] ${label.padEnd(24)} got=${got} want=${want}`)
  if (group === "knownLimitation" && got === true) uncaught++
}

console.log("=== frontend.entry: shapes the pattern MUST reject ===")
for (const [v, want] of [
  ["ui/index.js", true],
  ["index.js", true],
  ["ui/sub/deep.js", true],
  ["./ui/index.js", true], // "./" is harmless — it stays inside
  ["../outside.js", false],
  ["/abs/path.js", false],
  ["ui/../../escape.js", false],
  ["ui/../ok.js", false],
  ["a/../../b.js", false],
  ["..", false],
  ["ui/..", false],
  ["", false],
] as Array<[string, boolean]>) {
  check(
    JSON.stringify(v),
    v,
    validatePluginManifest({ ...baseManifest, frontend: { entry: v } }),
    want,
    "mustReject",
  )
}

console.log("\n=== frontend.entry: shapes a path REGEX cannot catch (loader must re-check) ===")
for (const v of ["ui/%2e%2e/x.js", "..%2foutside.js", "C:/abs.js", "\\\\server\\share\\x.js", "ui/....//x.js"]) {
  check(JSON.stringify(v), v, validatePluginManifest({ ...baseManifest, frontend: { entry: v } }), true, "knownLimitation")
}

console.log("\n=== source.path: shapes the pattern MUST reject ===")
for (const [v, want] of [
  ["packages/a", true],
  ["a", true],
  ["a/b/c", true],
  ["./a", true], // "./" is harmless
  ["../outside", false],
  ["/abs", false],
  ["a/../../b", false],
  ["a/..", false],
  ["..", false],
  ["a/../b", false],
] as Array<[string, boolean]>) {
  check(
    JSON.stringify(v),
    v,
    validatePluginIndexEntry({ ...baseEntry, source: { ...baseEntry.source, path: v } }),
    want,
    "mustReject",
  )
}

console.log(`\npattern mismatches: ${mismatches}  (must be 0)`)
console.log(`shapes a regex cannot catch: ${uncaught}  (expected — see the loader containment note)`)
if (mismatches > 0) process.exitCode = 1
