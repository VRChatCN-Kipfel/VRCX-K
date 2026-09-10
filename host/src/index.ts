import "./log"
import { fileURLToPath, pathToFileURL } from "node:url"
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
import { attachDevWatch, DevWatch, type DevWatchEvent } from "./dev-watch"
import { declaresHeartbeat, FIBER_ACTIVE, FIBER_FAILED } from "./fiber"
import { TrayService } from "./tray"
import { ShortcutService } from "./shortcut"

export { HOST_RESTART_EXIT as EXIT_RESTART } from "./api"

/** How long to wait for the include tree (and its plugin entries) to settle. */
const INCLUDE_SETTLE_TIMEOUT_MS = 15_000

// The fiber-state numbers and the heartbeat-declaration check live in
// `fiber.ts` so they can be unit-tested without booting a host (this module has
// top-level side effects).

type FiberLike = { uid?: number | null; state?: number; await?(): Promise<unknown> }

function fiberOf(entry: Entry): FiberLike | undefined {
  return (entry.fiber as FiberLike | null | undefined) ?? undefined
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error === undefined) return "unknown error"
  return String(error)
}

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

/**
 * Validate the `VRCXK_DEV_WATCH_MAP` shape: a JSON object mapping entryId to an
 * array of path strings. A non-array value used to reach `entryRoots` and blow
 * up with an opaque TypeError; fail with a message that names the source.
 */
