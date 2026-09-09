#!/usr/bin/env bun
/**
 * Build the Cordis host as a Tauri external binary ("sidecar").
 *
 * VRCX-K M1 (#7 Batch A): the packaged shell launches a compiled host binary
 * through Tauri's `bundle.externalBin`. Tauri requires the input file at
 * `src-tauri/binaries/host-<rust-target-triple>[.exe]` (logical name
 * `binaries/host`), so this script:
 *
 *   1. resolves the Rust target triple (explicit arg > Tauri env > rustc),
 *   2. maps it to the Bun `--target` (never hard-codes Windows x64),
 *   3. runs `bun build --compile` in `host/` into a temp file,
 *   4. atomically renames it to the canonical sidecar name.
 *
 * The output artifact is git-ignored (see .gitignore); the directory carries
 * a README explaining the naming rule.
 *
 * Usage:
 *   bun run scripts/build-host.ts                     # host triple
 *   bun run scripts/build-host.ts -- --target-triple aarch64-pc-windows-msvc
 *   bun run scripts/build-host.ts -- --out-dir <tmp>  # tests (temp output)
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

/** Rust target triple -> Bun compile target. Add rows as platforms are built. */
export const RUST_TO_BUN_TARGET: Record<string, string> = {
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
}

/** Canonical sidecar file name for a Rust target triple (Tauri input name). */
export function sidecarName(triple: string): string {
  const exe = triple.includes("windows") ? ".exe" : ""
  return `host-${triple}${exe}`
}

/** Map a Rust target triple to the Bun compile target, failing fast unknown. */
export function bunTargetForTriple(triple: string): string {
  const target = RUST_TO_BUN_TARGET[triple]
  if (!target) {
    throw new Error(
      `unsupported Rust target triple "${triple}" (known: ${Object.keys(RUST_TO_BUN_TARGET).join(", ")})`,
    )
  }
  return target
}

/** Resolve the Rust target triple: arg > Tauri env > `rustc --print host-tuple`. */
export function resolveTargetTriple(explicit?: string): string {
  if (explicit) return explicit
  const fromEnv = process.env.TAURI_ENV_TARGET_TRIPLE
  if (fromEnv) return fromEnv
  const probe = spawnSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" })
  if (probe.status !== 0 || !probe.stdout) {
    throw new Error(
      `cannot resolve target triple: pass --target-triple or ensure rustc is on PATH (${probe.stderr?.trim() ?? "unknown error"})`,
    )
  }
  return probe.stdout.trim()
}

/** Repo root (parent of the `scripts/` directory this file lives in). */
function repoRoot(): string {
  return join(import.meta.dir, "..")
}

/**
 * Compile the host into `outDir/host-<triple>[.exe]`. Returns the artifact
 * path. Throws on failure; never leaves a partial artifact under the final
 * name (temp file + rename).
 */
export function buildHostSidecar(opts: { targetTriple?: string; outDir?: string } = {}): string {
  const triple = resolveTargetTriple(opts.targetTriple)
  const bunTarget = bunTargetForTriple(triple)
  // Script lives at <repo>/scripts; the host sources live at <repo>/host.
  const hostDir = join(repoRoot(), "host")
  const outDir = opts.outDir ?? join(repoRoot(), "src-tauri", "binaries")
  const entry = join(hostDir, "src", "index.ts")
  if (!existsSync(entry)) {
    throw new Error(`host entry missing at ${entry}`)
  }
  mkdirSync(outDir, { recursive: true })

  const outfile = join(outDir, sidecarName(triple))
  // Bun appends `.exe` on Windows when the outfile has no extension, so give
  // the temp file the final extension explicitly (canonical naming).
  const tmpExt = triple.includes("windows") ? ".exe" : ""
  const tmp = join(outDir, `.host-${triple}.tmp-${process.pid}${tmpExt}`)
  rmSync(tmp, { force: true })

  // `process.execPath` is the running bun binary (script executed via bun),
  // so we never depend on PATH shims.
  const compile = spawnSync(
    process.execPath,
    ["build", "--compile", "src/index.ts", "--target", bunTarget, "--outfile", tmp],
    { cwd: hostDir, encoding: "utf8" },
  )
  if (compile.status !== 0 || !existsSync(tmp)) {
    rmSync(tmp, { force: true })
    throw new Error(
      `bun build --compile failed (triple=${triple}, target=${bunTarget})\n${compile.stderr ?? ""}`,
    )
  }

  // Atomic-ish replace: remove a stale artifact, then rename the temp file.
  // (A true atomic swap would need platform rename-over semantics; a stale
  // sidecar from a failed build is worse than a tiny window without one.)
  rmSync(outfile, { force: true })
  renameSync(tmp, outfile)
  return outfile
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  let targetTriple: string | undefined
  let outDir: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--target-triple" || arg === "--triple") {
      targetTriple = args[++i]
    } else if (arg === "--out-dir") {
      outDir = args[++i]
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `usage: bun run scripts/build-host.ts [--target-triple <triple>] [--out-dir <dir>]\n` +
          `builds host/ into src-tauri/binaries/host-<triple>[.exe] (or <out-dir>)`,
      )
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  try {
    const artifact = buildHostSidecar({ targetTriple, outDir })
    console.log(`[build-host] ${artifact}`)
  } catch (error) {
    console.error(`[build-host] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
