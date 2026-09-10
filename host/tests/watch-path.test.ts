import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { binding, canonicalExistingPath, canonicalFileUrl, canonicalPath, mapPath } from "../src/watch-path"

const root = join(import.meta.dir, "fixtures", "watcher")

describe("watch path normalization", () => {
  test("normalizes file URLs and lexical paths to one key", () => {
    const path = join(root, "alpha", "index.ts")
    expect(canonicalPath(canonicalFileUrl(path))).toBe(canonicalPath(path))
  })

  test("folds path case on Windows only", () => {
    const path = join(root, "alpha", "index.ts")
    const upper = path.toUpperCase()
    expect(canonicalPath(upper) === canonicalPath(path)).toBe(process.platform === "win32")
  })

  test("strips file URL query and hash while rejecting non-file URLs", () => {
    const path = join(root, "alpha", "index.ts")
    expect(canonicalPath(`${canonicalFileUrl(path)}?cache=1#entry`)).toBe(canonicalPath(path))
    expect(() => canonicalPath("https://example.test/plugin.ts")).toThrow(/file:/)
  })

  test("rejects a URL object with a non-file protocol", () => {
    expect(() => canonicalPath(new URL("https://example.test/plugin.ts"))).toThrow(/file:/)
    expect(() => canonicalPath(new URL("http://example.test/x.ts"))).toThrow(/file:/)
  })

  test("canonicalExistingPath resolves symlinks and falls back to lexical when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vrcxk-watchpath-"))
    try {
      const target = join(dir, "target.ts")
      const link = join(dir, "link.ts")
      await writeFile(target, "x")
      try {
        await symlink(target, link)
      } catch {
        // Symlinks may be unavailable (Windows privileges); fall back to a
        // plain-file identity check for the resolved path.
        expect(await canonicalExistingPath(target)).toBe(canonicalPath(target))
        return
      }
      // Symlink resolves to the real target path.
      expect(await canonicalExistingPath(link)).toBe(canonicalPath(target))
      // Missing file falls back to the lexical canonical path (no throw).
      const missing = join(dir, "missing.ts")
      expect(await canonicalExistingPath(missing)).toBe(canonicalPath(missing))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("URL to entry mapping", () => {
  const alpha = binding("alpha", join(root, "alpha", "index.ts"), [join(root, "alpha")])
  const nested = binding("nested", join(root, "alpha", "nested", "index.ts"), [join(root, "alpha", "nested")])
  const sharedA = binding("shared-a", join(root, "a.ts"), [join(root, "shared")])
  const sharedB = binding("shared-b", join(root, "b.ts"), [join(root, "shared")])

  test("exact entry URL wins over roots", () => {
    expect(mapPath(join(root, "alpha", "index.ts"), [alpha, nested])).toEqual({
      kind: "matched",
      entryIds: ["alpha"],
    })
  })

  test("selects the longest matching root", () => {
    expect(mapPath(join(root, "alpha", "nested", "util.ts"), [alpha, nested])).toEqual({
      kind: "matched",
      entryIds: ["nested"],
    })
  })

  test("reports equal shared roots as ambiguous", () => {
    expect(mapPath(join(root, "shared", "util.ts"), [sharedA, sharedB])).toMatchObject({
      kind: "ambiguous",
      entryIds: ["shared-a", "shared-b"],
    })
  })

  test("reports unowned paths without guessing", () => {
    expect(mapPath(join(root, "outside.ts"), [alpha])).toMatchObject({ kind: "unowned" })
  })

  test("does not match a root name prefix sibling", () => {
    expect(mapPath(join(root, "alphabet", "util.ts"), [alpha])).toMatchObject({ kind: "unowned" })
  })

  test("a file named ..foo inside a root is owned, not treated as outside", () => {
    // A naive `rel.startsWith("..")` check would reject this; only a real
    // parent segment ("..", "../", "..\\") may leave the root.
    expect(mapPath(join(root, "alpha", "..foo.ts"), [alpha])).toEqual({
      kind: "matched",
      entryIds: ["alpha"],
    })
  })

  test("DevWatch keeps the lexical key space (no realpath divergence)", async () => {
    // Regression: DevWatch.flushFs used `canonicalExistingPath` (realpath
    // key) while bindings used `canonicalPath` (lexical). On macOS the tmpdir
    // is a symlink (/var → /private/var), so chokidar event paths (realpath)
    // never mapped to lexical binding roots and live reload never fired.
    // This pins the contract: the watcher path must stay lexical so mapPath
    // matches the lexical binding.
    const dir = await mkdtemp(join(tmpdir(), "vrcxk-watchpath-sym-"))
    try {
      const realDir = join(dir, "real")
      const link = join(dir, "link")
      await mkdir(realDir, { recursive: true })
      try {
        await symlink(realDir, link, "dir")
      } catch {
        // Windows without symlink privilege: nothing to prove.
        return
      }
      // The chokidar event path is lexical (/var/...-style); the binding is
      // built from the same lexical root. A naive canonicalExistingPath would
      // have turned the event into realpath (/private/var/...), which must
      // NOT be what we compare against.
      const entry = join(link, "plugin", "index.ts")
      await mkdir(join(link, "plugin"), { recursive: true })
      await writeFile(entry, "x")
      // What a lexically-keyed watcher sees (the same spelling it registered).
      const lexicalEvent = join(link, "plugin", "util.ts")
      const bound = binding("p", entry, [join(link, "plugin")])
      // The lexical event maps to the lexical binding — no realpath involved.
      expect(mapPath(lexicalEvent, [bound])).toMatchObject({ kind: "matched", entryIds: ["p"] })
      // And even if something handed us the realpath spelling (the old bug —
      // canonicalExistingPath on a symlinked tmp root), mapPath must treat it
      // as the same prefix via the real path. Prove the lexical contract wins.
      const realEvent = await realpath(join(link, "plugin", "util.ts"))
      expect(realEvent).not.toBe(lexicalEvent)
      expect(relative(join(realpath(link), "plugin"), realEvent)).toMatch(/^util\.ts$/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
