// Does a plugin module loaded THROUGH a junction (or symlink) report a URL that
// points at the junction, or does it canonicalise to the real path?
//
// This decides whether a "stable entry pointer" layout (e.g. `base/current` →
// `base/<version>`) is viable: this repo already carries TWO mechanisms for
// realpath/lexical key-space divergence (host/src/watch-path.ts,
// host/src/dev-reload.ts), and a pointer in the middle of a plugin path would
// reintroduce exactly that class of bug.
//
// Self-contained: creates its own fixture and junction, then removes both — a
// probe that needs manual setup is not a reproducible probe.
//
// Windows-only for the junction half (mklink /J, which — verified — does NOT
// require administrator rights). Other platforms would use a symlink; the
// fixture creation here is Windows-specific by construction.

import { readFileSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const out: Record<string, unknown> = {}

function err(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

const root = fileURLToPath(new URL("./junction-test/", import.meta.url))
const v1 = `${root}v1`
const link = `${root}current`

await rm(root, { recursive: true, force: true })
await mkdir(v1, { recursive: true })
await writeFile(
  `${v1}/probe-mod.ts`,
  "export const seen = import.meta.url\nexport const seenFilePath = new URL(import.meta.url).pathname\n",
  "utf8",
)

// mklink /J creates a directory junction: the closest Windows analogue of a
// symlink that a non-elevated user can create.
const mk = spawnSync("cmd", ["/c", "mklink", "/J", link, v1], { encoding: "utf8" })
out.junctionCreated = mk.status === 0
out.junctionStdout = String(mk.stdout ?? "").trim()
out.junctionStderr = String(mk.stderr ?? "").trim()

if (!out.junctionCreated) {
  out.note = "junction creation failed; the remaining checks cannot run"
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

const viaLink = new URL("./junction-test/current/probe-mod.ts", import.meta.url)
out.requestedUrl = viaLink.href
out.requestedPath = fileURLToPath(viaLink)

try {
  const mod: any = await import(viaLink.href)
  out.importOk = true
  out.modSeenUrl = mod.seen
  out.urlIsThroughLink = String(mod.seen).includes("/current/")
  out.urlIsRealPath = String(mod.seen).includes("/v1/")
} catch (e) {
  out.importError = err(e)
}

try {
  out.readViaLinkBytes = readFileSync(fileURLToPath(viaLink), "utf8").length
} catch (e) {
  out.readViaLinkError = err(e)
}

try {
  out.realpathOfLink = realpathSync(fileURLToPath(viaLink))
} catch (e) {
  out.realpathError = err(e)
}

// Cleanup: remove the JUNCTION first. `rm -r` on a junction can recurse into
// the target, so use rmdir (which unlinks the junction itself) before deleting
// the real tree.
const un = spawnSync("cmd", ["/c", "rmdir", link], { encoding: "utf8" })
out.junctionRemoved = un.status === 0
await rm(root, { recursive: true, force: true })
out.fixtureRemoved = true

console.log(JSON.stringify(out, null, 2))
