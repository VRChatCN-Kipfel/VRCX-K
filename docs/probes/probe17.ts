// M2-5 decision evidence: can a `{id}--v{semver}-{suffix}` tag convention use
// ARBITRARY suffixes (alpha/beta/custom, with `_` allowed, length <= 24)?
//
// The proposal matters because the update check parses tag NAMES with zero file
// reads. If the suffix is real semver, we get ordering for free and correct.
// If it is NOT semver, we must implement our own comparator.
//
// Uses Bun.semver (no dependency, no network).

const out: Record<string, unknown> = {}

function tryOrder(a: string, b: string): unknown {
  try {
    return Bun.semver.order(a, b)
  } catch (e) {
    return `ERR ${e instanceof Error ? e.message : String(e)}`
  }
}

function trySatisfies(v: string, range: string): unknown {
  try {
    return Bun.semver.satisfies(v, range)
  } catch (e) {
    return `ERR ${e instanceof Error ? e.message : String(e)}`
  }
}

// ── 1. Which suffixes are LEGAL semver? ────────────────────────────────────
const candidates = [
  "1.2.0",
  "1.2.0-alpha",
  "1.2.0-beta",
  "1.2.0-ALPHA",
  "1.2.0-alpha.1",
  "1.2.0-alpha_1", // underscore — the proposal wants this to work
  "1.2.0-muggle",
  "1.2.0-alpha-1",
  "1.2.0-", // trailing hyphen
  "1.2.0+build", // build metadata
  "1.2.0-alpha+build",
]
out.ordering = {}
for (const v of candidates) {
  // order() throws/NaN on invalid input
  const o = tryOrder(v, "1.2.0")
  out.ordering[v] = o
}

// ── 2. Prerelease ordering: is it "before" the release? ───────────────────
out.prereleasePrecedesRelease = {
  "alpha < beta": tryOrder("1.2.0-alpha", "1.2.0-beta"),
  "beta < muggle": tryOrder("1.2.0-beta", "1.2.0-muggle"),
  "muggle < release": tryOrder("1.2.0-muggle", "1.2.0"),
  "alpha < alpha.1": tryOrder("1.2.0-alpha", "1.2.0-alpha.1"),
}

// ── 3. Uppercase vs lowercase (ASCII sort surprise) ───────────────────────
out.caseSensitivity = {
  "ALPHA vs alpha": tryOrder("1.2.0-ALPHA", "1.2.0-alpha"),
  "ALPHA vs beta": tryOrder("1.2.0-ALPHA", "1.2.0-beta"),
}

// ── 4. Default range behavior: are prereleases offered? ───────────────────
out.prereleaseInRanges = {
  "^* excludes prerelease": trySatisfies("2.0.0-beta.1", "^2.0.0"),
  "explicit prerelease opts in": trySatisfies("2.0.0-beta.1", "^2.0.0-0"),
  "caret on 1.2.0-alpha": trySatisfies("1.2.0-alpha.2", "^1.2.0-alpha"),
}

// ── 5. Non-semver tags seen in the wild (must be IGNORED, not crash) ──────
out.nonSemverTags = {}
for (const t of ["stable", "nightly", "latest", "v1.2.0", "1.2", "1.2.0.1", "release-1.2.0"]) {
  out.nonSemverTags[t] = tryOrder(t, "1.2.0")
}

// ── 6. Length: does semver care? ─────────────────────────────────────────
const longSuffix = "a".repeat(40)
out.lengthLimit = {
  [`1.2.0-${longSuffix.slice(0, 40)}`]: tryOrder(`1.2.0-${longSuffix}`, "1.2.0"),
  note: "semver itself imposes no length limit",
}

out.ok = true
console.log(JSON.stringify(out, null, 2))
