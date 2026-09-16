// M2-5 / source-scheme decision evidence: can `isomorphic-git` replace BOTH
// `git ls-remote` (version discovery) and the host-specific raw-URL guessing?
//
// WHY THIS MATTERS
//   Every "fetch one manifest file" path we measured has a hole:
//     - `git archive --remote` : 422/404 on GitHub AND GitLab (upload-archive off)
//     - `git ls-remote`        : requires the USER to have git installed
//     - raw.githubusercontent  : GitHub-only; GitLab/Gitea use different paths
//     - jsDelivr               : GitHub-only, strips the `v` prefix
//     - Atom feeds             : available everywhere, but NO tag SHA and truncated
//   isomorphic-git (MIT, pure JS, 478 releases since 2017) could close all of
//   them at once — IF it runs under bun, and IF it survives `bun build --compile`.
//
// TWO PHASES (both required):
//   1. source runtime  — does it work under bun at all?
//   2. COMPILED exe    — M0 established that compile + dynamic behaviour is the
//                        real risk (bun#11732, virtual FS). A library that works
//                        in source can still fail inside `--compile`.
//
// RUN: bun run docs/probes/probe14.ts                 (phase 1 only)
//      bun run docs/probes/probe14.ts --compile       (phase 1 + 2)

import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import git from "../../host/node_modules/isomorphic-git/index.js"
import http from "../../host/node_modules/isomorphic-git/http/node/index.js"

const PROXY = process.env.VRCXK_PROBE_PROXY ?? "http://127.0.0.1:7890"

// Targets: GitHub (must work), GitLab (the cross-host claim), Codeberg (Gitea).
const TARGETS = [
  { label: "github", url: "https://github.com/folke/lazy.nvim", expect: "v9.9.0" },
  { label: "gitlab", url: "https://gitlab.com/gitlab-org/cli", expect: null },
  { label: "codeberg", url: "https://codeberg.org/forgejo/forgejo", expect: null },
]

const out: Record<string, unknown> = { phase: process.argv.includes("--compile") ? "compiled" : "source" }

async function main() {
  console.log(`[probe14] phase=${out.phase} proxy=${PROXY}`)
  const results: Record<string, unknown> = {}

  for (const t of TARGETS) {
    const row: Record<string, unknown> = {}
    const started = Date.now()
    try {
      // listServerRefs = the `git ls-remote` equivalent, over smart HTTP.
      //
      // protocolVersion: 1 is REQUIRED. The default (v2) makes GitLab answer
      // 422 on the `ls-refs` POST while GitHub accepts it — so the default
      // silently makes the cross-host claim false. v1 works on both, so pin it.
      const refs = await git.listServerRefs({
        http,
        url: t.url,
        prefix: "refs/tags/",
        protocolVersion: 1,
      })
      row.refCount = refs.length
      // isomorphic-git returns {ref, oid}; oid is the commit SHA — exactly the
      // thing Atom feeds could NOT give us.
      row.sample = refs.slice(-3).map((r: { ref: string; oid: string }) => `${r.ref}=${r.oid}`)
      row.hasCommitSha = refs.every((r: { oid?: string }) => typeof r.oid === "string" && /^[0-9a-f]{40}$/.test(r.oid))
      row.foundExpected = t.expect ? refs.some((r: { ref: string }) => r.ref.endsWith(t.expect)) : null
      row.ok = refs.length > 0
    } catch (e) {
      row.ok = false
      row.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
    row.elapsedMs = Date.now() - started
    results[t.label] = row
    console.log(`[probe14] ${t.label}: ${JSON.stringify(row)}`)
  }

  out.listServerRefs = results
  out.allOk = Object.values(results).every((r) => (r as { ok?: boolean }).ok === true)
  out.shaOnAllHosts = Object.values(results).every((r) => (r as { hasCommitSha?: boolean }).hasCommitSha === true)
}

// Phase 2: prove it also works from a COMPILED exe. A library that works in
// source can still fail inside `bun build --compile` (M0's bun#11732 finding),
// so this is the gate that matters for our "compiled host + external plugins"
// distribution form.
//
// The fixture must live somewhere that resolves the deps the SAME way host/
// does: `bun build` resolves bare specifiers from the entry's directory upward,
// and a `file://` specifier is rejected outright. So write the entry INTO host/
// (a temp file beside the real sources) and import by bare package name.
async function compileCheck(): Promise<{ dir: string; exe: string }> {
  const hostDir = new URL("../../host/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
  const dir = await mkdtemp(join(tmpdir(), "vrcxk-ig-probe-"))
  const exe = join(dir, process.platform === "win32" ? "ig-probe.exe" : "ig-probe")
  const entry = join(hostDir, `.__probe14_entry.ts`)
  const script = `import git from "isomorphic-git"
import http from "isomorphic-git/http/node"
const refs = await git.listServerRefs({ http, url: "https://github.com/folke/lazy.nvim", prefix: "refs/tags/", protocolVersion: 1 })
console.log(JSON.stringify({ ok: refs.length > 0, count: refs.length, sha: refs.at(-1)?.oid }))
`
  await writeFile(entry, script)
  const compile = Bun.spawnSync([process.execPath, "build", "--compile", entry, "--outfile", exe], {
    cwd: hostDir,
  })
  const compileErr = compile.stderr ? new TextDecoder().decode(compile.stderr) : ""
  await rm(entry, { force: true }).catch(() => {})

  const result: Record<string, unknown> = { exitCode: compile.exitCode, stderr: compileErr.slice(0, 800) }

  if (compile.exitCode === 0) {
    const run = Bun.spawnSync([exe], {
      env: { ...process.env, HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY },
    })
    const stdout = run.stdout ? new TextDecoder().decode(run.stdout).trim() : ""
    const stderr = run.stderr ? new TextDecoder().decode(run.stderr).trim() : ""
    result.run = { exitCode: run.exitCode, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 900) }
    try {
      result.parsed = JSON.parse(stdout.split("\n").at(-1) ?? "{}")
    } catch {
      result.parsed = null
    }
    console.log(`[probe14] compiled exit=${run.exitCode} stdout=${stdout.slice(0, 200)}`)
    if (stderr) console.log(`[probe14] compiled stderr: ${stderr.slice(0, 500)}`)
  } else {
    console.log(`[probe14] compile FAILED: ${compileErr.slice(0, 400)}`)
  }

  return { dir, exe, ...result } as { dir: string; exe: string }
}

let tmp: string | undefined
try {
  await main()

  if (process.argv.includes("--compile")) {
    const prep = (await compileCheck()) as unknown as Record<string, unknown>
    tmp = prep.dir as string
    out.compiled = prep
  }

  out.ok = true
} catch (e) {
  out.ok = false
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
} finally {
  if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
}

console.log("[probe14] RESULT " + JSON.stringify(out, null, 2))
if (out.ok !== true) process.exitCode = 1
