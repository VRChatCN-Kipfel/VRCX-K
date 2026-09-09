// Packaged sidecar smoke (issue #7 Batch A/C): launch the canonical
// `src-tauri/binaries/host-<triple>[.exe]` artifact, verify ready, then a
// graceful stop via the stdio RPC — the same protocol the Rust shell uses.
//
// The artifact is git-ignored and built by `bun run build:host`. When it is
// absent (clean checkout before the build step) these tests skip instead of
// failing; CI/dev must run `bun run build:host` first for real coverage.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { killTree, readReady, warmBun } from "./helpers"

const repoRoot = join(import.meta.dir, "..", "..")

function detectTriple(): string {
  const probe = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" })
  if (probe.status === 0 && probe.stdout) return probe.stdout.trim()
  throw new Error("cannot detect Rust target triple (rustc missing)")
}

const triple = detectTriple()
const artifact = join(
  repoRoot,
  "src-tauri",
  "binaries",
  `host-${triple}${triple.includes("windows") ? ".exe" : ""}`,
)
const available = existsSync(artifact)

beforeAll(async () => {
  if (!available) return
  await warmBun()
}, 60_000)

let proc: ReturnType<typeof Bun.spawn> | undefined

afterAll(() => {
  if (proc) killTree(proc.pid)
  proc = undefined
})

test("canonical sidecar artifact exists (run bun run build:host first)", () => {
  expect(artifact, `missing ${artifact} — build with \`bun run build:host\``).toBeTruthy()
})

test("sidecar launches to ready and stops gracefully via stdio RPC", async () => {
  if (!available) return // skipped when the artifact has not been built yet

  // The packaged shell spawns the sidecar with cwd = resource dir so the
  // host finds cordis.yml/plugins beside itself. In this repo the artifact
  // dir has no runtime seed yet (M1 decision: not bundled), so run with
  // cwd = host/ where the runtime files live — dev-mode parity.
  proc = Bun.spawn([artifact], {
    cwd: join(repoRoot, "host"),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // The Rust shell always marks the child as shell-attached so the host
    // connects the kkrpc/stdio bridge (VRCXK_SHELL=1, see host.rs
    // start_host_process / host/src/index.ts).
    env: { ...process.env, VRCXK_SHELL: "1" },
  })
  const ready = await readReady(proc.stderr)
  expect(ready.port).toBeGreaterThan(0)
  expect(ready.token).toMatch(/^[0-9a-f]{64}$/)
  expect(ready.version).toBe("0.0.1")

  // Graceful stop via the stdio RPC (compact protocol the Rust Peer speaks).
  const frame =
    JSON.stringify({ t: "q", id: "smoke-stop", op: "call", p: ["stop"] }) + "\n"
  proc.stdin!.write(frame)
  await proc.stdin!.flush?.()
  proc.stdin!.end?.()
  const exited = await proc.exited
  expect(exited).toBe(0)
}, 90_000)
