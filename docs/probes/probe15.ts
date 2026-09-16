// M2-5 decision evidence: monorepo support.
//
// A git repo may host MANY plugin packages in nested subfolders (packages/*).
// Three questions decide the whole scheme:
//
//   Q1. Can we ENUMERATE the packages in a monorepo without cloning it whole?
//   Q2. Can we read ONE manifest file deep inside it, cheaply?
//   Q3. Can we fetch just the subdirectory for a tag (not the whole repo)?
//
// Q3 matters most: a big monorepo at full depth is expensive, and we would pay
// it for ONE plugin.
//
// Uses a real monorepo: cordiverse/cordis (the upstream we already track) has
// nested packages under packages/.
//
// RUN: bun run docs/probes/probe15.ts

import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import git from "../../host/node_modules/isomorphic-git/index.js"
import http from "../../host/node_modules/isomorphic-git/http/node/index.js"

const REPO = "https://github.com/cordiverse/cordis"
const REF = "main"

const out: Record<string, unknown> = {}

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

const fs = await import("node:fs")
let workdir: string | undefined

try {
  workdir = mkdtempSync(join(tmpdir(), "vrcxk-mono-"))

  // ── Q1/Q2: a blobless, depth-1 fetch gives us the commit + tree WITHOUT
  // downloading every file's content. Then we can list paths and read ONE blob
  // on demand (the fetch of that blob happens lazily).
  const started = Date.now()
  await git.clone({
    fs,
    http,
    dir: workdir,
    url: REPO,
    ref: REF,
    singleBranch: true,
    depth: 1,
    noCheckout: true,
    onAuth: () => ({}),
  })
  out.cloneMs = Date.now() - started

  // Q1: enumerate — the tree is present even though workdir is empty.
  // After a `noCheckout` clone there is no worktree, so `ref: "HEAD"` resolves
  // fine (see .__ig_diag) but `listFiles` must be given a REF, not an oid —
  // `listFiles({ oid })` silently returns [] instead of erroring.
  const resolved = await git.resolveRef({ fs, dir: workdir, ref: "HEAD" })
  const all = await git.listFiles({ fs, dir: workdir, ref: "HEAD" })
  out.resolvedHead = resolved
  out.totalFiles = all.length
  const topDirs = [...new Set(all.map((p) => p.split("/")[0]))].sort()
  out.topLevel = topDirs

  const pkgDirs = [
    ...new Set(
      all
        .filter((p) => p.startsWith("packages/"))
        .map((p) => p.split("/").slice(0, 2).join("/")),
    ),
  ].sort()
  out.packageDirs = pkgDirs
  out.packageCount = pkgDirs.length

  // Q2: read ONE manifest deep in the tree, without checking the repo out.
  let manifestRead: Record<string, unknown> = {}
  const target = pkgDirs.find((d) => all.includes(`${d}/package.json`))
  if (target) {
    const blob = await git.readBlob({ fs, dir: workdir, oid: resolved, filepath: `${target}/package.json` })
    const parsed = JSON.parse(decode(blob.blob)) as { name?: string; version?: string }
    manifestRead = { path: `${target}/package.json`, name: parsed.name, version: parsed.version, ok: true }
  } else {
    manifestRead = { ok: false, reason: "no package.json found under packages/" }
  }
  out.singleManifestRead = manifestRead

  // Q3: can we materialize ONLY a subdirectory onto disk? `checkout` accepts an
  // explicit filepath list, so we never need the whole repo on disk.
  let subdirCheckout: Record<string, unknown> = {}
  if (target) {
    const want = all.filter((p) => p.startsWith(`${target}/`))
    const t2 = Date.now()
    await git.checkout({
      fs,
      dir: workdir,
      ref: resolved,
      filepaths: want,
      noUpdateHead: true,
      force: true,
    })
    const onDisk: string[] = []
    const walk = (rel: string) => {
      for (const e of readdirSync(join(workdir!, rel), { withFileTypes: true })) {
        const p = `${rel}/${e.name}`
        if (e.isDirectory()) walk(p)
        else onDisk.push(p)
      }
    }
    walk(target)
    subdirCheckout = {
      requested: want.length,
      materialized: onDisk.length,
      checkoutMs: Date.now() - t2,
      sample: onDisk.slice(0, 5),
      wholeRepoFiles: all.length,
      ok: onDisk.length > 0 && onDisk.length < all.length,
    }
  } else {
    subdirCheckout = { ok: false }
  }
  out.subdirCheckout = subdirCheckout

  out.ok = true
} catch (e) {
  out.ok = false
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
} finally {
  if (workdir) rmSync(workdir, { recursive: true, force: true })
}

console.log(JSON.stringify(out, null, 2))
if (out.ok !== true) process.exitCode = 1
