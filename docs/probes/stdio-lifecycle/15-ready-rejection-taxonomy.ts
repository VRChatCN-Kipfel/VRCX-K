// 15-ready-rejection-taxonomy.ts — what can `shell.ready(...)` ACTUALLY reject
// with, and can that set be discriminated?
//
// Why this exists: host/src/index.ts absorbs a failed `shell.ready` so that a
// shell dying mid-handshake (issue #33) does not race the stdin-loss path for
// the exit code. That catch used to swallow EVERY rejection, which also hid
// genuine startup failures. Narrowing it is only defensible if the reachable
// error shapes are (a) enumerated and (b) distinguishable — so measure them
// instead of reasoning from the bundle.
//
// Measured cells:
//   A. peer closes mid-call            -> RPCTransportClosedError
//   B. peer replies with an error      -> plain Error (unknown method / handler threw)
//   C. peer never replies              -> RPCTimeoutError (channel default 30s)
//   D. channel.destroy() while pending -> plain Error ("RPC channel destroyed")
//
// and the module-identity check that decides whether `instanceof` is trustworthy
// across the bare "kkrpc" specifier that host/src uses and the explicit path this
// probe uses (a bundle-chunk split would silently break the narrowing).
//
// Result (bun 1.4.2, Windows x64, kkrpc 2.1.0): A is the only
// RPCTransportClosedError; B/C/D are plain Errors that `instanceof` correctly
// rejects. `sameClassObject === true`, so the narrowing works under either
// specifier.

import { RPCChannel, RPCTransportClosedError as ViaBare } from "kkrpc"
import { RPCTransportClosedError as ViaPath } from "../../../host/node_modules/kkrpc/dist/mod.js"
import type { Transport, RPCMessage } from "../../../host/node_modules/kkrpc/dist/mod.js"

// Mirrors host/tests/tray-wire.test.ts: `subscribe` returns an unsubscribe, and
// `onClose` is a separate optional hook. (Getting this shape wrong makes
// `destroy()` throw "this.unsubscribe is not a function".)
function memoryTransport() {
  let listener: ((message: RPCMessage) => void) | undefined
  let closeListener: ((reason?: unknown) => void) | undefined
  const sent: RPCMessage[] = []
  const transport: Transport<RPCMessage> = {
    send(message) {
      sent.push(message)
    },
    subscribe(next) {
      listener = next
      return () => {
        listener = undefined
      }
    },
    onClose(next) {
      closeListener = next as (reason?: unknown) => void
      return () => {
        closeListener = undefined
      }
    },
  } as unknown as Transport<RPCMessage>
  return {
    transport,
    sent,
    deliver(message: unknown) {
      listener?.(message as RPCMessage)
    },
    /** Simulate the peer's end of stdio closing (shell death). */
    killPeer(reason?: unknown) {
      closeListener?.(reason)
    },
  }
}

function describe(e: unknown) {
  if (!(e instanceof Error)) return `non-error: ${String(e)}`
  return {
    ctor: e.constructor.name,
    name: e.name,
    message: e.message,
    isTransportClosed: e instanceof ViaPath,
  }
}

const results: Record<string, unknown> = {}

// ── 0. module identity across specifiers (guards the instanceof narrowing) ──
results.sameClassObject = ViaBare === ViaPath

// ── A. peer closes mid-call ────────────────────────────────────────────────
{
  const wire = memoryTransport()
  const ch = new RPCChannel(wire.transport, { expose: {} })
  const call = ch.getAPI().ready({ port: 1, token: "t" }).catch((e: unknown) => e)
  await new Promise((r) => setTimeout(r, 20))
  wire.killPeer(new Error("stdin gone"))
  const err = await call
  results.A_peer_closed_mid_call = describe(err)
  results.A_instanceof_bareSpecifier = err instanceof ViaBare
}

// ── B. peer replies with an error (unknown method / handler threw) ─────────
{
  const wire = memoryTransport()
  const ch = new RPCChannel(wire.transport, { expose: {} })
  const call = ch.getAPI().ready({ port: 1, token: "t" }).catch((e: unknown) => e)
  await new Promise((r) => setTimeout(r, 20))
  // Use the real request id off the wire so the reply actually matches.
  const req = wire.sent[0] as { id?: string } | undefined
  // Exactly the frame src-tauri/src/kkrpc_peer.rs writes for an unknown method.
  wire.deliver({ t: "r", id: req?.id, e: { m: "unknown RPC method: ready" } })
  results.B_peer_error_reply = describe(await call)
}

// ── C. peer never answers (short channel timeout to keep the probe quick) ──
{
  const wire = memoryTransport()
  const ch = new RPCChannel(wire.transport, { expose: {}, timeout: 60 })
  results.C_peer_silent_timeout = describe(
    await ch.getAPI().ready({ port: 1, token: "t" }).catch((e: unknown) => e),
  )
}

// ── D. channel.destroy() while a call is pending ───────────────────────────
{
  const wire = memoryTransport()
  const ch = new RPCChannel(wire.transport, { expose: {} })
  const call = ch.getAPI().ready({ port: 1, token: "t" }).catch((e: unknown) => e)
  await new Promise((r) => setTimeout(r, 20))
  ch.destroy()
  results.D_channel_destroyed = describe(await call)
}

console.log(JSON.stringify(results, null, 2))

// A is the expected teardown; B/C/D must NOT be classified as transport-closed,
// or the narrowing in host/src/index.ts would swallow real startup failures.
// `sameClassObject` guards the whole premise: if kkrpc ever splits the class
// across chunks, `instanceof` silently stops matching and the catch would
// rethrow shell-death rejections (exit 1) instead of absorbing them.
const a = results.A_peer_closed_mid_call as { isTransportClosed?: boolean }
const isClosed = (k: string) => (results[k] as { isTransportClosed?: boolean })?.isTransportClosed
const ok =
  results.sameClassObject === true &&
  a?.isTransportClosed === true &&
  results.A_instanceof_bareSpecifier === true &&
  isClosed("B_peer_error_reply") === false &&
  isClosed("C_peer_silent_timeout") === false &&
  isClosed("D_channel_destroyed") === false

if (!ok) {
  console.error("\n=== taxonomy assertion FAILED — see the cells above ===")
  process.exitCode = 1
}
