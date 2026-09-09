// Wire-level test of the host ↔ shell tray protocol on the real kkrpc channel
// (in-memory transport). This pins the two method names the Rust side
// implements: `shell.tray.setSnapshot` (host → shell request) and
// `tray.action` (shell → host notification, i.e. the path ["tray","action"]
// on the exposed host API).
//
// NOTE: the hand-built frames below assert the COMPACT protocol shape
// (`{t:"q", op:"call", p:[...], a:[{__kkrpc_next_arg__:"value", v:...}]}`) of
// the pinned dependency `kkrpc 2.1.0` (see host/package.json and
// src-tauri/src/kkrpc_stdio.rs, which speaks the same shape). Upgrading kkrpc
// requires re-verifying this file against the new frame format.
import { describe, expect, test } from "bun:test"
import type { RPCMessage, Transport } from "kkrpc"
import { connectShellStdio, type TrayActionEvent } from "../src/stdio"
import type { TrayMenuSnapshot } from "../src/tray-contract.generated"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function memoryTransport() {
  const sent: RPCMessage[] = []
  let listener: ((message: RPCMessage) => void) | undefined
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
  }
  return {
    transport,
    sent,
    /** Deliver one frame as if the Rust shell had sent it. */
    deliver(message: unknown) {
      listener?.(message as RPCMessage)
    },
  }
}

const snapshot: TrayMenuSnapshot = {
  schemaVersion: 1,
  generation: 0,
  revision: 7,
  groups: [
    {
      id: "host.dev",
      order: 0,
      label: null,
      visible: true,
      source: "host",
      items: [
        {
          kind: "action",
          id: "host.dev.reload",
          order: 0,
          label: "Reload",
          enabled: true,
          visible: true,
          action: { target: "host", command: "host.reload", args: [], danger: "safe", confirm: false },
        },
      ],
    },
  ],
}

describe("host ↔ shell tray protocol", () => {
  test("host exposes the tray.action notification and fans it out", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })
    const seen: TrayActionEvent[] = []
    const off = bridge.tray.onAction((action) => seen.push(action))
    expect(typeof off).toBe("function")

    wire.deliver({
      t: "q",
      id: "req-1",
      op: "call",
      p: ["tray", "action"],
      a: [{ id: "host.dev.reload", command: "host.reload", args: ["x"] }],
    })
    await tick()
    expect(seen).toEqual([{ id: "host.dev.reload", command: "host.reload", args: ["x"] }])

    off()
    wire.deliver({
      t: "q",
      id: "req-2",
      op: "call",
      p: ["tray", "action"],
      a: [{ id: "host.dev.reload", command: "host.reload", args: [] }],
    })
    await tick()
    expect(seen).toHaveLength(1)
  })

  test("tray.setSnapshot calls shell.tray.setSnapshot and returns the shell result", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })
    const promise = bridge.tray.setSnapshot(snapshot)
    await tick()

    const frame = wire.sent.at(-1) as { id: string; op: string; p: string[]; a: Array<{ v?: unknown }> }
    expect(frame.op).toBe("call")
    expect(frame.p).toEqual(["shell", "tray", "setSnapshot"])
    // kkrpc value envelope: the single argument carries the snapshot verbatim.
    expect((frame.a[0]?.v as TrayMenuSnapshot | undefined)?.revision).toBe(7)

    wire.deliver({ t: "r", id: frame.id, v: { ok: true, revision: 7 } })
    expect(await promise).toEqual({ ok: true, revision: 7 })
  })

  test("the remote proxy still forwards ready/shell.* through the bridge", () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })
    expect(typeof bridge.ready).toBe("function")
    expect(typeof bridge.shell.notify).toBe("function")
    expect(typeof bridge.shell.devWatchEvent).toBe("function")
    expect(typeof bridge.shell.tray.setSnapshot).toBe("function")
  })
})
