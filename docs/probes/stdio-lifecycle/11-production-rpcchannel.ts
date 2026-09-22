// 11-production-rpcchannel.ts — DOES THE REAL PRODUCTION WIRING BEHAVE ANY
// DIFFERENTLY FROM MY ISOLATED PLATFORM TEST?
//
// Everything above built `stdioJsonTransport` directly and then either
// subscribed or not. But host/src/stdio.ts never uses the transport bare — it
// wraps it in `new RPCChannel(transport, { expose })`, and RPCChannel
// subscribes internally. So in the REAL host, `subscribe()` is ALWAYS called.
//
// That makes the difference between my "official|sub=0" cell and reality: the
// real host is closer to "official|sub=1".
//
// This probe answers the question the parent actually cares about:
//   "If host/src/stdio.ts switched to nodeStdioTransport(), would
//    transport.onClose fire in the real RPCChannel wiring?"
//
// It builds BOTH wirings end-to-end with a real RPCChannel and a real peer
// speaking newline JSON on stdin, then measures whether the channel closes /
// onClose fires when the peer's write end goes away.
//
// MODE = production | official

import { RPCChannel } from "../../../host/node_modules/kkrpc/dist/mod.js"
import { stdioJsonTransport, nodeStdioTransport, type ReadableLike, type WritableLike } from "../../../host/node_modules/kkrpc/dist/stdio.js"
import { fstatSync } from "node:fs"

const shape = process.env.MODE ?? "production"
const t0 = Date.now()
const events: Array<{ at: number; what: string }> = []
const mark = (what: string) => events.push({ at: Date.now() - t0, what })

let onDoneFired = false
let onCloseFired = false
let onCloseReason: string | null = null
let channelClosed = false

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
          mark("onDone fired")
        }),
        writable: bunWritable(),
        lifecycle: process.stdin,
      })
    : nodeStdioTransport()

const hasOnClose = typeof (transport as any).onClose === "function"
if (hasOnClose) {
  ;(transport as any).onClose((r?: unknown) => {
    if (onCloseFired) return
    onCloseFired = true
    onCloseReason = r === undefined ? "clean(undefined)" : String(r)
    mark("transport.onClose FIRED")
  })
}

// The real production wrapper.
const channel = new RPCChannel<any, any>(transport, {
  expose: {
    ping: () => "pong",
  },
})
mark("RPCChannel constructed (it subscribes internally)")

// Detect channel-level closure without disturbing the transport.
if (typeof (channel as any).onClose === "function") {
  ;(channel as any).onClose(() => {
    channelClosed = true
    mark("RPCChannel.onClose fired")
  })
}

// Also observe the underlying transport close via a peer call that we let hang.
let pendingOutcome: string | null = null
const callStart = Date.now()
void (async () => {
  try {
    // "stop" is not exposed by the peer, so this call will hang until the
    // transport closes. Its rejection latency is the practical consequence of
    // onClose working (or not).
    await (channel as any).call?.("never-answers", {})
    pendingOutcome = `resolved after ${Date.now() - callStart}ms`
  } catch (e) {
    pendingOutcome = `rejected after ${Date.now() - callStart}ms: ${(e as Error)?.name}`
    mark(`pending call ${pendingOutcome}`)
  }
})()

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
        fd0Kind: s,
        hasOnClose,
        transportOnCloseFired: onCloseFired,
        onCloseReason,
        onDoneFired,
        channelClosed,
        pendingOutcome,
        readableFlowingAtTeardown: (process.stdin as any).readableFlowing ?? null,
        events,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}, 5000)
