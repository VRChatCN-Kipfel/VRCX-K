import { afterEach, beforeAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { RPCChannel } from "kkrpc"
import { stdioJsonTransport } from "kkrpc/stdio"
import type { HostStdioAPI, ShellSysAPI } from "../src/stdio"
import type { HostWsReady } from "../src/ws"
import { killTree, resolveBun, warmBun } from "./helpers"

const hostDir = join(import.meta.dir, "..")
const bun = resolveBun()

beforeAll(async () => {
  await warmBun()
}, 60_000)

let child: ReturnType<typeof spawn> | undefined

/**
 * The pipe end of the spawned child, checked.
 *
 * `spawn` types these as optional (they depend on `stdio`), but this test always
 * passes `["pipe","pipe","pipe"]`. Throwing names a mis-spawned fixture instead
 * of crashing on `undefined` inside the transport.
 */
function pipe<T>(end: T | undefined | null, name: string): T {
  if (end === undefined || end === null) {
    throw new Error(`spawned host has no ${name} pipe (was it spawned with "pipe"?)`)
  }
  return end
}

afterEach(() => {
  if (child?.pid) killTree(child.pid)
  child = undefined
})

test("host stdio ready then ping and stop", async () => {
  child = spawn(bun, ["src/index.ts"], {
    cwd: hostDir,
    env: { ...process.env, VRCXK_SHELL: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })

  let resolveReady: (info: HostWsReady) => void
  const ready = new Promise<HostWsReady>((resolve, reject) => {
    resolveReady = resolve
    setTimeout(() => reject(new Error("shell ready was not called")), 10_000)
  })

  const transport = stdioJsonTransport({
    readable: pipe(child.stdout, "stdout"),
    writable: pipe(child.stdin, "stdin"),
    lifecycle: pipe(child.stdout, "stdout"),
  })
  const channel = new RPCChannel<ShellSysAPI, HostStdioAPI>(transport, {
    expose: {
      async ready(info) {
        resolveReady(info)
      },
    },
  })
  const host = channel.getAPI()

  const info = await ready
  expect(info.port).toBeGreaterThan(0)
  expect(info.token).toMatch(/^[0-9a-f]{64}$/)
  expect(await host.ping()).toBe("pong")
  expect(await host.stop()).toBe(true)

  const code = await new Promise<number | null>((resolve) => {
    if (!child) throw new Error("test did not spawn a host")
    child.once("exit", (exitCode) => resolve(exitCode))
  })
  expect(code).toBe(0)
  channel.destroy()
})
