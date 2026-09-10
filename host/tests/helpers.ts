// Shared test helpers: spawn the real bun host and kill its whole process
// tree on every platform.
//
// Why this exists: `Bun.spawn(["bun", ...])` / `spawn("bun", ...)` on Windows
// resolves to the npm *shim* (a script), and killing the shim leaves the real
// `bun.exe` (the host) orphaned and still running — it keeps rewriting
// cordis.yml (Include plugin persists `disabled: true`) and leaks processes.
// We therefore resolve the real bun binary exactly like the Rust shell does
// (see src-tauri/src/host.rs find_bun) and always kill the process tree.
//
// The very first spawn of bun.exe on Windows is a cold start (several
// seconds — AV scan / cache init); subsequent spawns are ~50ms. The
// production shell is long-lived so it never notices, but tests spawn hosts
// repeatedly — `warmBun()` once per file avoids the multi-second stall.

import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

let warmed = false

/** Resolve the real bun executable, mirroring the Rust shell's find_bun. */
export function resolveBun(): string {
  const explicit = process.env.VRCXK_BUN
  if (explicit) return explicit

  const name = process.platform === "win32" ? "bun.exe" : "bun"

  // 1. Standalone install (~/.bun/bin).
  const home = process.env.HOME || process.env.USERPROFILE || homedir()
  const standalone = join(home, ".bun", "bin", name)
  if (existsSync(standalone)) return standalone

  // 2. npm global install: <npm-prefix>/node_modules/bun/bin/bun[.exe].
  //    The shims on PATH (`bun`, `bun.cmd`, `bun.ps1`) all point at it.
  const pathDirs = (process.env.PATH ?? "").split(";").filter(Boolean)
  for (const shimName of ["bun.cmd", "bun.exe", "bun"]) {
    for (const dir of pathDirs) {
      const shim = join(dir, shimName)
      if (!existsSync(shim)) continue
      if (shimName === "bun.ps1") continue
      const viaNodeModules = join(dir, "node_modules", "bun", "bin", name)
      if (existsSync(viaNodeModules)) return viaNodeModules
    }
  }

  // 3. Plain bun[.exe] on PATH.
  for (const dir of pathDirs) {
    const candidate = join(dir, name)
    if (existsSync(candidate) && !candidate.endsWith(".ps1")) return candidate
  }

  // 4. Fallback: bare name (assume it's on PATH).
  return name
}

/**
 * Warm up the bun binary as a child process. The first spawn of bun.exe on
 * Windows is a cold start (seconds); later spawns are fast. Call this once
 * per test file with a generous timeout:
 *
 *   beforeAll(async () => { await warmBun() }, 60_000)
 */
export async function warmBun(): Promise<void> {
  if (warmed) return
  warmed = true
  const bun = resolveBun()
  await new Promise<void>((resolve) => {
    const p = spawn(bun, ["--version"], { stdio: "ignore", windowsHide: true })
    p.once("error", () => resolve())
    p.once("exit", () => resolve())
  })
}

/**
 * Kill a process tree by PID. Windows: taskkill /T /F (tree kill, robust
 * against orphans). Unix: `killProcessGroup(pid)` — the child is spawned with
 * `detached: true` (Bun calls setsid → new process group leader) and its
 * descendants inherit that group, so one `kill(-pgid)` SIGKILLs the whole
 * tree. Non-blocking — the caller should not wait on it inside hooks (a sync
 * taskkill can stall a test hook past its timeout).
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      })
    } else {
      killProcessGroup(pid)
    }
  } catch {
    // Already gone — fine.
  }
}

/** SIGKILL the whole process group whose leader is `pid` (no throw). */
function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // Already gone — fine (ESRCH from a vanished group).
  }
}

/** Synchronous variant used outside hooks (e.g. final cleanup). */
export function killTreeSync(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      })
    } else {
      killProcessGroup(pid)
    }
  } catch {
    // Already gone — fine.
  }
}

/** Read the host's `[host] ready {...}` line from its stderr stream. */
export async function readReady(
  stderr: ReadableStream<Uint8Array>,
  timeoutMs = 15_000,
): Promise<{ port: number; token: string; version: string }> {
  const reader = stderr.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const match = buf.match(/\[host\] ready ({.*})/)
    if (match) {
      reader.releaseLock()
      return JSON.parse(match[1]) as { port: number; token: string; version: string }
    }
  }
  throw new Error(`host did not become ready\n${buf}`)
}

/** Drain a stream for `ms` milliseconds and return what was buffered. */
export async function drain(stream: ReadableStream<Uint8Array>, ms = 200): Promise<string> {
  const reader = stream.getReader()
  let buf = ""
  const decoder = new TextDecoder()
  const timer = setTimeout(() => reader.cancel().catch(() => {}), ms)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
  } catch {
    // cancelled
  } finally {
    clearTimeout(timer)
  }
  return buf
}
