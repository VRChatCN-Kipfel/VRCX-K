// Wire-level test of the host ↔ shell global-shortcut protocol on the real
// kkrpc channel (in-memory transport), mirroring `tray-wire.test.ts`.
//
// It pins the two names the Rust side implements (issue #6 callback):
//   - `shell.shortcut.register` / `shell.shortcut.unregister` (host → shell),
//     whose reply is the canonical-spelling registration object;
//   - `shortcut.pressed` (shell → host notification, i.e. the path
//     ["shortcut","pressed"] on the exposed host API).
//
// The hand-built frames assert the COMPACT protocol shape
// (`{t:"q", op:"call", p:[...], a:[{__kkrpc_next_arg__:"value", v:...}]}`) of
// the pinned dependency `kkrpc 2.1.0`; `src-tauri/src/kkrpc_peer.rs` speaks the
// same shape. Upgrading kkrpc requires re-verifying this file.
import { describe, expect, test } from "bun:test"
import type { RPCMessage, Transport } from "kkrpc"
import { connectShellStdio, type ShortcutPressEvent } from "../src/stdio"

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

describe("host ↔ shell shortcut protocol", () => {
  test("host exposes the shortcut.pressed notification and fans it out", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })
    const seen: ShortcutPressEvent[] = []
    const off = bridge.shortcut.onPress((event) => seen.push(event))
    expect(typeof off).toBe("function")

    wire.deliver({
      t: "q",
      id: "req-1",
      op: "call",
      p: ["shortcut", "pressed"],
      a: [{ accelerator: "shift+control+KeyK", id: 42 }],
    })
    await tick()
    expect(seen).toEqual([{ accelerator: "shift+control+KeyK", id: 42 }])

    // One throwing subscriber must not stop the others, and must not break the
    // RPC channel (the shell keeps notifying).
    const errors: unknown[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      bridge.shortcut.onPress(() => {
        throw new Error("boom")
      })
      wire.deliver({
        t: "q",
        id: "req-2",
        op: "call",
        p: ["shortcut", "pressed"],
        a: [{ accelerator: "shift+control+KeyK", id: 42 }],
      })
      await tick()
    } finally {
      console.error = originalError
    }
    expect(seen).toHaveLength(2)
    expect(errors).toHaveLength(1)

    off()
    wire.deliver({
      t: "q",
      id: "req-3",
      op: "call",
      p: ["shortcut", "pressed"],
      a: [{ accelerator: "shift+control+KeyK", id: 42 }],
    })
    await tick()
    // The throwing subscriber was never unsubscribed: it is still called, and
    // `seen` must not grow for the unsubscribed one.
    expect(seen).toHaveLength(2)
  })

  test("shortcut.register calls shell.shortcut.register and returns the canonical reply", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })

    const promise = bridge.shortcut.register("CommandOrControl+Shift+K")
    await tick()

    const frame = wire.sent.at(-1) as { id: string; op: string; p: string[]; a: Array<{ v?: unknown }> }
    expect(frame.op).toBe("call")
    expect(frame.p).toEqual(["shell", "shortcut", "register"])
    expect(frame.a[0]?.v).toBe("CommandOrControl+Shift+K")

    // The shell's reply carries the canonical spelling the host must key on.
    wire.deliver({ t: "r", id: frame.id, v: { ok: true, accelerator: "shift+control+KeyK" } })
    expect(await promise).toEqual({ ok: true, accelerator: "shift+control+KeyK" })
  })

  test("shortcut.unregister calls shell.shortcut.unregister", async () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })

    const promise = bridge.shortcut.unregister("shift+control+KeyK")
    await tick()
    const frame = wire.sent.at(-1) as { id: string; p: string[] }
    expect(frame.p).toEqual(["shell", "shortcut", "unregister"])

    wire.deliver({ t: "r", id: frame.id, v: { ok: true, accelerator: "shift+control+KeyK" } })
    expect((await promise).ok).toBe(true)
  })

  test("the remote proxy still forwards the shell.* shortcut surface", () => {
    const wire = memoryTransport()
    const bridge = connectShellStdio({} as never, { transport: wire.transport })
    expect(typeof bridge.shell.shortcut.register).toBe("function")
    expect(typeof bridge.shell.shortcut.unregister).toBe("function")
    expect(typeof bridge.shell.shortcut.isRegistered).toBe("function")
  })
})
