// 13-final-matrix.ts — THE COMPLETE, SELF-CONTAINED FINAL MATRIX.
//
// One file, one driver, no env-override hazards (the 02-driver mode list bug
// that produced a contradictory reading is avoided by spawning with an
// explicit env and a per-cell assertion that the child honored MODE).
//
// Reports for EVERY case the six required observables:
//   fd0Kind, hasOnClose, onCloseFired, onCloseReason,
//   process.stdin.readableFlowing at teardown, timestamped event log.
//
// CASES (all with a real pipe on fd0; teardown at 900ms):
//   shape ∈ { production (host/src/stdio.ts:284-290 verbatim),
//             official-raw   (stdioPlatform with process.stdin both roles),
//             official-real  (the exported nodeStdioTransport()),
//             official-rpc   (nodeStdioTransport() inside a real RPCChannel),
//             production-rpc (production transport inside a real RPCChannel) }
//   teardown ∈ { clean (end), abrupt (destroy) }

import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

// Resolved HERE, in the parent, and injected into the `-e` child as absolute
// file: URLs. The child must NOT use bare "kkrpc" specifiers: `bun -e` resolves
// those against its CWD rather than against this file, so running this probe
// from any other directory made every child die on import. That failure was
// silent — a child that cannot import prints nothing, so the matrix reported ten
// rows of `undefined` and still exited 0, which reads as "measured, nothing
// fired" instead of "never ran". The guard at the bottom now turns that class of
// failure loud.
const KKRPC_MODULE = pathToFileURL(
  resolve(import.meta.dir, "../../../host/node_modules/kkrpc/dist/mod.js"),
).href
const KKRPC_STDIO = pathToFileURL(
  resolve(import.meta.dir, "../../../host/node_modules/kkrpc/dist/stdio.js"),
).href

const CHILD = `
import { RPCChannel } from ${JSON.stringify(KKRPC_MODULE)}
import { stdioJsonTransport, nodeStdioTransport } from ${JSON.stringify(KKRPC_STDIO)}
import { fstatSync } from "node:fs"

const shape = process.env.SHAPE
if (!shape) { console.log(JSON.stringify({ fatal: "SHAPE env missing" })); process.exit(3) }

const t0 = Date.now()
const events = []
const mark = (what) => events.push({ at: Date.now() - t0, what })

class ReadableStreamLike {
  listeners = new Set()
  pumpErr = null; doneCalled = false
  constructor(stream, onDone) { this.stream = stream; this.onDone = onDone; void this.pump(stream) }
  on(_e, l) { this.listeners.add(l); return this }
  off(_e, l) { this.listeners.delete(l); return this }
  async pump(stream) {
    const reader = stream.getReader()
    mark("legacy getReader() acquired")
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) { this.doneCalled = true; mark("legacy pump done:true"); this.onDone?.(); return }
        for (const l of this.listeners) l(r.value)
      }
    } catch (e) { this.pumpErr = String(e?.name) + ": " + String(e?.message); mark("pump THREW " + this.pumpErr) }
    finally { reader.releaseLock() }
  }
}
function bunWritable() {
  return { write(chunk, cb) { void Bun.write(Bun.stdout, chunk).then(() => cb?.(), (e) => cb?.(e instanceof Error ? e : new Error(String(e)))) } }
}

let onDoneFired = false
let legacy
const mkProductionTransport = () => {
  legacy = new ReadableStreamLike(Bun.stdin.stream(), () => { onDoneFired = true; mark("onDone fired") })
  return stdioJsonTransport({ readable: legacy, writable: bunWritable(), lifecycle: process.stdin })
}

let transport
if (shape === "production") transport = mkProductionTransport()
else if (shape === "official-raw") transport = stdioJsonTransport({ readable: process.stdin, writable: process.stdout, lifecycle: process.stdin })
else if (shape === "official-real") transport = nodeStdioTransport()
else if (shape === "official-rpc") transport = nodeStdioTransport()
else if (shape === "production-rpc") transport = mkProductionTransport()
else { console.log(JSON.stringify({ fatal: "unknown SHAPE " + shape })); process.exit(3) }

let onCloseFired = false, onCloseReason = null
const hasOnClose = typeof transport.onClose === "function"
if (hasOnClose) transport.onClose((r) => {
  if (onCloseFired) return
  onCloseFired = true
  onCloseReason = r === undefined ? "clean(undefined)" : String(r?.name) + ": " + String(r?.message)
  mark("platform.onClose FIRED")
})

let channel = null
if (shape.endsWith("-rpc")) {
  channel = new RPCChannel(transport, { expose: { ping: () => "pong" } })
  mark("RPCChannel constructed (subscribes internally)")
}

mark("ready")
setTimeout(() => {
  const s = (() => { try { const st = fstatSync(0); return "fifo=" + st.isFIFO() + " socket=" + st.isSocket() + " chr=" + st.isCharacterDevice() } catch (e) { return "stat-failed:" + String(e) } })()
  console.log(JSON.stringify({
    shape, fd0Kind: s, hasOnClose, onCloseFired, onCloseReason, onDoneFired,
    legacyPumpDone: legacy?.doneCalled ?? null, legacyPumpError: legacy?.pumpErr ?? null,
    hasRPCChannel: channel !== null,
    readableFlowingAtTeardown: process.stdin.readableFlowing ?? null,
    isPausedAtTeardown: typeof process.stdin.isPaused === "function" ? process.stdin.isPaused() : null,
    events,
  }, null, 2))
  process.exit(0)
}, 5000)
`

