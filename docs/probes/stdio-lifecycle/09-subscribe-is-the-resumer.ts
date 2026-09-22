// 09-subscribe-is-the-resumer.ts — THE DECISIVE FINAL PREDICTION.
//
// Chain of evidence:
//   07: on("data") alone flips process.stdin to flowing=true; on("end"),
//       on("close"), on("error") do NOT.
//   05: official shape, attach=0, resume=0  → onClose does NOT fire
//   06: official shape, RESUME=0, but calls transport.subscribe() → onClose DOES fire
//   kkrpc's subscribe() attaches `readable.on("data", onData)`
//       (kkrpc-src/stdio.ts:147), and in the official shape readable===process.stdin.
//
// PREDICTION (falsifiable): in the official shape with NO resume() and NO probe
// listeners, calling transport.subscribe() is BY ITSELF sufficient to make
// onClose fire, and it does so at the same latency as the teardown.
// Conversely, in the production shape, subscribe() must NOT help, because
// kkrpc attaches "data" to the ReadableStreamLike stub, which never touches
// the native stream.
//
// MODE = official | production
// SUBSCRIBE = 0 | 1

import { stdioJsonTransport, type ReadableLike, type WritableLike } from "../../../host/node_modules/kkrpc/dist/stdio.js"
import { fstatSync } from "node:fs"

const shape = process.env.MODE ?? "official"
const doSubscribe = process.env.SUBSCRIBE === "1"
const t0 = Date.now()
const events: Array<{ at: number; what: string }> = []
const mark = (what: string) => events.push({ at: Date.now() - t0, what })

let onCloseFired = false
let onCloseReason: string | null = null
let onDoneFired = false
let chunks = 0

class ReadableStreamLike implements ReadableLike {
  private listeners = new Set<(c: Uint8Array | string) => void>()
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
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) {
          mark("pump done:true")
          this.onDone?.()
          return
        }
        for (const l of this.listeners) l(r.value)
      }
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

const transport =
  shape === "production"
    ? stdioJsonTransport({
        readable: new ReadableStreamLike(Bun.stdin.stream(), () => {
          onDoneFired = true
        }),
        writable: bunWritable(),
        lifecycle: process.stdin,
      })
    : stdioJsonTransport({
        readable: process.stdin as unknown as ReadableLike,
        writable: process.stdout as unknown as WritableLike,
        lifecycle: process.stdin,
      })

const hasOnClose = typeof (transport as any).onClose === "function"
if (hasOnClose) {
  ;(transport as any).onClose((r?: unknown) => {
    if (onCloseFired) return
    onCloseFired = true
    onCloseReason = r === undefined ? "clean(undefined)" : String(r)
    mark("platform.onClose FIRED")
  })
}

// THE SINGLE VARYING INTERVENTION.
if (doSubscribe) {
  transport.subscribe(() => {
    chunks++
  })
  mark("transport.subscribe() called (attaches readable.on('data'))")
}

mark("ready")

setTimeout(() => {
  const s = (() => {
    try {
      const st = fstatSync(0)
      return `fifo=${st.isFIFO()} socket=${st.isSocket()} chr=${st.isCharacterDevice()}`
    } catch (e) {
      return `stat-failed:${String(e)}`
    }
  })()
  console.log(
    JSON.stringify(
      {
        shape,
        doSubscribe,
        fd0Kind: s,
        hasOnClose,
        onCloseFired,
        onCloseReason,
        onDoneFired,
        chunks,
        readableFlowingAtTeardown: (process.stdin as any).readableFlowing ?? null,
        events,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}, 5000)
