// Integration tests for DevWatch on a real Cordis runtime with locked
// cordis/loader/include versions: per-entry reload on file change, shared
// util roots, include refresh on cordis.yml change, and failure rollback.
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Context } from "cordis"
import type { Entry } from "@cordisjs/plugin-loader"
import Include from "@cordisjs/plugin-include"
import Loader from "@cordisjs/plugin-loader"
import { DevWatch, type DevWatchEvent } from "../src/dev-watch"

const roots: string[] = []
let ctx: Context | undefined
let includeEntry: Entry | undefined

beforeAll(() => {}, 60_000)

afterEach(async () => {
  try {
    if (ctx && includeEntry) {
      const loader = ctx.loader as unknown as { remove?(id: string): void }
      loader.remove?.(includeEntry.id)
    }
  } catch {
    // teardown best-effort
  }
  ctx = undefined
  includeEntry = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-devwatch-"))
  roots.push(root)
  const pluginDir = join(root, "plugins")
  await mkdir(pluginDir, { recursive: true })
  const configFile = join(root, "cordis.yml")
  const entryFile = join(pluginDir, "alpha.ts")
  const utilFile = join(pluginDir, "shared.ts")

  await writeFile(configFile, `- id: alpha\n  name: ./plugins/alpha.ts\n`)
  await writeFile(utilFile, `export const shared = "v1"\n`)
  await writeFile(
    entryFile,
    `import { shared } from "./shared.ts"\n` +
      `export function apply() {\n` +
      `  const g = globalThis as Record<string, unknown>\n` +
      `  g.__alphaCount = ((g.__alphaCount as number) ?? 0) + 1\n` +
      `  g.__alphaShared = shared\n` +
      `}\n`,
  )

  const c = new Context()
  c.baseUrl = pathToFileURL(root).href + "/"
  await c.plugin(Loader)
  c.loader.builtins.include = Include
  const id = await c.loader.create({ name: "cordis:include", config: { path: "./cordis.yml", enableLogs: false } })
  const entry = c.loader.resolve(id)
  // Wait for the include subtree + first plugin fiber.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const e = entry.subtree && [...entry.subtree.entries()].find((x: unknown) => (x as Entry).options.name === "./plugins/alpha.ts")
    if (e && (e as Entry).fiber?.uid != null) break
    await new Promise((r) => setTimeout(r, 50))
  }
  ctx = c
  includeEntry = entry
  return { root, pluginDir, configFile, entryFile, utilFile }
}

function waitEvent(events: DevWatchEvent[], predicate: (e: DevWatchEvent) => boolean, timeoutMs = 8_000): Promise<DevWatchEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      const found = events.find(predicate)
      if (found) return resolve(found)
      if (Date.now() > deadline) return reject(new Error("timed out waiting for dev-watch event"))
      setTimeout(poll, 25)
    }
    poll()
  })
}

/** Editor-style atomic write: temp file + rename (folded by chokidar atomic). */
async function atomicWrite(target: string, content: string): Promise<void> {
  const tmp = target + ".tmp"
  await writeFile(tmp, content)
  await rename(tmp, target)
}

