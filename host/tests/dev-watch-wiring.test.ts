// End-to-end wiring tests for the real `host/src/index.ts` entry script.
//
// They exist because two P0/P1 defects were only reachable through the real
// wiring, not through DevWatch in isolation:
//
//   A. `new URL("./cordis.yml", ctx.baseUrl).pathname` yields "/E:/.../cordis.yml"
//      on Windows; canonicalPath() turns that into "E:\E:\..." so the config
//      hot-refresh never matched and chokidar watched a nonexistent directory.
//   B. a missing cordis.yml used to spin the full 15s include-settle timeout
//      instead of failing fast with the original cause.
//
// The host runs with cwd = a temp directory, so no repository file is touched.
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { killTree, resolveBun, warmBun } from "./helpers"
import { watchKey } from "../src/watch-path"

const hostDir = join(import.meta.dir, "..")
const entryScript = join(hostDir, "src", "index.ts")
const bun = resolveBun()

const roots: string[] = []
const procs: Array<ReturnType<typeof Bun.spawn>> = []

beforeAll(async () => {
  await warmBun()
}, 60_000)

afterEach(async () => {
  for (const proc of procs.splice(0)) killTree(proc.pid)
  // killTree is fire-and-forget; the temp root may still be locked by the
  // dying watcher for a moment.
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
}, 20_000)

/**
 * Incremental stderr reader with a bounded wait for a pattern.
 *
 * A single persistent pump owns the reader: racing `reader.read()` against a
 * timeout would abandon a pending read and silently drop its chunk (which is
 * exactly how a "dev config refreshed" line can vanish).
 */
function stderrReader(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ""
  let ended = false
  const pump = (async () => {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
      }
    } catch {
      // stream errored — treat as ended
    } finally {
      ended = true
    }
  })()
  return {
    get text() {
      return buffer
    },
    async wait(pattern: RegExp, timeoutMs = 20_000): Promise<string> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (pattern.test(buffer)) return buffer
        if (ended) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (pattern.test(buffer)) return buffer
      throw new Error(`timed out waiting for ${pattern}\n${buffer}`)
    },
    async finished() {
      await pump
    },
  }
}

/** Temp host root: cordis.yml + a heartbeat plugin (index.ts asserts readiness). */
async function makeHostRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vrcxk-host-wiring-"))
  roots.push(root)
  await mkdir(join(root, "plugins"), { recursive: true })
  await writeFile(
    join(root, "plugins", "heartbeat.ts"),
    `import type { Context } from "cordis"\n\nexport function apply(ctx: Context) {\n  ctx.provide("heartbeat", { ok: true })\n}\n`,
  )
  await writeFile(join(root, "cordis.yml"), `- id: heartbeat\n  name: ./plugins/heartbeat.ts\n`)
  return root
}

describe("real host entry wiring", () => {
  test("dev watch hot-refreshes cordis.yml through a file:// base URL (Windows path regression)", async () => {
    const root = await makeHostRoot()
    await writeFile(
      join(root, "plugins", "extra.ts"),
      `export function apply() { (globalThis as Record<string, unknown>).__extra = true }\n`,
    )
    const proc = Bun.spawn([bun, entryScript], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Source: host becomes its own process-group leader (setsid), so
      // killTree's kill(-pid) reaps it in one signal (Rust-shell parity).
      detached: true,
      env: { ...process.env, VRCXK_DEV_WATCH: "1", VRCXK_SHELL: "0" },
    })
    procs.push(proc)
    const stderr = stderrReader(proc.stderr)

    await stderr.wait(/dev watch enabled/)
    // The watcher is only live after chokidar's initial scan; writing the
    // config before that would be folded into the scan (ignoreInitial).
    const watching = await stderr.wait(/dev watch watching: .+/, 30_000)
    await stderr.wait(/\[host\] ready /)

    // Deterministic half of the regression: the watch roots come from
    // dirname(configFile). With `.pathname` they were "/e:/..." → canonicalized
    // to "E:\E:\..." instead of the real directory.
    const rootsLine = watching.match(/dev watch watching: (.+)/)![1].trim()
    const watched = rootsLine.split(",").map((path) => watchKey(path.trim()))
    expect(watched).toContain(watchKey(root))

    // Behavioural half: adding an entry must be observed by the watcher. Retry
    // with distinct content because the host primes its config hash right after
    // the initial scan — a write landing in that window looks like "no change".
    let refreshed = false
    let output = ""
    for (let attempt = 0; attempt < 8 && !refreshed; attempt++) {
      await writeFile(
        join(root, "cordis.yml"),
        `- id: heartbeat\n  name: ./plugins/heartbeat.ts\n- id: extra\n  name: ./plugins/extra.ts\n# attempt ${attempt}\n`,
      )
      refreshed = await stderr
        .wait(/dev config refreshed: .*:extra/, 3_000)
        .then((text) => {
          output = text
          return true
        })
        .catch(() => false)
    }
    expect(refreshed, `host stderr:\n${stderr.text}`).toBe(true)
    expect(output).toMatch(/dev config refreshed: .*:extra/)
  }, 90_000)

  test("a missing cordis.yml fails fast with the original cause (no 15s hang)", async () => {
    const empty = await mkdtemp(join(tmpdir(), "vrcx-k-empty-cwd-"))
    roots.push(empty)
    const started = Date.now()
    const proc = Bun.spawn([bun, entryScript], {
      cwd: empty,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    procs.push(proc)
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    const elapsed = Date.now() - started

    expect(code).not.toBe(0)
    expect(stderr).toContain("fatal bootstrap error")
    expect(stderr).toMatch(/config file not found|heartbeat plugin failed/)
    // The old behaviour spun INCLUDE_SETTLE_TIMEOUT_MS (15s); the whole point of
    // the fix is a bounded, immediate failure. The strict 5s budget is pinned by
    // ws-heartbeat.test.ts (its own test timeout); here we only need to prove
    // the 15s spin is gone even on a loaded machine.
    expect(elapsed).toBeLessThan(10_000)
  }, 60_000)

  test("a malformed VRCXK_DEV_WATCH_MAP fails with a clear message", async () => {
    const proc = Bun.spawn([bun, entryScript], {
      cwd: hostDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VRCXK_DEV_WATCH: "1", VRCXK_DEV_WATCH_MAP: '{"alpha":"not-an-array"}' },
    })
    procs.push(proc)
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).not.toBe(0)
    expect(stderr).toContain("fatal bootstrap error")
    expect(stderr).toContain('entry "alpha" must map to an array of path strings')
  }, 60_000)

  test("a non-object VRCXK_DEV_WATCH_MAP fails with a clear message", async () => {
    const proc = Bun.spawn([bun, entryScript], {
      cwd: hostDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VRCXK_DEV_WATCH: "1", VRCXK_DEV_WATCH_MAP: "[1,2,3]" },
    })
    procs.push(proc)
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).not.toBe(0)
    expect(stderr).toContain("expected a JSON object mapping entryId -> string[]")
  }, 60_000)
})
