import "./log"
import { pathToFileURL } from "node:url"
import { readFile } from "node:fs/promises"
import { Context } from "cordis"
import type { Entry } from "@cordisjs/plugin-loader"
import Include from "@cordisjs/plugin-include"
import Loader from "@cordisjs/plugin-loader"
import { HOST_VERSION } from "./api"
import { log } from "./log"
import { ShutdownSignal } from "./signal"
import { makeRestartRequester } from "./restart"
import { connectShellStdio, type DevWatchPush } from "./stdio"
import { listenHostWs } from "./ws"
import { DevWatch, type DevWatchEvent } from "./dev-watch"

export { HOST_RESTART_EXIT as EXIT_RESTART } from "./api"

/** How long to wait for the include tree (and its plugin entries) to settle. */
const INCLUDE_SETTLE_TIMEOUT_MS = 15_000

/** Normalize a DevWatchEvent into the JSON-safe wire shape for the shell. */
function toDevWatchPush(event: DevWatchEvent): DevWatchPush {
  const base: DevWatchPush = { type: event.type }
  if (event.type === "reload") {
    base.entryId = event.entryId
    base.status = event.result.status
    if (event.result.error !== undefined) {
      base.error = event.result.error instanceof Error ? event.result.error.message : String(event.result.error)
    }
  } else if (event.type === "change" || event.type === "unowned" || event.type === "ambiguous") {
    base.path = event.path
    if ("entryIds" in event && event.entryIds) base.entries = event.entryIds
  } else if (event.type === "config-refreshed") {
    base.entries = event.entries
  } else if (event.type === "config-error" || event.type === "watcher-error") {
    base.error = event.error instanceof Error ? event.error.message : String(event.error)
  }
  return base
}

async function readDevMap(): Promise<Record<string, string[]> | undefined> {
  const raw = process.env.VRCXK_DEV_WATCH_MAP
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, string[]>
  } catch {
    // Not inline JSON — treat as a path to a JSON file (env var first, file
    // path fallback relative to cwd).
    const content = await readFile(raw, "utf8")
    return JSON.parse(content) as Record<string, string[]>
  }
}

async function waitForIncludeReady(includeEntry: Entry): Promise<void> {
  const deadline = Date.now() + INCLUDE_SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const subtree = includeEntry.subtree
    if (subtree) {
      // At least one plugin entry inside the include tree must be ACTIVE.
      for (const entry of subtree.entries()) {
        const fiber = entry.fiber as unknown as { uid?: number | null } | undefined
        if (fiber && fiber.uid !== null && fiber.uid !== undefined) return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("include tree did not become ready in time")
}

async function bootstrap() {
  log("starting Cordis...")
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(process.cwd()).href + "/"

  // Provide the shutdown signal service so plugins can participate in
  // graceful shutdown cooperatively via ctx.signal (see signal.ts).
  ctx.provide("signal", new ShutdownSignal())
  void ctx.signal // type guard — provided above

  await ctx.plugin(Loader)

  // Mount Include as a loader-tree builtin entry. This is the Cordis-standard
  // shape: the Include EntryTree is reachable via the loader Entry's
  // `.subtree`, which the dev watcher needs to map file events to plugin
  // Entries and to refresh config. `Include` stays a static import so
  // `bun build --compile` keeps it in the bundle (see M0 findings).
  ctx.loader.builtins.include = Include
  const includeId = await ctx.loader.create({
    name: "cordis:include",
    config: { path: "./cordis.yml", enableLogs: false },
  })
  const includeEntry = ctx.loader.resolve(includeId)

  // Wait for the include subtree + its plugin entries to settle.
  await waitForIncludeReady(includeEntry)

  // ── Dev watcher (issue #11) — strictly opt-in ──────────────────────────
  let devWatch: DevWatch | undefined
  let pushDevWatch: ((event: DevWatchPush) => void) | undefined
  if (process.env.VRCXK_DEV_WATCH === "1") {
    const include = includeEntry.subtree as unknown as InstanceType<typeof Include>
    if (!include) throw new Error("include subtree unavailable for dev watch")
    const devMap = await readDevMap()
    const configFile = new URL("./cordis.yml", ctx.baseUrl).pathname
    const shellAttached = process.env.VRCXK_SHELL === "1"
    devWatch = new DevWatch({
      include,
      configFile,
      devMap,
      onState: (event) => {
        // Structured stderr log always.
        if (event.type === "reload") {
          const { entryId, result } = event
          log(`dev reload ${entryId}: ${result.status}${result.error ? ` (${String(result.error)})` : ""}`)
        } else if (event.type === "config-refreshed") {
          log(`dev config refreshed: ${event.entries.join(", ")}`)
        }
        // Cross-process relay (host → shell → face) when a shell is attached.
        pushDevWatch?.(toDevWatchPush(event))
      },
      onRestartRequired: makeRestartRequester(ctx, { shellAttached }),
    })
    await devWatch.start()
    log(`dev watch enabled (map: ${Object.keys(devMap ?? {}).length} explicit entries)`)
    // Close the watcher as part of root cleanup.
    ctx.effect(() => () => void devWatch?.close())
  }

  const ready = await listenHostWs(ctx)
  log(`ready ${JSON.stringify({ ...ready, version: HOST_VERSION })}`)

  if (process.env.VRCXK_SHELL === "1") {
    const shell = connectShellStdio(ctx)
    await shell.ready(ready)
    // Bind the dev-watch relay now that the shell API proxy exists. Events
    // emitted before this point were logged only; the relay is fire-and-forget
    // so a shell without the handler (or a dropped pipe) never breaks dev.
    if (devWatch) {
      pushDevWatch = (event) => {
        void shell.shell.devWatchEvent(event).catch((error: unknown) => {
          log(`dev watch push failed: ${String(error)}`)
        })
      }
    }
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
