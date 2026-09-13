// Why does a dev host survive its parent? (orphaned dev-host follow-up)
//
// This is the decisive probe for the orphan issue, and it settles a question
// three earlier drafts got wrong. The host never exits on its own
// (`host/src/index.ts:296`), so a host started without a shell can only be
// reaped by something outside it. The obvious suspect is stdin EOF — the kkrpc
// transport subscribes to `process.stdin` as its `lifecycle`
// (`host/src/stdio.ts:270`). probe9.ts rules that out: `process.stdin` and
// `Bun.stdin.stream()` are the same ReadableStream and the transport locks it, so
// EOF is not observable from outside the transport.
//
// The real variable is `detached`, documented in bun-types as:
//
//   "Run the child in a separate process group, detached from the parent.
//    - POSIX: calls setsid() ... It can outlive the parent ...
//    - Windows: sets UV_PROCESS_DETACHED, allowing the child to outlive the parent"
//
// Measured here with the REAL host and a single variable changed:
//
//   detached: false  -> host is gone within a second of the parent exiting
//   detached: true   -> host keeps serving its ws port indefinitely
//
// That is the whole bug. `bun run dev:host` is not detached, so it rides along
// with whoever started it; the repo's own host tests all pass `detached: true`
// (to make `killTree`'s POSIX `kill(-pid)` group-kill work), which on Windows
// buys the child permission to outlive the test process — so whenever a test run
// is interrupted before `afterEach` fires, its host is left behind.
//
// Liveness is a TCP connect to the port the host itself reported in its
// `[host] ready` line. Not a log grep, not a process listing: both produced
// self-contradictory verdicts in earlier drafts.
//
// Self-contained: fixtures go to a temp dir and are removed. Every host it
// starts is killed before returning.
//
// Run: bun docs/probes/probe10.ts

import { readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * The middle process: spawns the real host, reports what the host said, then
 * exits on its own — closing whatever it held open.
 *
 * It is a separate file so the host's own lifetime is independent of this probe.
 * `detached` is the ONLY difference between trials.
 */
const MIDDLE = `
import { appendFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const repo = process.env.REPO_ROOT
const stateFile = process.env.STATE_FILE
const logFile = process.env.MIDDLE_LOG
const hostDetached = process.env.HOST_DETACHED === "1"

const log = (s) => { try { appendFileSync(logFile, s + "\\n") } catch {} }
log("middle start pid=" + process.pid + " hostDetached=" + hostDetached)

const host = Bun.spawn([process.execPath, join(repo, "host", "src", "index.ts")], {
  cwd: join(repo, "host"),
  stdin: "ignore",
  stdout: "ignore",
  stderr: "pipe",
  detached: hostDetached,
  env: { ...process.env, VRCXK_SHELL: "0" },
})
log("host spawned pid=" + host.pid)

void (async () => {
  const reader = host.stderr.getReader()
  const dec = new TextDecoder()
  let buf = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      const m = buf.match(/\\[host\\] ready (\\{.*\\})/)
      if (m) {
        const info = JSON.parse(m[1])
        log("host ready port=" + info.port)
        writeFileSync(stateFile, JSON.stringify({
          host: host.pid, port: info.port, middle: process.pid, hostDetached,
        }))
      }
    }
  } catch { /* stream ended */ }
})()

// Exit normally after the host has booted. The default (non-detached) contract is
// that the host goes with us; detached asks for the opposite.
setTimeout(() => { log("middle exiting"); process.exit(0) }, 3000)
`

type State = { host: number; port: number; middle: number; hostDetached: boolean }

/** True when something is listening on `port` — the host's own ws endpoint. */
function portAlive(port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port })
    const finish = (ok: boolean): void => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once("connect", () => finish(true))
    sock.once("timeout", () => finish(false))
    sock.once("error", () => finish(false))
  })
}

/** Kill a host by pid, with a taskkill fallback (it is not our child). */
function killPid(pid: number): void {
  try {
    process.kill(pid)
  } catch {
    /* already gone */
  }
  try {
    Bun.spawnSync(["taskkill", "/F", "/PID", String(pid)], {
      stdio: ["ignore", "ignore", "ignore"],
    })
  } catch {
    /* not on Windows, or already gone */
  }
}

type Trial = {
  tag: string
  hostDetached: boolean
  /** Times the host's port answered after the middle exited (out of `samples`). */
  aliveAfter: number
  samples: number
  /** Sanity check: the host must be serving while the middle is still alive. */
  servedWhileParentAlive: boolean
}

const trials: Trial[] = []
const out: Record<string, unknown> = {}

async function trial(dir: string, hostDetached: boolean, samples = 8): Promise<void> {
  const tag = hostDetached ? "detached" : "inherited"
  const stateFile = join(dir, `state-${tag}.json`)
  const middleLog = join(dir, `middle-${tag}.log`)
  const middlePath = join(dir, `middle-${tag}.ts`)
  writeFileSync(stateFile, "")
  writeFileSync(middleLog, "")
  writeFileSync(middlePath, MIDDLE)

  const middle = Bun.spawn([process.execPath, middlePath], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // The middle itself is detached so that ITS exit is what we measure — if it
    // were a child of this probe, this probe's own teardown could be the cause.
    detached: true,
    env: {
      ...process.env,
      REPO_ROOT: repoRoot,
      STATE_FILE: stateFile,
      MIDDLE_LOG: middleLog,
      HOST_DETACHED: hostDetached ? "1" : "0",
    },
  })

  // Wait for the middle to report the host's port.
  let state: State | undefined
  for (let i = 0; i < 300; i++) {
    const txt = readFileSync(stateFile, "utf8").trim()
    if (txt) {
      state = JSON.parse(txt) as State
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  if (!state) {
    trials.push({ tag, hostDetached, aliveAfter: -1, samples, servedWhileParentAlive: false })
    out[`${tag}Failure`] = readFileSync(middleLog, "utf8").trim() || "no ready host reported"
    try {
      middle.kill()
    } catch {
      /* already gone */
    }
    return
  }

  // Confirm the host is actually serving before we take the parent away.
  await new Promise((r) => setTimeout(r, 300))
  const servedWhileParentAlive = await portAlive(state.port)

  await middle.exited

  let aliveAfter = 0
  for (let i = 0; i < samples; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await portAlive(state.port)) aliveAfter++
  }

  trials.push({ tag, hostDetached, aliveAfter, samples, servedWhileParentAlive })
  killPid(state.host)
  await new Promise((r) => setTimeout(r, 300))
}

async function main(): Promise<void> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), "vrcxk-probe10-"))

    await trial(dir, false)
    await trial(dir, true)

    out.trials = trials

    const inherited = trials.find((t) => t.hostDetached === false)
    const detached = trials.find((t) => t.hostDetached === true)

    // Both trials must have observed a working host first, otherwise a "gone"
    // result would just mean the host never started.
    out.bothHostsServedInitially =
      inherited?.servedWhileParentAlive === true && detached?.servedWhileParentAlive === true

    // The finding: detachment alone decides whether the host outlives its parent.
    out.inheritedHostDiesWithParent = inherited?.aliveAfter === 0
    out.detachedHostSurvivesParent =
      detached !== undefined && detached.aliveAfter === detached.samples

    out.ok =
      out.bothHostsServedInitially === true &&
      out.inheritedHostDiesWithParent === true &&
      out.detachedHostSurvivesParent === true
  } catch (e) {
    out.ok = false
    out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  console.log(JSON.stringify(out, null, 2))
  if (out.ok !== true) process.exitCode = 1
}

await main()
