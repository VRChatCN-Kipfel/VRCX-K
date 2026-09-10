import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { HOST_VERSION } from "../src/api"
import { drain, killTree, readReady, resolveBun, warmBun } from "./helpers"

const hostDir = join(import.meta.dir, "..")
const bun = resolveBun()
const outfile = join(
  hostDir,
  process.platform === "win32" ? "dist/host-compile-smoke.exe" : "dist/host-compile-smoke",
)

beforeAll(async () => {
  await warmBun()
}, 60_000)

let proc: ReturnType<typeof Bun.spawn> | undefined

// The compiled host is ~85MB; its FIRST spawn after a fresh compile is a cold
// start (AV scan / page cache) that can exceed the 5s default hook budget.
// Give the teardown hook room and wait for the child to actually exit before
// the artifact is unlinked (Windows keeps the file locked while it runs).
afterEach(async () => {
  if (!proc) return
  killTree(proc.pid)
  await proc.exited.catch(() => {})
  proc = undefined
}, 30_000)

afterAll(async () => {
  await unlink(outfile).catch(() => {})
})

test("compiled host finds cordis.yml via cwd", async () => {
  const compile = Bun.spawn([bun, "build", "--compile", "src/index.ts", "--outfile", outfile], {
    cwd: hostDir,
    stdout: "pipe",
    stderr: "pipe",
    // The compile step is a one-shot; detached keeps it from dragging the
    // runner's group into a failure (its own host children get own groups).
    detached: true,
  })
  const compileCode = await compile.exited
  const compileErr = await new Response(compile.stderr).text()
  expect(compileCode, compileErr).toBe(0)
  expect(await Bun.file(outfile).exists()).toBe(true)

  proc = Bun.spawn([outfile], {
    cwd: hostDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Source: the sidecar becomes its own process-group leader (setsid), so
    // killTree's kill(-pid) reaps host + any descendants in one signal — same
    // semantics as the Rust shell's process_group(0) / Job Object.
    detached: true,
  })
  // Cold start of a compiled sidecar is slow on Windows (see afterEach).
  const ready = await readReady(proc.stderr, 60_000)
  expect(ready.port).toBeGreaterThan(0)
  expect(ready.token).toMatch(/^[0-9a-f]{64}$/)
  expect(ready.version).toBe(HOST_VERSION)

  const stdout = await drain(proc.stdout)
  expect(stdout).toBe("")
}, 90_000)