function run(shape: string, abrupt: boolean): Promise<any> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["-e", CHILD], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SHAPE: shape },
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (c) => (out += c.toString()))
    child.stderr.on("data", (c) => (err += c.toString()))
    setTimeout(() => {
      try {
        if (abrupt) (child.stdin as any).destroy()
        else child.stdin?.end()
      } catch {}
    }, 900)
    child.on("close", (code) => {
      const text = out.trim()
      let parsed: any
      const starts: number[] = []
      for (let i = 0; i < text.length; i++) if (text[i] === "{") starts.push(i)
      for (let i = starts.length - 1; i >= 0; i--) {
        try { parsed = JSON.parse(text.slice(starts[i])); break } catch {}
      }
      if (parsed === undefined) parsed = { parseError: true, raw: text.slice(-700), stderr: err.slice(-700) }
      if (err.trim()) parsed._stderr = err.trim().slice(-700)
      parsed._exitCode = code
      parsed._scenario = shape + "|" + (abrupt ? "abrupt" : "clean")
      // Assert the child honored SHAPE — guards against the env-override bug.
      parsed._shapeHonored = parsed.shape === shape
      done(parsed)
    })
  })
}

const SHAPES = ["production", "official-raw", "official-real", "production-rpc", "official-rpc"]
const results: any[] = []
for (const shape of SHAPES) {
  for (const abrupt of [false, true]) {
    results.push(await run(shape, abrupt))
  }
}

const payload = {
  probe: "13-final-matrix",
  bun: Bun.version,
  platform: process.platform,
  node: process.version,
  results,
}
const text = JSON.stringify(payload, null, 2)
console.log("===SUMMARY===")
for (const r of results) {
  console.log(
    [
      r._scenario.padEnd(24),
      "shapeHonored=" + r._shapeHonored,
      "fd0=" + (r.fd0Kind ?? "?"),
      "hasOnClose=" + r.hasOnClose,
      "onCloseFired=" + r.onCloseFired,
      "reason=" + r.onCloseReason,
      "onDoneFired=" + r.onDoneFired,
      "flowing=" + r.readableFlowingAtTeardown,
      "exit=" + r._exitCode,
    ].join(" | "),
  )
}
// Refuse to report a matrix that did not actually run. A child that fails to
// import (or to honor SHAPE) yields a row of `undefined`s, which is
// indistinguishable from "measured: nothing fired" unless it is treated as
// failure. This is the guard that makes the CWD bug above loud instead of silent.
const broken = results.filter((r) => !r._shapeHonored)
if (broken.length > 0) {
  console.error(
    `\n=== ${broken.length}/${results.length} rows did not honor SHAPE — the matrix is NOT valid ===\n` +
      broken
        .map((r) => `  ${r._scenario}: exit=${r._exitCode} raw=${JSON.stringify(r).slice(0, 200)}`)
        .join("\n") +
      "\n\nA row of undefined values means the child never imported (check the" +
      "\nkkrpc file: URLs above) — it does NOT mean onClose did not fire.\n",
  )
  process.exit(1)
}

// Optional dump path, matching 12-rpcchannel-repeat.ts: this probe is
// self-contained and must run on a clean clone, so nothing is written unless the
// caller asks (`bun run <this> out.json`). The path used to be hardcoded to the
// author's `.temp/recon-stdio/probes-h6/`, which does not exist in a fresh
// checkout — the table printed fine and then the process died with ENOENT.
const outPath = process.argv[2]
if (outPath) writeFileSync(resolve(process.cwd(), outPath), text)
process.exit(0)
