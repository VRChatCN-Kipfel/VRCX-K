// Watch fd 0 for "whoever held the write end is gone" (issue #33).
//
// The host has no self-exit path when started without the Rust shell: every
// teardown route (stdio stop RPC, exit-51 restart) needs a peer on the other
// end. A shell-less host therefore only dies as collateral of its launcher —
// and once that launcher spawns detached, or spawns through the `cmd.exe`
// shim chain `bun run` builds on Windows, the collateral never comes and the
// host is orphaned, still serving its ws port.
//
// The kernel already provides the right signal: a child's stdin pipe closes
// when the last writer dies. Two facts make acting on it safe:
//
//   - EOF only means "launcher gone" when fd 0 is a PIPE. Spawned with
//     `stdin: "ignore"` it is the null device, where reading returns EOF after
//     ~3ms — treating that as a stop signal would kill every such host at
//     startup (measured; the repo's own host tests spawn that way). A TTY or
//     a redirected regular file is likewise not a launcher lifetime, and
//     `isFIFO()` excludes both in one check.
//   - The stream admits exactly ONE reader. With a shell attached the kkrpc
//     transport owns it (stdio.ts), which is why this dedicated watch runs
//     only without a shell — the two never coexist.

import { fstatSync } from "node:fs"

/**
 * Whether fd 0 is a real pipe, i.e. whether some process's lifetime is tied to
 * our stdin. False for a TTY, the null device (`stdin: "ignore"`), a redirected
 * file, or an fd that cannot be stat'ed — none of those report a launcher.
 */
export function stdinIsPipe(fd = 0): boolean {
  try {
    return fstatSync(fd).isFIFO()
  } catch {
    return false
  }
}

/**
 * Call `onClose` when the stdin pipe reaches EOF (or errors — a dead pipe
 * surfaces as either). No-op when fd 0 is not a pipe, so `ignore`/TTY/file
 * launches never self-terminate.
 *
 * This owns stdin's only reader; anything else that wants to read stdin (the
 * kkrpc stdio transport) must not be active at the same time. Returns a
 * disposer for tests — the process exits shortly after `onClose` anyway.
 */
export function watchStdinClose(onClose: () => void): () => void {
  if (!stdinIsPipe()) return () => {}

  const reader = Bun.stdin.stream().getReader()
  let stopped = false
  void (async () => {
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        // Data is not ours to interpret — a probing writer may send bytes we
        // have no protocol for. Drain them; EOF is the only signal we act on.
      }
    } catch {
      // A read error also means the pipe is gone — treat it as closed.
    }
    if (!stopped) onClose()
  })()

  return () => {
    stopped = true
    void reader.cancel().catch(() => {})
  }
}
