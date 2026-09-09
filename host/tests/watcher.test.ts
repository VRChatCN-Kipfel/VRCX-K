import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { binding } from "../src/watch-path"
import { HostWatcher, type WatcherEvent } from "../src/watcher"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-watcher-"))
  roots.push(root)
  await mkdir(join(root, "plugin"))
  const entry = join(root, "plugin", "index.ts")
  await writeFile(entry, "export default {}")
  return { root, entry, pluginRoot: join(root, "plugin") }
}

function waitFor<T>(items: T[], predicate: (item: T) => boolean, timeout = 3_000): Promise<T> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = items.find(predicate)
      if (found) return resolve(found)
      if (Date.now() - started >= timeout) return reject(new Error("timed out waiting for watcher event"))
      setTimeout(poll, 10)
    }
    poll()
  })
}

describe("HostWatcher", () => {
  test("debounces changes and maps exact and root events", async () => {
    const { root, entry, pluginRoot } = await fixture()
    const events: WatcherEvent[] = []
    const changes: string[] = []
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 40,
      bindings: [binding("plugin", entry, [pluginRoot])],
      onEvent: (event) => events.push(event),
      onChange: (path) => changes.push(path),
    })
    await watcher.start()
    await waitFor(events, (event) => event.type === "started")

    await writeFile(entry, "export default 1")
    await writeFile(entry, "export default 2")
    await waitFor(events, (event) => event.type === "change")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toBe(entry)
    expect(events.filter((event) => event.type === "change")).toHaveLength(1)
    await watcher.close()
    expect(events.at(-1)).toEqual({ type: "closed" })
  })

  test("reports unowned and ambiguous paths without invoking onChange", async () => {
    const { root, entry, pluginRoot } = await fixture()
    const outside = join(root, "outside.ts")
    const shared = join(root, "shared")
    await mkdir(shared)
    await writeFile(outside, "outside")
    const events: WatcherEvent[] = []
    const changes: string[] = []
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 20,
      bindings: [
        binding("plugin", entry, [pluginRoot]),
        binding("a", join(root, "a.ts"), [shared]),
        binding("b", join(root, "b.ts"), [shared]),
      ],
      onEvent: (event) => events.push(event),
      onChange: (path) => changes.push(path),
    })
    await watcher.start()
    await waitFor(events, (event) => event.type === "started")
    await writeFile(join(shared, "util.ts"), "shared")
    await waitFor(events, (event) => event.type === "ambiguous")
    await writeFile(outside, "outside changed")
    await waitFor(events, (event) => event.type === "unowned")
    expect(changes).toEqual([])
    await watcher.close()
  })

  test("coalesces atomic rename and handles add/unlink", async () => {
    const { root, entry, pluginRoot } = await fixture()
    const events: WatcherEvent[] = []
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 30,
      bindings: [binding("plugin", entry, [pluginRoot])],
      onEvent: (event) => events.push(event),
    })
    await watcher.start()
    await waitFor(events, (event) => event.type === "started")
    await new Promise((resolve) => setTimeout(resolve, 100))
    const temp = join(pluginRoot, ".index.ts.tmp")
    await writeFile(temp, "export default 3")
    await rename(temp, entry)
    await waitFor(events, (event) => event.type === "change")
    expect(events.some((event) => event.type === "change" && event.path === entry)).toBe(true)
    const added = join(pluginRoot, "new.ts")
    await writeFile(added, "new")
    await waitFor(events, (event) => event.path === added)
    await rm(added)
    await waitFor(events, (event) => event.type === "change" && event.path === added)
    await watcher.close()
  })

  test("close prevents pending callbacks and is idempotent", async () => {
    const { root, entry, pluginRoot } = await fixture()
    let callbackCount = 0
    const events: WatcherEvent[] = []
    const watcher = new HostWatcher({
      roots: [root],
      debounceMs: 100,
      bindings: [binding("plugin", entry, [pluginRoot])],
      onEvent: (event) => events.push(event),
      onChange: () => { callbackCount++ },
    })
    await watcher.start()
    await writeFile(entry, "pending")
    await watcher.close()
    await watcher.dispose()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(callbackCount).toBe(0)
    expect(watcher.getWatched()).toEqual({})
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1)
  })
})
