// 12-rpcchannel-repeat.ts — reproducibility for probe 11 with CORRECT env
// handling (probe 02-driver ignores MODE and iterates its own mode list, which
// produced a misleading reading in the previous attempt).
//
// Runs 11-production-rpcchannel.ts under MODE=production|official with clean
// and abrupt teardown, N times each, and prints one compact table.

import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { writeFileSync } from "node:fs"

const target = resolve(import.meta.dir, "11-production-rpcchannel.ts")
const outPath = process.argv[2]
const N = Number(process.env.N ?? 3)

function run(shape: string, abrupt: boolean): Promise<any> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [target], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MODE: shape },
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
    child.on("close", () => {
      const text = out.trim()
      let parsed: any
      const starts: number[] = []
      for (let i = 0; i < text.length; i++) if (text[i] === "{") starts.push(i)
      for (let i = starts.length - 1; i >= 0; i--) {
        try {
          parsed = JSON.parse(text.slice(starts[i]))
          break
        } catch {}
      }
      if (parsed === undefined) parsed = { parseError: true, raw: text.slice(-500), stderr: err.slice(-500) }
      done(parsed)
    })
  })
}

const results: any[] = []
for (const shape of ["production", "official"]) {
  for (const abrupt of [false, true]) {
    const runs: any[] = []
    for (let i = 0; i < N; i++) {
      const r = await run(shape, abrupt)
      runs.push({
        transportOnCloseFired: r.transportOnCloseFired,
        onDoneFired: r.onDoneFired,
        onCloseReason: r.onCloseReason,
        flowing: r.readableFlowingAtTeardown,
      })
    }
    results.push({
      scenario: `${shape}-${abrupt ? "abrupt" : "clean"}`,
      n: N,
      onCloseFiredCount: runs.filter((x) => x.transportOnCloseFired === true).length,
      onDoneFiredCount: runs.filter((x) => x.onDoneFired === true).length,
      onCloseReason: [...new Set(runs.map((x) => String(x.onCloseReason)))],
      flowingValues: [...new Set(runs.map((x) => String(x.flowing)))],
    })
  }
}

const payload = { probe: "12-rpcchannel-repeat", bun: Bun.version, n: N, results }
const text = JSON.stringify(payload, null, 2)
console.log(text)
if (outPath) writeFileSync(resolve(process.cwd(), outPath), text)
process.exit(0)
