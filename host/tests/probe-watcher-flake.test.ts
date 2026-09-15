// TEMPORARY PROBE — not a real test. Delete before merge.
//
// Settles WHY `HostWatcher > debounces changes and maps exact and root events`
// fails on macOS with "Expected length: 1 / Received length: 2" — it failed
// 2 of 3 macOS runs on the SAME commit 0f77be5d (jobs 103755484057 and
// 103756723637 failed; 104365863369 passed).
//
// Round 1 of this probe (commit c85a6334) did NOT reproduce it. On macOS it
// reported a healthy 12/12: writes 0-3ms apart, exactly one `change` from
// chokidar, arrival t+46..64ms, nothing dropped. That falsified both earlier
// hypotheses (H1 "writes >debounceMs apart", H2 "isInitialReplay over-filter")
// and, more importantly, revealed the probe was NOT equivalent to the real
// test: it replaced `waitFor(change)` — which returns the instant the first
// change lands — with a fixed 400ms settle. That changes the observation
// window for everything that arrives after the first routed change, which is
// exactly where the extra event must come from.
//
// This version is a line-for-line equivalent of the real test:
//
//     start() -> waitFor(started) -> write, write
//     -> waitFor(first change) -> sleep 100ms -> assert exactly 1
//
// and it asserts exactly what the real test asserts, so a failure here IS the
// CI failure. When it fails it dumps the full event timeline (every raw
// chokidar event with arrival time and mtime, plus the routed events) so the
// mechanism is captured in the same run instead of needing another round trip.
//
// It also runs the scenario ROUNDS times, because a single pass proves nothing
// about a defect that shows up 2 times in 3.

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { binding } from "../src/watch-path"
import { HostWatcher, type WatcherEvent } from "../src/watcher"

const DEBOUNCE_MS = 40
const ROUNDS = 40

type Timeline = {
  label: string
  atMs: number
}

type RoundResult = {
  round: number
  routedChanges: number
  routedPaths: string[]
  rawEvents: Timeline[]
  changeArrivals: number[]
  writeSpreadMs: number
  stepLog: string[]
  events: WatcherEvent[]
  failed: boolean
}

function waitFor<T>(items: T[], predicate: (item: T) => boolean, timeout = 3_000): Promise<T> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      const found = items.find(predicate)
      if (found) return resolve(found)
      if (Date.now() - started >= timeout) return reject(new Error("timed out waiting for watcher event"))
      setTimeout(poll, 10)
    }
    poll()
  })
}

function dumpRound(r: RoundResult) {
  console.log(`\n--- ROUND ${r.round} : ${r.failed ? "FAILED (reproduced)" : "passed"} ---`)
  console.log(`    routed changes   : ${r.routedChanges}  ${JSON.stringify(r.routedPaths.map((p) => p.split(/[\\/]/).pop()))}`)
  console.log(`    change arrivals  : ${r.changeArrivals.join(", ") || "(none)"} ms after `+"`started`")
  console.log(`    write mtime spread: ${r.writeSpreadMs}ms  (debounceMs=${DEBOUNCE_MS})`)
  console.log(`    raw chokidar     : ${r.rawEvents.map((e) => `${e.label}@+${e.atMs}ms`).join(", ") || "(none)"}`)
  console.log(`    steps            : ${r.stepLog.join(" -> ")}`)
  console.log(`    full event types : ${r.events.map((e) => e.type).join(" ")}`)
}

describe("PROBE: HostWatcher flake mechanism (real-test equivalent)", () => {
  test(`runs the CI scenario ${ROUNDS}x and dumps any reproduction`, async () => {
    const roots: string[] = []
    const results: RoundResult[] = []

    try {
      for (let round = 0; round < ROUNDS; round++) {
        const root = await mkdtemp(join(tmpdir(), "vrcxk-probe2-"))
        roots.push(root)
        const pluginRoot = join(root, "plugin")
        await mkdir(pluginRoot)
        const entry = join(pluginRoot, "index.ts")
        await writeFile(entry, "export default {}")

        const events: WatcherEvent[] = []
        const changes: string[] = []
        const rawEvents: Timeline[] = []
        const changeArrivals: number[] = []
        const stepLog: string[] = []
        let readyWall = 0
        let writeSpreadMs = -1

        const watcher = new HostWatcher({
          roots: [root],
          debounceMs: DEBOUNCE_MS,
          bindings: [binding("plugin", entry, [pluginRoot])],
          onEvent: (event: WatcherEvent) => {
            if (event.type === "started") readyWall = Date.now()
            if (event.type === "change" && readyWall) changeArrivals.push(Date.now() - readyWall)
            events.push(event)
          },
          onChange: (path) => changes.push(path),
        })

        // Line-for-line equivalent of the real test from here on.
        await watcher.start()
        stepLog.push("start()")
        await waitFor(events, (event) => event.type === "started")
        stepLog.push("started")

        // Tap chokidar AFTER start() so the underlying watcher exists.
        const fsWatcher = (watcher as unknown as {
          watcher?: { on(e: string, cb: (...a: unknown[]) => void): void }
        }).watcher
        if (fsWatcher) {
          for (const kind of ["change", "add", "unlink", "raw"]) {
            fsWatcher.on(kind, () => rawEvents.push({ label: kind, atMs: Date.now() - readyWall }))
          }
        }

        const mtimeBefore = statSync(entry).mtimeMs
        await writeFile(entry, "export default 1")
        await writeFile(entry, "export default 2")
        const mtimeAfter = statSync(entry).mtimeMs
        writeSpreadMs = Math.max(0, Math.round(mtimeAfter - mtimeBefore))
        stepLog.push("two writes")

        await waitFor(events, (event) => event.type === "change")
        stepLog.push("first change seen")
        await new Promise((resolve) => setTimeout(resolve, 100))
        stepLog.push("slept 100ms")

        const routedChanges = changes.length
        const failed = routedChanges !== 1
        if (failed) stepLog.push(`ASSERT FAILED (expected 1, got ${routedChanges})`)
        await watcher.close()

        const result: RoundResult = {
          round,
          routedChanges,
          routedPaths: changes,
          rawEvents,
          changeArrivals,
          writeSpreadMs,
          stepLog,
          events,
          failed,
        }
        results.push(result)
        if (failed) dumpRound(result)
      }

      const failures = results.filter((r) => r.failed)
      console.log("\n=========== PROBE v2 SUMMARY ===========")
      console.log(`platform      : ${process.platform} (${process.arch})`)
      console.log(`rounds        : ${results.length}`)
      console.log(`FAILURES      : ${failures.length}/${results.length}  (expected 0, CI shows ~2/3)`)
      console.log(`max write spread observed : ${Math.max(...results.map((r) => r.writeSpreadMs))}ms (debounceMs=${DEBOUNCE_MS})`)
      console.log(`max routed changes ever   : ${Math.max(...results.map((r) => r.routedChanges))}`)
      if (failures.length) {
        console.log("REPRODUCED - failing rounds above carry full timelines.")
      } else {
        console.log("NOT reproduced in this run. See note at top: single non-repro proves nothing.")
      }
      console.log("========================================\n")

      // The probe reports; the real test judges. Never fail the build here,
      // or a green probe would be indistinguishable from a broken one.
      expect(results.length).toBe(ROUNDS)
    } finally {
      await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
    }
  }, 180_000)
})
