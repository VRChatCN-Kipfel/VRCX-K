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

afterEach(() => {
  if (proc) killTree(proc.pid)
  proc = undefined
})

afterAll(async () => {
  await unlink(outfile).catch(() => {})
})

test("compiled host finds cordis.yml via cwd", async () => {
  const compile = Bun.spawn([bun, "build", "--compile", "src/index.ts", "--outfile", outfile], {
    cwd: hostDir,
    stdout: "pipe",
    stderr: "pipe",
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
  })
  const ready = await readReady(proc.stderr)
  expect(ready.port).toBeGreaterThan(0)
  expect(ready.token).toMatch(/^[0-9a-f]{64}$/)
  expect(ready.version).toBe(HOST_VERSION)

  const stdout = await drain(proc.stdout)
  expect(stdout).toBe("")
}, 90_000)
