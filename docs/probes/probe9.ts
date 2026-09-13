// Can the host notice that its parent went away? (orphaned dev-host follow-up)
//
// The host never exits on its own (`host/src/index.ts:296`), so every teardown
// path is external: the stdio `stop` RPC, SIGTERM (Unix-only), SIGINT, or exit
// 51 for the shell's supervisor. A host started WITHOUT a shell has none of
// them, and the only remaining signal would be its stdin reaching EOF.
//
// kkrpc's stdio transport DOES listen for that: it takes a `lifecycle` object and
// subscribes to its 'end'/'close'/'error'. `host/src/stdio.ts:270` passes
// `process.stdin`. So the question this probe answers is: can `process.stdin`
// actually report EOF in the host's setup?
//
// Answer (measured below): no. `process.stdin` and `Bun.stdin.stream()` are the
// SAME ReadableStream, and the transport locks it at `stdio.ts:268` with
// `getReader()`. After that, every EOF observation route throws
// `ERR_INVALID_STATE: ReadableStream is locked` or silently never fires. The one
// place that does see EOF is the transport's own reader, and
// `ReadableStreamLike.pump()` (stdio.ts:241-252) discards it at `result.done`.
//
// This matters beyond tidiness: it rules out "just read stdin to detect the
// parent dying" as a fix, which is the obvious first idea.
//
// Self-contained: writes its own child fixtures to a temp dir and removes them.
// Errors are captured (never a success-shaped JSON on failure).
//
// Four configurations, same stimulus (parent writes 3 frames, then closes the
// pipe while staying alive so nothing can be blamed on the parent's death):
//   transport — Bun.stdin.stream()            (what stdio.ts:268 reads)
//   resumed   — process.stdin.resume() + data (the obvious fix attempt)
//   locked    — transport FIRST, then resume  (the host's real ordering)
//   double    — transport reader + resume together

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Result = {
  config: string
  frames: number
  sawEof: boolean
  /** Error text recorded by the child, if any (e.g. the locked-stream throw). */
  error: string | null
  log: string[]
}

const out: Record<string, unknown> = {}
const results: Result[] = []

const CHILD = `
import { appendFileSync } from "node:fs"
const logPath = process.env.CHILD_LOG
const config = process.env.CHILD_CONFIG
const rec = (s) => { try { appendFileSync(logPath, s + "\\n") } catch {} }

if (config === "transport" || config === "locked" || config === "double") {
  // Exactly what host/src/stdio.ts:268 does.
  const reader = Bun.stdin.stream().getReader()
  const dec = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) { rec("TRANSPORT EOF"); return }
        rec("TRANSPORT GOT " + JSON.stringify(dec.decode(value)))
      }
    } catch (e) { rec("TRANSPORT THREW " + String(e)) }
  })()
}

if (config === "resumed" || config === "locked" || config === "double") {
  // The obvious "notice the parent died" implementation.
  try {
    process.stdin.on("data", (c) => rec("STDIN GOT " + JSON.stringify(c.toString())))
    process.stdin.on("end", () => rec("STDIN EOF end"))
    process.stdin.on("close", () => rec("STDIN EOF close"))
    process.stdin.resume()
    rec("STDIN RESUME OK")
  } catch (e) { rec("STDIN THREW " + String(e)) }
}

setInterval(() => rec("alive"), 400)
setTimeout(() => process.exit(0), 6000)
await new Promise(() => {})
`

/** Spawn the child for one config, drive it, and collect what it observed. */
async function run(config: string, dir: string): Promise<Result> {
  const logPath = join(dir, `child-${config}.log`)
  await writeFile(logPath, "")
  const childPath = join(dir, `child-${config}.ts`)
  await writeFile(childPath, CHILD)

  const proc = Bun.spawn([process.execPath, childPath], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, CHILD_LOG: logPath, CHILD_CONFIG: config },
  })

  // Let the child install its readers/listeners before anything arrives.
  await new Promise((r) => setTimeout(r, 900))

  for (const n of [1, 2, 3]) {
    proc.stdin!.write(`FRAME${n}\n`)
    proc.stdin!.flush?.()
    await new Promise((r) => setTimeout(r, 200))
  }
  // Close the write end while WE stay alive, so the child's stdin is a closed
  // pipe and the only variable is EOF visibility.
  proc.stdin!.end()
  await new Promise((r) => setTimeout(r, 2500))

  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)
  const text = lines.join("\n")
  const frames = (text.match(/GOT/g) ?? []).length
  const sawEof = /EOF/.test(text)
  const errMatch = text.match(/THREW (.*)/)

  try {
    proc.kill()
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 200))

  return {
    config,
    frames,
    sawEof,
    error: errMatch ? errMatch[1] : null,
    log: lines.filter((l) => !l.startsWith("alive")),
  }
}

async function main(): Promise<void> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), "vrcxk-probe9-"))

    for (const config of ["transport", "resumed", "locked", "double"]) {
      results.push(await run(config, dir))
    }

    const by = (c: string) => results.find((r) => r.config === c)!
    const transport = by("transport")
    const resumed = by("resumed")
    const locked = by("locked")
    const double = by("double")

    out.results = results.map((r) => ({
      config: r.config,
      frames: r.frames,
      sawEof: r.sawEof,
      error: r.error,
      log: r.log,
    }))

    // The transport's own reader is the only surface that works both before and
    // after locking, which is why it is the only one a fix can build on.
    out.transportSeesEof = transport.sawEof && transport.frames === 3
    // Used alone (no transport reader), process.stdin does report EOF — so the
    // failure is specifically about the transport holding the stream.
    out.standaloneStdinSeesEof = resumed.sawEof && resumed.frames === 3
    // With the transport holding the reader, process.stdin is unusable: resume()
    // throws ERR_INVALID_STATE while the transport keeps working normally.
    //
    // NOTE: an earlier draft of this probe read the "double" case as the two
    // readers starving each other (0 frames). That was wrong — the child had
    // called resume() at top level with no try/catch, so the ERR_INVALID_STATE
    // throw was uncaught and killed the process before it could log anything.
    // With the throw contained, the transport delivers all 3 frames: a second
    // reader is REJECTED, it does not steal data.
    out.lockedStreamBlocksStdin =
      locked.error !== null && /locked/i.test(locked.error) && locked.sawEof && locked.frames === 3
    out.secondReaderIsRejectedNotStarving =
      double.error !== null &&
      /locked/i.test(double.error) &&
      double.frames === 3 &&
      double.sawEof === true

    out.ok =
      out.transportSeesEof === true &&
      out.standaloneStdinSeesEof === true &&
      out.lockedStreamBlocksStdin === true &&
      out.secondReaderIsRejectedNotStarving === true
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