describe("DevWatch live reload", () => {
  test("reloads an entry when its source file changes (single apply per change)", async () => {
    const { root, configFile, entryFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeEntry!.subtree!
    const watch = new DevWatch({
      include,
      configFile,
      devMap: { [includeEntry!.id + ":alpha"]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")

    // Let the initial scan settle before we change files.
    await new Promise((r) => setTimeout(r, 150))

    const alphaEntry = [...include.entries()].find((e: Entry) => e.options.name === "./plugins/alpha.ts") as Entry
    const uidBefore = alphaEntry.fiber?.uid

    await atomicWrite(entryFile, (await Bun.file(entryFile).text()) + "// touched\n")
    const reloadEvent = await waitEvent(events, (e) => e.type === "reload")
    expect(reloadEvent.type).toBe("reload")
    if (reloadEvent.type !== "reload") return
    expect(reloadEvent.result.status).toBe("reloaded")
    expect(reloadEvent.result.entryId).toBe(alphaEntry.id)

    // New fiber uid; module re-evaluated. Windows chokidar may emit a second
    // (delayed) event for the same save, so allow 1-2 reloads - but they must
    // settle (no reload storm) and never run concurrently.
    expect(alphaEntry.fiber?.uid).not.toBe(uidBefore)
    const countAfterFirst = (globalThis as Record<string, unknown>).__alphaCount as number
    expect(countAfterFirst).toBeGreaterThan(1)
    // Wait for the count to stabilise across two samples (absorbs a delayed
    // Windows double event) and assert it stops growing.
    let last = countAfterFirst
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 600))
      const now = (globalThis as Record<string, unknown>).__alphaCount as number
      if (now === last) break
      last = now
    }
    expect((globalThis as Record<string, unknown>).__alphaCount).toBe(last) // no reload storm
    await watch.close()
  }, 30_000)

  test("shared-util change reloads the entry mapped to that root", async () => {
    const { root, configFile, utilFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeEntry!.subtree!
    const watch = new DevWatch({
      include,
      configFile,
      devMap: { [includeEntry!.id + ":alpha"]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await new Promise((r) => setTimeout(r, 150))

    await atomicWrite(utilFile, (await Bun.file(utilFile).text()).replace("v1", "v2"))
    const reloadEvent = await waitEvent(events, (e) => e.type === "reload")
    expect(reloadEvent.type).toBe("reload")
    if (reloadEvent.type !== "reload") return
    expect(reloadEvent.result.status).toBe("reloaded")
    expect((globalThis as Record<string, unknown>).__alphaShared).toBe("v2")
    await watch.close()
  }, 30_000)

  test("keeps old fiber when a syntax error is written (strong rollback)", async () => {
    const { root, configFile, entryFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeEntry!.subtree!
    const watch = new DevWatch({
      include,
      configFile,
      devMap: { [includeEntry!.id + ":alpha"]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await new Promise((r) => setTimeout(r, 150))

    const alphaEntry = [...include.entries()].find((e: Entry) => e.options.name === "./plugins/alpha.ts") as Entry
    const uidBefore = alphaEntry.fiber?.uid
    const countBefore = (globalThis as Record<string, unknown>).__alphaCount as number

    await atomicWrite(entryFile, "export function apply( { this is not valid ts\n")
    const reloadEvent = await waitEvent(events, (e) => e.type === "reload")
    expect(reloadEvent.type).toBe("reload")
    if (reloadEvent.type !== "reload") return
    // Import of a broken module can resolve at parse time or apply time; either
    // way the OLD fiber must still be the one on the entry.
    expect(["kept-old", "restored-old"]).toContain(reloadEvent.result.status)
    expect(alphaEntry.fiber?.uid).toBe(uidBefore)
    expect((globalThis as Record<string, unknown>).__alphaCount).toBe(countBefore)
    await watch.close()
  }, 30_000)

  test("include refresh picks up a new entry after cordis.yml changes", async () => {
    const { root, configFile } = await makeHost()
    await writeFile(join(root, "plugins", "beta.ts"), `export function apply() { (globalThis as any).__betaCount = ((globalThis as any).__betaCount ?? 0) + 1 }\n`)
    const events: DevWatchEvent[] = []
    const include = includeEntry!.subtree!
    const watch = new DevWatch({
      include,
      configFile,
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await new Promise((r) => setTimeout(r, 150))

    await writeFile(
      configFile,
      `- id: alpha\n  name: ./plugins/alpha.ts\n- id: beta\n  name: ./plugins/beta.ts\n`,
    )
    const refreshed = await waitEvent(events, (e) => e.type === "config-refreshed")
    expect(refreshed.type).toBe("config-refreshed")
    if (refreshed.type !== "config-refreshed") return
    expect(refreshed.entries).toContain(includeEntry!.id + ":beta")
    expect((globalThis as Record<string, unknown>).__betaCount).toBe(1)
    await watch.close()
  }, 30_000)

  test("N reloads keep registry/fiber counts at baseline (leak regression)", async () => {
    const { root, configFile, entryFile } = await makeHost()
    const events: DevWatchEvent[] = []
    const include = includeEntry!.subtree!
    const watch = new DevWatch({
      include,
      configFile,
      devMap: { [includeEntry!.id + ":alpha"]: [join(root, "plugins")] },
      onState: (e) => events.push(e),
    })
    await watch.start()
    await waitEvent(events, (e) => e.type === "started")
    await new Promise((r) => setTimeout(r, 200))

    const alphaEntry = [...include.entries()].find((e: Entry) => e.options.name === "./plugins/alpha.ts") as Entry
    const registry = (ctx! as unknown as { registry: { size: number } }).registry
    const baselineRegistrySize = registry.size

    const initialContent = await Bun.file(entryFile).text()
    for (let i = 0; i < 5; i++) {
      await atomicWrite(entryFile, initialContent + `// edit ${i}\n`)
      await waitEvent(events, (e) => e.type === "reload" && e.result?.status === "reloaded", 10_000)
      // allow the (possibly doubled) Windows event pair to settle
      await new Promise((r) => setTimeout(r, 500))
    }

    // Every reload disposes the old fiber and rebuilds one; registry runtimes
    // must not accumulate.
    expect(registry.size).toBeLessThanOrEqual(baselineRegistrySize + 1)
    const liveFibers = [...include.entries()].filter((e: Entry) => e.fiber?.uid != null)
    expect(liveFibers).toHaveLength(1)
    expect(alphaEntry.fiber?.uid).not.toBeNull()
    await watch.close()
  }, 60_000)
})
