// The example plugin is only useful if it actually works. This fixture is the
// acceptance test for `examples/hello-plugin`:
//
//   1. its manifest passes the real contract (not a paraphrase of it),
//   2. `PluginManifestRegistry.readFrom` can read it from disk, and
//   3. it LOADS in a real cordis tree — i.e. the starting point a new author
//      copies is known-good, not merely plausible-looking.
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Context } from "cordis"
import Loader from "@cordisjs/plugin-loader"
import Include from "@cordisjs/plugin-include"
import { PluginManifestRegistry } from "../src/contracts/pluginRegistry"
import { assertPluginManifest } from "../src/contracts/pluginContract"

const repoRoot = join(import.meta.dir, "..", "..")
const exampleDir = join(repoRoot, "examples", "hello-plugin")

describe("examples/hello-plugin", () => {
  test("its manifest satisfies the published contract", async () => {
    const manifest = await PluginManifestRegistry.readFrom(exampleDir)
    expect(manifest.id).toBe("hello-plugin")
    expect(manifest.version).toBe("0.1.0")
    // Read back through the raw guard too, so a schema/mirror drift shows up here.
    expect(() => assertPluginManifest(manifest)).not.toThrow()
  })

  test("the plugin module loads in a real cordis tree and provides its service", async () => {
    const ctx = new Context()
    // Relative import specifiers resolve against baseUrl, so pointing it at the
    // example root lets the same file work from a temp cwd in other tests.
    ctx.baseUrl = new URL(`file://${exampleDir.replace(/\\/g, "/")}/`).href

    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include

    // Provide the one service the manifest declares as `required`, so the
    // readiness gate is satisfied rather than parking the fiber in PENDING.
    ctx.provide("notify", { send: async () => true })

    const includeId = await ctx.loader.create({
      name: "cordis:include",
      config: { path: "./cordis.yml", enableLogs: false },
    })
    const includeEntry = ctx.loader.resolve(includeId)

    // Wait for the entry to stop being PENDING.
    const FIBER_ACTIVE = 2
    const deadline = Date.now() + 8_000
    let state: number | undefined
    for (;;) {
      state = (includeEntry.fiber as { state?: number } | undefined)?.state
      if (state === FIBER_ACTIVE || Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(state).toBe(FIBER_ACTIVE)

    // The service the example provides must actually be reachable.
    const hello = ctx.get("hello") as { greet(who: string): string } | undefined
    expect(hello?.greet("world")).toBe("hello, world")
  })
})
