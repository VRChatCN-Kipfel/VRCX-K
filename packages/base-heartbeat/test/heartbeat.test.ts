/**
 * A base package must satisfy the same contract as any third-party plugin —
 * manifest valid, id matching the directory, and loadable in a real tree.
 *
 * That sameness is the point of putting base plugins in `packages/`: if they got
 * a private path with different rules, every one of those rules would drift.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Context } from "cordis"
import { PluginManifestRegistry } from "../../../host/src/contracts/pluginRegistry"

const pkgDir = join(import.meta.dir, "..")

describe("base-heartbeat", () => {
  test("its manifest satisfies the published contract", async () => {
    const manifest = await PluginManifestRegistry.readFrom(pkgDir)
    expect(manifest.id).toBe("base-heartbeat")
    expect(manifest.services?.implements).toEqual(["heartbeat"])
  })

  test("it loads and provides the service the host asserts on", async () => {
    const ctx = new Context()
    const mod = (await import("../src/index")) as { apply(ctx: Context): void }
    // `apply` is the contract every plugin implements; calling it directly keeps
    // this test about the PLUGIN, while host/tests covers the loader wiring.
    mod.apply(ctx)

    expect(ctx.get("heartbeat")).toEqual({ ok: true })
    // The host's readiness check is an existence check, not a value check — pin
    // that, because a service that resolved but was undefined would still pass a
    // naive truthiness assertion in the caller.
    expect(ctx.get("heartbeat")).not.toBeUndefined()
  })
})
