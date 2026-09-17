// Can a COMPILED host use bun:sqlite?
//
// This is the question #27 does not ask, and it decides whether the data engine
// can be a plain dependency or has to be shaped around the compile step.
//
// The distribution form is fixed: the host ships as `bun build --compile` output,
// plugins stay external. So a data layer that works under `bun run` but not under
// the compiled binary would be discovered at package time — the worst moment.
//
// Run: bun build --compile docs/probes/probe21.ts --outfile .temp/probe21 && .temp/probe21
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const results: Record<string, unknown> = {}

// 1. In-memory: does the module even resolve inside the bundle?
try {
  const db = new Database(":memory:")
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
  db.run("INSERT INTO t (v) VALUES (?)", ["hello"])
  results.inMemory = db.query("SELECT v FROM t").get()
  db.close()
} catch (error) {
  results.inMemory = `ERROR: ${(error as Error).message}`
}

// 2. On disk: the real case. A data engine writes files.
try {
  const dir = mkdtempSync(join(tmpdir(), "vrcxk-probe21-"))
  const file = join(dir, "data.db")
  const db = new Database(file, { create: true })
  db.run("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)")
  db.run("INSERT INTO kv VALUES (?, ?)", ["schema_version", "1"])
  db.close()

  // Reopen: persistence is the whole point.
  const again = new Database(file)
  results.onDisk = again.query("SELECT v FROM kv WHERE k = ?").get("schema_version")
  again.close()
} catch (error) {
  results.onDisk = `ERROR: ${(error as Error).message}`
}

// 3. WAL + transaction, because a data engine needs both and both touch side files.
try {
  const dir = mkdtempSync(join(tmpdir(), "vrcxk-probe21-wal-"))
  const db = new Database(join(dir, "wal.db"), { create: true })
  results.journalMode = db.query("PRAGMA journal_mode = WAL").get()
  db.transaction(() => {
    db.run("CREATE TABLE a (x INTEGER)")
    db.run("INSERT INTO a VALUES (1)")
  })()
  results.transactionalWrite = db.query("SELECT count(*) AS n FROM a").get()
  db.close()
} catch (error) {
  results.wal = `ERROR: ${(error as Error).message}`
}

// 4. Is the compiled binary self-identifying? (bun reports the embedded main.)
results.bunVersion = Bun.version
results.isCompiledExecutable = (Bun.main ?? "").endsWith(".exe") || !Bun.main?.endsWith(".ts")

console.log(JSON.stringify(results, null, 2))
