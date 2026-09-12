// Regression for the M2-1 blocking review finding: `fiber.name` is NOT an
// identity. It walks up the parent chain (cordis/lib/index.js:789-796) and the
// loader drops the `apply` name (cordis/lib/index.js:1365-1366), so a plugin
// that only exports `apply` — the normal shape, and exactly what
// `host/plugins/heartbeat.ts` is — has no `runtime.name` and resolves to the
// enclosing `Include`. Two different plugins then audit identically, which is
// the failure this capability surface exists to prevent.
//
// This drives the REAL loader + Include + cordis.yml path (the production path,
// unlike the bare `ctx.plugin()` used by capability.test.ts). Identities are
// asserted as PROPERTIES, not counts: the point is that distinct callers stay
// distinct, so a future change that distinguishes the nested plugins further
// must not turn this test red. See docs/probes/probe8.ts for the measurement.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context } from "cordis"
import Include from "@cordisjs/plugin-include"
import Loader from "@cordisjs/plugin-loader"
import { createShellCapabilities, ShellHandle } from "../src/capability"
import type { ShellStdioBridge } from "../src/stdio"

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vrcxk-cap-attr-"))
  await mkdir(join(root, "plugins"), { recursive: true })
  // Apply-only plugins (no `export const name`), matching the production shape.
  // `alpha` also starts two DIFFERENT nested bare `ctx.plugin()`s to pin the
  // loader behavior that such a fiber inherits the enclosing entry
  // (plugin-loader rc.6:577-581) while remaining distinguishable from it.
  await writeFile(
    join(root, "plugins", "alpha.ts"),
    `export function apply(ctx: any) {
  void ctx.notify.send("alpha", "x")
  void ctx.plugin(function nestedOne(inner: any) { void inner.notify.send("nestedOne", "y") })
  void ctx.plugin(function nestedTwo(inner: any) { void inner.notify.send("nestedTwo", "z") })
}
`,
  )
  await writeFile(
    join(root, "plugins", "beta.ts"),
    `export function apply(ctx: any) { void ctx.notify.send("beta", "x") }\n`,
  )
  await writeFile(
    join(root, "cordis.yml"),
    `- id: alpha\n  name: ./plugins/alpha.ts\n- id: beta\n  name: ./plugins/beta.ts\n`,
  )
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {})
})

describe("capability attribution through the real loader", () => {
  test("callers audit as distinct identities, not the enclosing Include", async () => {
    const audit: string[] = []
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + "/"
    const handle = new ShellHandle((line) => audit.push(line))
    createShellCapabilities(ctx, handle)
    // Only `notify` is reached; the rest of the bridge is irrelevant here.
    handle.attach({ shell: { notify: async () => true } } as unknown as ShellStdioBridge)

    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const includeId = await ctx.loader.create({
      name: "cordis:include",
      config: { path: "./cordis.yml", enableLogs: false },
    })
    expect(ctx.loader.resolve(includeId)).toBeDefined()

    // Include + plugin fibers settle asynchronously; poll for all four calls
    // (alpha, two nested bare plugins, and beta).
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (audit.filter((line) => line.includes("-> notify.send")).length >= 4) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    const senders = audit
      .filter((line) => line.includes("-> notify.send"))
      .map((line) => line.replace(/^\[cap\] /, "").split(" -> ")[0])

    // The bug: every caller would have audited as the enclosing Include.
    expect(senders).not.toContain("Include")

    // Two entries are distinct identities (M2-8 keys on entry.id). An apply-only
    // entry has no `#runtime.name` suffix, so its own call carries the bare id.
    const alphaCalls = senders.filter((sender) => sender.includes("alpha"))
    const betaCalls = senders.filter((sender) => sender.includes("beta"))
    const alphaEntry = alphaCalls.find((sender) => !sender.includes("#"))
    const betaEntry = betaCalls.find((sender) => !sender.includes("#"))
    if (!alphaEntry || !betaEntry) throw new Error(`missing entry identity: ${senders.join(", ")}`)
    expect(alphaEntry).not.toBe(betaEntry)

    // Nested bare plugins inherit the enclosing entry id (the prefix) yet stay
    // distinguishable from it and from each other.
    const nested = alphaCalls.filter((sender) => sender.includes("#"))
    expect(nested.length).toBeGreaterThanOrEqual(2)
    expect(new Set(nested).size).toBe(nested.length)
    for (const identity of nested) expect(identity.startsWith(`${alphaEntry}#`)).toBe(true)
  }, 20_000)
})
