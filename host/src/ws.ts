import { randomBytes } from "node:crypto"
import type { AddressInfo } from "node:net"
import { expose } from "kkrpc"
import { webSocketTransport } from "kkrpc/ws"
import { WebSocketServer } from "ws"
import type { Context } from "cordis"
import { hostWsAPI, HOST_VERSION } from "./api"
import { HOST_READY_SCHEMA_VERSION, type HostReady } from "./contracts/hostReady"
import { collectHostEnvironment } from "./host-environment"

/**
 * The handshake the host sends to the shell (see
 * `contracts/host-ready/v1/host-ready.schema.json`). `hostVersion` is carried on
 * the wire, not only in the log line, because the shell supervises the host but
 * has no other way to learn which build it is supervising — `getVersion()` needs
 * the ws connection, which the face opens later.
 */
export type HostWsReady = HostReady

export async function listenHostWs(ctx: Context): Promise<HostWsReady> {
  const token = randomBytes(32).toString("hex")
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve())
    wss.once("error", reject)
  })

  const address = wss.address()
  if (!address || typeof address === "string") {
    wss.close()
    throw new Error("host ws failed to bind 127.0.0.1:0")
  }
  const { port } = address as AddressInfo

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.searchParams.get("token") !== token) {
      socket.close(1008, "invalid token")
      return
    }
    const controller = expose(hostWsAPI, webSocketTransport(socket))
    socket.once("close", () => controller.dispose())
  })

  ctx.effect(() => () => {
    wss.close()
  })

  return {
    schemaVersion: HOST_READY_SCHEMA_VERSION,
    port,
    token,
    hostVersion: HOST_VERSION,
    // The environment is read once, here, because `ready` is sent once per
    // process — see the schema's STALENESS note for why only slow-moving facts
    // belong in it.
    ...collectHostEnvironment(),
  }
}
