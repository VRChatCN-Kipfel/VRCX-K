// Issue #33 regression suite: a host started WITHOUT the Rust shell must stop
// itself when its launcher's stdin pipe closes, and must NOT stop when stdin
// is not a launcher lifetime (the null device `ignore` spawns use).
//
// Before the fix every teardown route needed an external peer, so a shell-less
// host only died as its launcher's collateral — and launchers that spawn
// detached (or go through `bun run`'s cmd.exe shim chain on Windows) never
// delivered it. See docs/probes/probe10.ts for the detached measurement and
// host/src/stdin-watch.ts for why EOF is guarded by an fd check: `ignore`
// reaches EOF in ~3ms, so an unguarded "EOF means stop" would kill every
// ignore-spawned host at startup.

import { afterEach, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { dispose, wrap } from "kkrpc"
import { webSocketClientTransport } from "kkrpc/ws"
import type { HostWsAPI } from "../src/api"
import { HOST_SPAWN_DETACHED, killTree, readReady, resolveBun, warmBun } from "./helpers"

const hostDir = join(import.meta.dir, "..")
const bun = resolveBun()

beforeAll(async () => {
  await warmBun()
}, 60_000)

let proc: ReturnType<typeof Bun.spawn> | undefined

afterEach(() => {
  if (proc) killTree(proc.pid)
  proc = undefined
})

/** Fail the test with `what` instead of hanging when `promise` never settles. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} (deadline ${ms}ms)`)), ms),
    ),
  ])
}

test("shell-less host stops itself when the launcher's stdin pipe closes", async () => {
  proc = Bun.spawn([bun, "src/index.ts"], {
    cwd: hostDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: HOST_SPAWN_DETACHED,
    env: { ...process.env, VRCXK_SHELL: "0" },
  })
  await readReady(proc.stderr)
  // Let the stdin watch take its reader before we pull the pipe.
  await new Promise((r) => setTimeout(r, 300))

  // The launcher disappearing IS the write end going away.
  proc.stdin!.end?.()

  const code = await withDeadline(proc.exited, 20_000, "host did not stop after stdin closed")
  expect(code).toBe(0)
}, 30_000)

test("shell-less host does NOT stop when stdin is the null device", async () => {
  proc = Bun.spawn([bun, "src/index.ts"], {
    cwd: hostDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: HOST_SPAWN_DETACHED,
    env: { ...process.env, VRCXK_SHELL: "0" },
  })
  const ready = await readReady(proc.stderr)

  // A missing fd guard would surface the null device's immediate EOF (~3ms) as
  // a stop signal and kill the host at startup — give it ample time to misfire.
  let exited: number | null = null
  await Promise.race([
    proc.exited.then((code) => (exited = code)),
    new Promise((r) => setTimeout(r, 2500)),
  ])
  expect(exited).toBe(null)

  // Still serving, not just still alive.
  const api = wrap<HostWsAPI>(
    webSocketClientTransport({ url: `ws://127.0.0.1:${ready.port}?token=${ready.token}` }),
  )
  expect(await api.ping()).toBe("pong")
  dispose(api)
}, 60_000)

test("shell-attached host stops when the shell end of stdin goes away", async () => {
  proc = Bun.spawn([bun, "src/index.ts"], {
    cwd: hostDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: HOST_SPAWN_DETACHED,
    env: { ...process.env, VRCXK_SHELL: "1" },
  })
  await readReady(proc.stderr)
  // Let connectShellStdio's transport take its reader before we pull the pipe.
  await new Promise((r) => setTimeout(r, 500))

  // No stop RPC — closing the write end is the "shell died" signal (#33). The
  // host is free to be mid-`await shell.ready` when it lands.
  proc.stdin!.end?.()

  const code = await withDeadline(proc.exited, 20_000, "host did not stop after the shell end closed")
  expect(code).toBe(0)
}, 40_000)

test("stdinIsPipe classifies the real fd 0 (pipe vs ignore)", async () => {
  const moduleUrl = pathToFileURL(join(hostDir, "src", "stdin-watch.ts")).href
  const ask = (stdin: "pipe" | "ignore") =>
    Bun.spawn(
      [
        bun,
        "-e",
        `import(${JSON.stringify(moduleUrl)}).then((m) => console.log(m.stdinIsPipe()))`,
      ],
      { cwd: hostDir, stdin, stdout: "pipe", stderr: "pipe" },
    )

  const piped = ask("pipe")
  piped.stdin!.end?.()
  expect((await new Response(piped.stdout).text()).trim()).toBe("true")
  await piped.exited

  const ignored = ask("ignore")
  expect((await new Response(ignored.stdout).text()).trim()).toBe("false")
  await ignored.exited
}, 30_000)
