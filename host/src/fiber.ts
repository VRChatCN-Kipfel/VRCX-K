// Side-effect-free cordis helpers used by the host bootstrap.
//
// Kept out of `index.ts` on purpose: `index.ts` runs `bootstrap()` at module
// top level, so importing it from a test would start a real host. Everything
// here is pure and unit-testable (see host/tests/host-wiring.test.ts).
import type { Entry } from "@cordisjs/plugin-loader"

// Cordis fiber states we care about while waiting for the include tree.
//
// These mirror cordis's `declare const enum FiberState` (ACTIVE = 2,
// FAILED = 3). A `declare const enum` has no runtime value, so it cannot be
// imported; the test pins these numbers against a real fiber so a cordis
// upgrade that renumbers them fails loudly.
export const FIBER_ACTIVE = 2
export const FIBER_FAILED = 3

/**
 * Does the include config declare the host's heartbeat entry?
 *
 * Matched exactly — the entry id `heartbeat`, or a plugin file whose basename
 * is `heartbeat.<ext>`. A loose substring test would let an unrelated plugin
 * (e.g. `my-heartbeat-monitor.ts`) make readiness depend on a service it never
 * provides, and the host would then fail to boot.
 */
export function declaresHeartbeat(includeEntry: Entry): boolean {
  const subtree = includeEntry.subtree
  if (!subtree) return false
  for (const entry of subtree.entries()) {
    const options = entry.options as { id?: unknown; name?: unknown } | undefined
    if (String(options?.id ?? "") === "heartbeat") return true
    const name = String(options?.name ?? "").replaceAll("\\", "/")
    const base = name.slice(name.lastIndexOf("/") + 1).replace(/\.[cm]?[jt]sx?$/, "")
    if (base === "heartbeat") return true
  }
  return false
}
