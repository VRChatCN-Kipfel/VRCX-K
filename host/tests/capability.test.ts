import { describe, expect, test } from "bun:test"
import { Context } from "cordis"
import { createShellCapabilities, ShellHandle } from "../src/capability"
import type { ShellStdioBridge } from "../src/stdio"

// Acceptance ⑥ for M2-1: a plugin reaches tray/notify/dialog through BOTH the
// curated domain services and the raw `ctx.shell` mirror, and each call is
// attributed to the calling plugin. `seen` proves the call reached the shell;
// `audit` proves the capability layer knew who called.
function fakeBridge(seen: string[]): ShellStdioBridge {
  const shell: ShellStdioBridge["shell"] = {
    notify: async (title, body) => {
      seen.push(`notify:${title}:${body}`)
      return true
    },
    dialog: {
      message: async (text) => {
        seen.push(`message:${text}`)
        return true
      },
      ask: async () => "",
      pickFile: async () => null,
    },
    openUrl: async () => true,
    openPath: async () => true,
    reveal: async () => true,
    shortcut: {
      register: async (accelerator) => {
        seen.push(`register:${accelerator}`)
        return { ok: true }
      },
      unregister: async () => ({ ok: true }),
      isRegistered: async () => false,
    },
    window: {
      show: async () => true,
      hide: async () => true,
      minimize: async () => true,
      maximize: async () => true,
      unmaximize: async () => true,
      focus: async () => true,
      close: async () => true,
    },
    app: {
      info: async () => ({ name: "VRCX-K", version: "0.0.1", identifier: "com.vrcxk.app" }),
      exit: async () => true,
    },
    path: {
      dir: async () => ({ config: "", data: "", cache: "", temp: "", home: "" }),
      resolve: async () => "",
    },
    devWatchEvent: async () => true,
    tray: {
      setSnapshot: async () => {
        seen.push("tray")
        return { ok: true, revision: 1 }
      },
    },
  }
  return {
    ready: async () => {},
    shell,
    tray: { setSnapshot: async () => ({ ok: true, revision: 1 }), onAction: () => () => {} },
    shortcut: { register: async () => ({ ok: true }), unregister: async () => ({ ok: true }), onPress: () => () => {} },
  }
}

describe("capability surface (M2-1)", () => {
  test("both the curated and raw paths reach the shell and are attributed", async () => {
    const seen: string[] = []
    const audit: string[] = []
    const ctx = new Context()
    const handle = new ShellHandle((line) => audit.push(line))
    createShellCapabilities(ctx, handle)
    handle.attach(fakeBridge(seen))

    await ctx.plugin(function capabilityPlugin(inner: Context) {
      void inner.notify.send("hello", "world")
      void inner.dialog.message("curated")
      void inner.shell.notify("raw", "title")
      void inner.shell.dialog.message("raw-dialog")
      void inner.shell.tray.setSnapshot({ groups: [] } as never)
    })

    expect(seen).toContain("notify:hello:world")
    expect(seen).toContain("message:curated")
    expect(seen).toContain("notify:raw:title")
    expect(seen).toContain("message:raw-dialog")
    expect(seen).toContain("tray")

    const lines = audit.join("\n")
    expect(lines).toContain("capabilityPlugin -> notify.send")
    expect(lines).toContain("capabilityPlugin -> dialog.message")
    expect(lines).toContain("capabilityPlugin -> shell.notify")
    expect(lines).toContain("capabilityPlugin -> shell.dialog.message")
    expect(lines).toContain("capabilityPlugin -> shell.tray.setSnapshot")
  })

  test("with no shell attached the call is still audited and returns a safe fallback", async () => {
    const audit: string[] = []
    const ctx = new Context()
    const handle = new ShellHandle((line) => audit.push(line))
    createShellCapabilities(ctx, handle)

    let pending: Promise<boolean> | undefined
    await ctx.plugin(function lonelyPlugin(inner: Context) {
      pending = inner.notify.send("a", "b")
    })

    expect(await pending).toBe(false)
    expect(audit.some((line) => line.includes("lonelyPlugin -> notify.send"))).toBe(true)
  })
})
