// M2-5 decision evidence: should `source.url` be REQUIRED to end in `.git`?
//
// If every source URL ends in `.git`, then a source is unambiguously a git
// repository — which removes the need for a `source.type` discriminator
// entirely (the URL itself discriminates). That would be a real simplification,
// so it is worth testing rather than assuming.
//
// WHAT MUST HOLD for the rule to be safe:
//   Q1. `.git` must work on every host we care about (GitHub / GitLab / Gitea).
//   Q2. GitLab NESTED GROUPS must work with `.git` (gitlab.com/a/b/c).
//   Q3. We must know what BREAKS without `.git`, so the rule is a real
//       constraint rather than ceremony — and so we can write a good error.
//   Q4. codeload (plain-HTTP tarball, no git needed) — does it accept `.git`?
//       If it does not, requiring `.git` forces a strip step somewhere.
//
// RUN: bun run docs/probes/probe16.ts

import git from "../../host/node_modules/isomorphic-git/index.js"
import http from "../../host/node_modules/isomorphic-git/http/node/index.js"

const out: Record<string, unknown> = {}

type Case = { label: string; url: string }
const cases: Case[] = [
  // Q1 — plain hosts, both spellings
  { label: "gh:with-git", url: "https://github.com/folke/lazy.nvim.git" },
  { label: "gh:no-git", url: "https://github.com/folke/lazy.nvim" },
  { label: "gl:with-git", url: "https://gitlab.com/gitlab-org/cli.git" },
  { label: "gl:no-git", url: "https://gitlab.com/gitlab-org/cli" },
  { label: "cb:with-git", url: "https://codeberg.org/forgejo/forgejo.git" },
  { label: "cb:no-git", url: "https://codeberg.org/forgejo/forgejo" },
  // Q2 — GitLab nested group (a real monorepo-style layout)
  { label: "gl:nested+git", url: "https://gitlab.com/gitlab-org/security-products/analyzers/gemnasium.git" },
  { label: "gl:nested-no-git", url: "https://gitlab.com/gitlab-org/security-products/analyzers/gemnasium" },
]

for (const c of cases) {
  const row: Record<string, unknown> = {}
  const t = Date.now()
  try {
    const refs = await git.listServerRefs({
      http,
      url: c.url,
      prefix: "refs/tags/",
      protocolVersion: 1,
    })
    row.ok = refs.length > 0
    row.tags = refs.length
    row.sha = String(refs.at(-1)?.oid ?? "").slice(0, 12)
  } catch (e) {
    row.ok = false
    const msg = e instanceof Error ? e.message : String(e)
    // Keep the message short but diagnostic.
    row.error = msg.slice(0, 120)
  }
  row.ms = Date.now() - t
  out[c.label] = row
  console.log(`[probe16] ${c.label.padEnd(20)} ${JSON.stringify(row)}`)
}

// Q4 — codeload, the no-git-needed tarball path.
const codeload = async (label: string, url: string) => {
  const t = Date.now()
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" })
    out[label] = { status: res.status, ms: Date.now() - t, ct: res.headers.get("content-type") }
  } catch (e) {
    out[label] = { error: e instanceof Error ? e.message.slice(0, 120) : String(e) }
  }
  console.log(`[probe16] ${label.padEnd(20)} ${JSON.stringify(out[label])}`)
}

await codeload("codeload:no-git", "https://codeload.github.com/folke/lazy.nvim/tar.gz/refs/tags/v9.9.0")
await codeload("codeload:with-git", "https://codeload.github.com/folke/lazy.nvim.git/tar.gz/refs/tags/v9.9.0")

out.ok = true
console.log("[probe16] RESULT " + JSON.stringify(out, null, 2))