export function assertDevMap(value: unknown, source: string): Record<string, string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source}: expected a JSON object mapping entryId -> string[]`)
  }
  for (const [entryId, roots] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) {
      throw new Error(`${source}: entry "${entryId}" must map to an array of path strings`)
    }
  }
  return value as Record<string, string[]>
}

async function readDevMap(): Promise<Record<string, string[]> | undefined> {
  const raw = process.env.VRCXK_DEV_WATCH_MAP
  if (!raw) return undefined
  try {
    return assertDevMap(JSON.parse(raw), "VRCXK_DEV_WATCH_MAP")
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    // Not inline JSON — treat as a path to a JSON file (env var first, file
    // path fallback relative to cwd).
    try {
      return assertDevMap(JSON.parse(await readFile(raw, "utf8")), raw)
    } catch (inner) {
      throw new Error(`VRCXK_DEV_WATCH_MAP file "${raw}" is not a valid dev map: ${describeError(inner)}`, {
        cause: inner,
      })
    }
  }
}


/**
 * Wait for the include tree to settle, failing FAST on a broken include:
 *
 *   - the include entry's own fiber (missing/unreadable cordis.yml, import
 *     error) rejects with the original cause immediately — this used to spin
 *     the whole 15s settle timeout, which made a wrong-cwd startup look like a
 *     hang and broke the ws-heartbeat test's 5s budget;
 *   - a failed plugin entry inside the tree fails fast with its cause;
 *   - the healthy-but-not-yet-active case keeps a bounded settle wait, after
 *     which readiness is asserted (≥1 ACTIVE entry, plus the heartbeat service
 *     declared by cordis.yml) — the assertion the pre-#11 host had.
 */
async function waitForIncludeReady(ctx: Context, includeEntry: Entry): Promise<void> {
  const ownFiber = fiberOf(includeEntry)
  if (ownFiber?.await) {
    try {
      await ownFiber.await()
    } catch (cause) {
      throw new Error(`include plugin failed to assemble: ${describeError(cause)}`, { cause })
    }
  }

  const deadline = Date.now() + INCLUDE_SETTLE_TIMEOUT_MS
  let activeEntries = 0
  for (;;) {
    activeEntries = 0
    const subtree = includeEntry.subtree
    if (subtree) {
      for (const entry of subtree.entries()) {
        const fiber = fiberOf(entry)
        if (!fiber) continue
        if (fiber.state === FIBER_FAILED) {
          let cause: unknown
          try {
            await fiber.await?.()
          } catch (error) {
            cause = error
          }
          throw new Error(`${entry.id} plugin failed to assemble: ${describeError(cause)}`, { cause })
        }
        if (fiber.state === FIBER_ACTIVE) activeEntries += 1
      }
    }
    const heartbeatReady = !declaresHeartbeat(includeEntry) || ctx.get("heartbeat") != null
    if (activeEntries > 0 && heartbeatReady) return
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (activeEntries === 0) {
    throw new Error("include tree did not become ready in time (no active plugin entry)")
  }
  throw new Error("heartbeat plugin failed to assemble")
}

async function bootstrap() {
  log("starting Cordis...")
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(process.cwd()).href + "/"

  // Provide the shutdown signal service so plugins can participate in
  // graceful shutdown cooperatively via ctx.signal (see signal.ts).
  ctx.provide("signal", new ShutdownSignal())
  void ctx.signal // type guard — provided above

  // Tray service (issue: host → shell tray ingress). Always present so plugins
  // can inject `ctx.tray`; it reports "no shell" until the shell bridge
  // attaches, and resyncs whatever was requested in the meantime.
  const tray = new TrayService({ log: (line) => log(line) })
  ctx.provide("tray", tray)
  // Stop publishing and drop action handlers on shutdown (no async work).
  ctx.effect(() => () => tray.close())

  // Global shortcut service (issue #6 callback): the shell owns OS
  // registration, this owns which chord runs which handler. Always present so
  // plugins can inject `ctx.shortcut`; with no shell it reports `no-shell`.
  const shortcuts = new ShortcutService({ log: (line) => log(line) })
  ctx.provide("shortcut", shortcuts)
  ctx.effect(() => () => shortcuts.close())

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
  await waitForIncludeReady(ctx, includeEntry)

  // ── Dev watcher (issue #11) — strictly opt-in ──────────────────────────
  let devWatch: DevWatch | undefined
  let pushDevWatch: ((event: DevWatchPush) => void) | undefined
  if (process.env.VRCXK_DEV_WATCH === "1") {
    const include = includeEntry.subtree as unknown as InstanceType<typeof Include>
    if (!include) throw new Error("include subtree unavailable for dev watch")
    const devMap = await readDevMap()
    // fileURLToPath, NOT URL.pathname: `.pathname` yields "/E:/.../cordis.yml"
    // on Windows, which canonicalPath() turns into "E:\E:\..." so the config
    // hot-refresh never matched and chokidar watched a nonexistent directory.
    const configFile = fileURLToPath(new URL("./cordis.yml", ctx.baseUrl))
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
        } else if (event.type === "started") {
          // Emitted once chokidar finished its initial scan (tests and humans
          // both need to know the watcher is live).
          log(`dev watch watching: ${event.roots.join(", ")}`)
        } else if (event.type === "config-refreshed") {
          log(`dev config refreshed: ${event.entries.join(", ")}`)
        } else if (event.type === "config-error" || event.type === "watcher-error") {
          // These used to be relayed to the shell only, so a dev session with
          // no shell attached never saw why the watcher was unhappy.
          log(`dev ${event.type}: ${String(event.error)}`)
        }
        // Cross-process relay (host → shell → face) when a shell is attached.
        pushDevWatch?.(toDevWatchPush(event))
      },
      onRestartRequired: makeRestartRequester(ctx, { shellAttached }),
    })
    await devWatch.start()
    log(`dev watch enabled (map: ${Object.keys(devMap ?? {}).length} explicit entries)`)
    // Close the watcher as part of root cleanup. `attachDevWatch` returns
    // close()'s promise from the disposer (gracefulStop awaits it) and gates
    // routing on ctx.signal.stopping.
    attachDevWatch(ctx, devWatch)
  }

  const ready = await listenHostWs(ctx)
  log(`ready ${JSON.stringify({ ...ready, version: HOST_VERSION })}`)

  if (process.env.VRCXK_SHELL === "1") {
    const shell = connectShellStdio(ctx)
    await shell.ready(ready)
    // Tray ingress: push snapshots to the shell and fan shell `tray.action`
    // notifications back out to host/plugin handlers. Only wired when a shell
    // is attached — without VRCXK_SHELL the service stays in "no shell" mode.
    tray.attachShell((snapshot) => shell.tray.setSnapshot(snapshot))
    const offTrayAction = shell.tray.onAction((action) => tray.dispatchAction(action))
    ctx.effect(() => () => {
      offTrayAction()
    })
    // Shortcut callback (issue #6): the shell reports presses of the chords it
    // registered; the service routes them to the bound handler.
    shortcuts.attachShell(shell.shortcut)
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
