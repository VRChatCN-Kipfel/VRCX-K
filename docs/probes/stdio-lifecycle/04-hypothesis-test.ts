// 04-hypothesis-test.ts — THE DISCRIMINATING PROBE.
//
// Established so far:
//   * production shape  → pump onDone fires (~875ms), platform.onClose NEVER
//   * official shapes   → nothing fires at all (onClose=false)
//   * stdin-only+resume → raw stdin 'end'@883 and 'close'@883 DO fire
//
// HYPOTHESIS H: process.stdin emits 'end'/'close' only in FLOWING mode, and
//   kkrpc's stdioPlatform never resumes the stream it is handed. The official
//   shape therefore fails because of *paused mode*, NOT because of any lock.
//   (In the production shape the ReadableStream reader ALSO blocks stdin — but
//   that is a second, independent defect.)
//
// FALSIFIABLE PREDICTIONS:
//   P1  official shape + explicit `process.stdin.resume()` → onClose FIRES.
//   P2  the SAME resume() applied to the production shape does NOT make
//       onClose fire (the lock, not flow mode, governs there) — and in fact
//       resume() THROWS ERR_INVALID_STATE, because the pump owns the native
//       reader. If P2 instead shows onClose firing, H is wrong.
//   P3  A LOCK-FREE, PAUSED control: readable = a plain EventEmitter stub
//       (never touches the native stream), lifecycle = process.stdin, no
//       resume → onClose must NOT fire. This isolates "paused" from "locked":
//       with no lock present at all, paused still suppresses it.
//   P4  The same stub WITHOUT the lock but WITH resume → onClose FIRES.
//
// P3/P4 are the crucial cells: they contain NO lock whatsoever, so if the
// difference between them is flow mode, then flow mode — not the lock — is what
// the official shape is missing.

import { stdioJsonTransport, type ReadableLike, type WritableLike } from "../../../host/node_modules/kkrpc/dist/stdio.js"
import { EventEmitter } from "node:events"
import { fstatSync } from "node:fs"

const mode = process.env.MODE ?? "official-resume"
const t0 = Date.now()
const events: Array<{ at: number; what: string }> = []
const mark = (what: string) => events.push({ at: Date.now() - t0, what })

const fd0Kind = (() => {
  try {
    const s = fstatSync(0)
    return `fifo=${s.isFIFO()} socket=${s.isSocket()} chr=${s.isCharacterDevice()} file=${s.isFile()}`
  } catch (e) {
    return `stat-failed:${String(e)}`
  }
})()

let onCloseFired = false
let onCloseReason: string | null = null
let hasOnClose = false
let setupError: string | null = null
let resumeError: string | null = null
let onDoneFired = false
let pumpErr: string | null = null
let pumpDone = false
let usedStub = false

const att = (name: string, fn: () => void) => {
  try {
    fn()
  } catch (e) {
    const msg = `${(e as Error).name}: ${(e as Error).message}`
    if (name === "resume") resumeError = msg
    else setupError = msg
    mark(`${name} THREW ${msg}`)
  }
}

// A lock-free readable: never calls getReader(), never touches the native
// stream. Used for the P3/P4 control cells.
class StubReadable implements ReadableLike {
  private listeners = new Set<(c: Uint8Array | string) => void>()
  on(_e: "data", l: (c: Uint8Array | string) => void) {
    this.listeners.add(l)
    return this
  }
  off(_e: "data", l: (c: Uint8Array | string) => void) {
    this.listeners.delete(l)
    return this
  }
}

class ReadableStreamLike implements ReadableLike {
  private listeners = new Set<(chunk: Uint8Array | string) => void>()
  constructor(
    private readonly stream: ReadableStream<Uint8Array>,
    private readonly onDone?: () => void,
  ) {
    void this.pump(stream)
  }
  on(_e: "data", l: (c: Uint8Array | string) => void) {
    this.listeners.add(l)
    return this
  }
  off(_e: "data", l: (c: Uint8Array | string) => void) {
    this.listeners.delete(l)
    return this
  }
  private async pump(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    mark("legacy getReader() acquired (native reader now owned by pump)")
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) {
          pumpDone = true
          mark("legacy pump done:true")
          this.onDone?.()
          return
        }
        for (const l of this.listeners) l(r.value)
      }
    } catch (e) {
      pumpErr = `${(e as Error).name}: ${(e as Error).message}`
    } finally {
      reader.releaseLock()
    }
  }
}

function bunWritable(): WritableLike {
  return {
    write(chunk, callback) {
      void Bun.write(Bun.stdout, chunk).then(
        () => callback?.(),
        (e) => callback?.(e instanceof Error ? e : new Error(String(e))),
      )
    },
  }
}

let readable: ReadableLike
let lifecycle: any = process.stdin

switch (mode) {
  case "official-resume":
    readable = process.stdin as unknown as ReadableLike
    break
  case "production-resume":
    readable = new ReadableStreamLike(Bun.stdin.stream(), () => {
      onDoneFired = true
      mark("onDone fired")
    })
    break
  case "stub-paused":
    readable = new StubReadable()
    usedStub = true
    break
  case "stub-resume":
    readable = new StubReadable()
    usedStub = true
    break
  default:
    throw new Error(`unknown MODE ${mode}`)
}

const transport = stdioJsonTransport({
  readable,
  writable: mode.startsWith("production") ? bunWritable() : (process.stdout as unknown as WritableLike),
  lifecycle,
})

hasOnClose = typeof (transport as any).onClose === "function"
if (hasOnClose) {
  ;(transport as any).onClose((reason?: unknown) => {
    if (onCloseFired) return
    onCloseFired = true
    onCloseReason =
      reason === undefined
        ? "clean(undefined)"
        : `${(reason as Error)?.name ?? "?"}: ${(reason as Error)?.message ?? String(reason)}`
    mark("platform.onClose FIRED")
  })
}

mark(`shape=${mode} built`)

// Raw stdin events, contained (a lock can make .on() throw under bun).
let rawAttachError: string | null = null
att("attach", () => {
  process.stdin.on("error", (e: any) => mark(`stdin:error:${e?.name}`))
  process.stdin.on("end", () => mark("stdin:end"))
  process.stdin.on("close", () => mark("stdin:close"))
})
try {
  process.stdin.on("end", () => {})
} catch (e) {
  rawAttachError = `${(e as Error).name}: ${(e as Error).message}`
}

// The intervention: resume stdin (put it in flowing mode) where the cell says so.
if (mode.endsWith("-resume")) {
  att("resume", () => {
    ;(process.stdin as any).resume()
    mark("stdin.resume() called")
  })
}

mark("ready")

setTimeout(() => {
  console.log(
    JSON.stringify(
      {
        mode,
        usedStub,
        fd0Kind,
        hasOnClose,
        onCloseFired,
        onCloseReason,
        onDoneFired,
        legacyPumpDoneCalled: pumpDone,
        legacyPumpError: pumpErr,
        resumeError,
        rawAttachError,
        setupError,
        readableFlowingAtTeardown: (process.stdin as any).readableFlowing ?? null,
        stdinIsPausedAtTeardown:
          typeof (process.stdin as any).isPaused === "function" ? (process.stdin as any).isPaused() : null,
        events,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}, 5000)
