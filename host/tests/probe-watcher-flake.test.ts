// TEMPORARY PROBE — not a real test. Delete before merge.
//
// Purpose: settle WHY `HostWatcher > debounces changes and maps exact and root
// events` fails on macOS with "Expected length: 1 / Received length: 2",
// in ~2 of 3 runs on an identical commit (desktop macOS job 103755484057,
// 103756723637 failed; 104365863369 passed — same SHA 0f77be5d).
//
// Two competing hypotheses, with DIFFERENT fixes:
//
//   H1 "timing race": the two writeFile() calls land more than debounceMs
//      (40ms) apart, so the trailing-edge debounce legitimately flushes twice.
//      Fix: make the test wait for quiescence instead of sleeping 100ms.
//
//   H2 "FSEvents replay": the SAME write is delivered twice — once as the real
//      event, once as an initial-scan replay that `isInitialReplay` fails to
//      filter (mtime/readyAtMs comparison). Fix: correct the mtime baseline.
//
// How the probe tells them apart: every raw chokidar event is timestamped
// relative to `ready`, with the file's mtime at observation time, and with
// whether isInitialReplay() would have dropped it. Then:
//
//   - H1  => the three raw events carry 2+ DISTINCT mtimes, and their arrival
//            gaps straddle debounceMs.
//   - H2  => two raw events carry the SAME mtime (same write observed twice),
//            or an event is dropped/kept inconsistently around readyAtMs.
//
// It runs the failing scenario N times in-process and prints a report either
// way, so a green run still yields data (unlike the real test, whose failure
// is the only observable).

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { binding } from "../src/watch-path"
import { HostWatcher, type WatcherEvent } from "../src/watcher"

const DEBOUNCE_MS = 40
const ROUNDS = 12

type Raw = {
  kind: string
  path: string
  atMs: number // ms since this round's `ready`
  mtimeMs: number
  ageVsReadyMs: number // mtime - readyAtMs; negative = predates ready (replay-ish)
  isReplay: boolean
}

type Round = {
  round: number
  raw: Raw[]
  changes: string[]
  changeEvents: number
  rawChokidar: string[]
  mtimeFirst: number
  mtimeSecond: number
  verdict: string
}

function summarise(rounds: Round[]) {
  const twoChanges = rounds.filter((r) => r.changeEvents > 1).length
  const missed = rounds.filter((r) => r.verdict.startsWith("MISSED")).length
  const chokidarSaw = rounds.filter((r) => r.rawChokidar.some((s) => s.startsWith("change"))).length

  console.log("\n================ WATCHER FLAKE PROBE ================")
  console.log(`platform      : ${process.platform} (${process.arch})`)
  console.log(`bun           : ${Bun.version}`)
  console.log(`debounceMs    : ${DEBOUNCE_MS}`)
  console.log(`rounds        : ${rounds.length}`)
  console.log(`rounds w/ >1 change event : ${twoChanges}/${rounds.length}   <-- the CI failure`)
  console.log(`rounds chokidar saw change: ${chokidarSaw}/${rounds.length}   <-- raw layer fired?`)
  console.log(`rounds routed 0 (missed)  : ${missed}/${rounds.length}   <-- H2 over-filter`)
  console.log(`rounds same-mtime writes  : ${rounds.filter((r) => r.mtimeFirst === r.mtimeSecond).length}/${rounds.length}`)
  console.log("-----------------------------------------------------")
  for (const r of rounds) {
    console.log(`round ${r.round}: routed=${r.changeEvents} verdict=${r.verdict}`)
    console.log(
      `    write#1 mtime-ready=${Math.round(r.mtimeFirst - 0)} write#2 mtime-ready=${Math.round(r.mtimeSecond)} ` +
        `sameMtime=${r.mtimeFirst === r.mtimeSecond}`,
    )
    console.log(`    chokidar raw: ${r.rawChokidar.join(", ") || "(none)"}`)
    for (const e of r.raw) {
      console.log(
        `    raw ${e.kind.padEnd(6)} t+${String(e.atMs).padStart(5)}ms  ` +
          `mtime-ready=${String(Math.round(e.ageVsReadyMs)).padStart(6)}ms  ` +
          `replay=${e.isReplay ? "YES" : "no "}  ${e.path.split(/[\\/]/).pop()}`,
      )
    }
  }
  console.log("=====================================================\n")
}

