import "./log"
import { pathToFileURL } from "node:url"
import { Context } from "cordis"
import Include from "@cordisjs/plugin-include"
import Loader from "@cordisjs/plugin-loader"
import { HOST_VERSION } from "./api"
import { log } from "./log"
import { connectShellStdio } from "./stdio"
import { listenHostWs } from "./ws"

export { HOST_RESTART_EXIT as EXIT_RESTART } from "./api"

async function bootstrap() {
  log("starting Cordis...")
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(process.cwd()).href + "/"

  await ctx.plugin(Loader)
  await ctx.plugin(Include, { path: "./cordis.yml", enableLogs: false })

  if (!ctx.get("heartbeat")) {
    throw new Error("heartbeat plugin failed to assemble")
  }

  const ready = await listenHostWs(ctx)
  log(`ready ${JSON.stringify({ ...ready, version: HOST_VERSION })}`)

  if (process.env.VRCXK_SHELL === "1") {
    const shell = connectShellStdio()
    await shell.ready(ready)
  }
}

let stopping = false

// SIGTERM is Unix-only; Windows graceful shutdown goes through stdio stop RPC.
process.on("SIGTERM", () => {
  if (stopping) return
  stopping = true
  log("SIGTERM — exiting 0")
  process.exit(0)
})

process.on("SIGINT", () => process.exit(0))

try {
  await bootstrap()
} catch (err) {
  console.error("[host] fatal bootstrap error", err)
  process.exit(1)
}

await new Promise(() => {})
