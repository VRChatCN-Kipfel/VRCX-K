import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { binding } from "../src/watch-path"
import { HostWatcher, type WatcherEvent } from "../src/watcher"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function waitFor<T>(items: T[], predicate: (item: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3_000
    const poll = () => {
      const found = items.find(predicate)
      if (found) return resolve(found)
      if (Date.now() >= deadline) return reject(new Error("timed out"))
      setTimeout(poll, 10)
    }
    poll()
  })
}

test("reports onChange failure and continues watching", async () => {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-watcher-error-"))
  roots.push(root)
  const entry = join(root, "entry.ts")
  await writeFile(entry, "old")
  const events: WatcherEvent[] = []
  const watcher = new HostWatcher({
    roots: [root],
    debounceMs: 20,
    bindings: [binding("entry", entry, [root])],
    onEvent: (event) => events.push(event),
    onChange: () => { throw new Error("reload failed") },
  })
  await watcher.start()
  await waitFor(events, (event) => event.type === "started")
  await writeFile(entry, "new")
  const error = await waitFor(events, (event) => event.type === "error")
  expect(error.path).toBe(entry)
  expect(error.error).toBeInstanceOf(Error)
  await watcher.close()
})