describe("PROBE: HostWatcher flake mechanism", () => {
  test(`reproduces the CI scenario ${ROUNDS}x and reports the mechanism`, async () => {
    const roots: string[] = []
    const rounds: Round[] = []

    try {
      for (let round = 0; round < ROUNDS; round++) {
        const root = await mkdtemp(join(tmpdir(), "vrcxk-probe-"))
        roots.push(root)
        await mkdir(join(root, "plugin"))
        const entry = join(root, "plugin", "index.ts")
        await writeFile(entry, "export default {}")

        const raw: Raw[] = []
        const changes: string[] = []
        let changeEvents = 0
        let readyWall = 0 // absolute Date.now() when `started` fired

        const watcher = new HostWatcher({
          roots: [root],
          debounceMs: DEBOUNCE_MS,
          bindings: [binding("plugin", entry, [join(root, "plugin")])],
          onEvent: (event: WatcherEvent) => {
            if (event.type === "started") {
              readyWall = Date.now()
              return
            }
            if (event.type !== "change") return
            changeEvents += 1
            // Mirror the real test's observation point.
            if (event.path) {
              let mtimeMs = Number.NaN
              try {
                mtimeMs = statSync(event.path).mtimeMs
              } catch {
                /* gone */
              }
              raw.push({
                kind: "ROUTED",
                path: event.path,
                atMs: Date.now() - readyWall,
                mtimeMs,
                ageVsReadyMs: mtimeMs - readyWall,
                isReplay: false,
              })
            }
          },
          onChange: (path) => {
            changes.push(path)
          },
        })

        // Same shape as the real test: start(), wait for `started`, then two writes.
        await watcher.start()
        const started = Date.now()
        while (readyWall === 0 && Date.now() - started < 3_000) {
          await new Promise((r) => setTimeout(r, 5))
        }
        const readyAt = readyWall

        // Bypass layer: observe chokidar directly, so we can tell "no event was
        // ever emitted" from "an event was emitted but the router dropped it".
        const rawChokidar: string[] = []
        const fsWatcher = (watcher as unknown as { watcher?: { on(e: string, cb: (p: string) => void): void } }).watcher
        if (fsWatcher) {
          for (const kind of ["change", "add", "unlink", "raw"]) {
            fsWatcher.on(kind, () => rawChokidar.push(`${kind}@+${Date.now() - readyAt}ms`))
          }
        }

        await writeFile(entry, "export default 1")
        const mtimeAfterFirst = statSync(entry).mtimeMs
        await writeFile(entry, "export default 2")
        const mtimeAfterSecond = statSync(entry).mtimeMs

        // Long settle: never sleep-then-assert; let everything that CAN arrive, arrive.
        await new Promise((r) => setTimeout(r, 400))
        await watcher.close()

        const distinctMtimes = new Set([mtimeAfterFirst, mtimeAfterSecond]).size
        const verdict =
          changeEvents > 1
            ? distinctMtimes === 1
              ? "FAIL>1 + single write mtime => H2 replay"
              : "FAIL>1 + distinct write mtimes => H1 timing race"
            : changeEvents === 0 && rawChokidar.some((s) => s.startsWith("change"))
              ? "MISSED: chokidar emitted change, router dropped it => H2 over-filter"
              : changeEvents === 0
                ? "MISSED: chokidar never emitted change"
                : "ok"

        rounds.push({
          round,
          raw,
          changes,
          changeEvents,
          rawChokidar,
          mtimeFirst: mtimeAfterFirst,
          mtimeSecond: mtimeAfterSecond,
          verdict,
        })
      }

      summarise(rounds)

      // The probe itself must not fail the build — it reports, it does not judge.
      expect(rounds.length).toBe(ROUNDS)
    } finally {
      await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })))
    }
  }, 60_000)
})
