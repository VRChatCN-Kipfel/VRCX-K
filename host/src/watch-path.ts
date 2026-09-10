import { realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export type EntryBinding = {
  entryId: string
  entryUrl: string
  roots: string[]
}

export type MappingResult =
  | { kind: "matched"; entryIds: string[] }
  | { kind: "unowned"; path: string }
  | { kind: "ambiguous"; path: string; entryIds: string[] }

function lexicalPath(input: string | URL): string {
  const raw = typeof input === "string" ? input : undefined
  const url = input instanceof URL
    ? input
    : /^file:/i.test(raw!)
      ? new URL(raw!)
      : undefined
  if (url && url.protocol !== "file:") {
    throw new TypeError(`watch paths must use the file: protocol, received ${url.protocol}`)
  }
  if (!url && raw !== undefined && /^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) {
    throw new TypeError(`watch paths must use the file: protocol, received ${raw}`)
  }
  const value = url ? fileURLToPath(url) : raw!
  return normalize(resolve(value))
}

/** Platform-neutral comparison key; Windows paths are case-insensitive. */
export function canonicalPath(input: string | URL): string {
  const path = lexicalPath(input)
  return process.platform === "win32" ? path.toLowerCase() : path
}

export function canonicalFileUrl(input: string | URL): string {
  const path = lexicalPath(input)
  return pathToFileURL(path).href
}

/**
 * Watch-space comparison key. Unlike `canonicalPath` (pure lexical), this
 * resolves symlinks in the existing path prefix via realpathSync so two
 * spellings of one directory — e.g. macOS `/var` and its realpath
 * `/private/var`, or `process.cwd()` reportings — collapse to one key.
 * Non-existent tails stay lexical; failures fall back to `canonicalPath`.
 *
 * Bindings AND watcher event paths should be normalized with this, so both
 * sides live in the same key space on every platform.
 */
export function watchKey(input: string | URL): string {
  const path = lexicalPath(input)
  const tail: string[] = []
  let cursor = path
  for (;;) {
    try {
      const real = realpathSync(cursor)
      return canonicalPath(tail.length ? join(real, ...tail.reverse()) : real)
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return canonicalPath(path)
      tail.push(basename(cursor))
      cursor = parent
    }
  }
}

export async function canonicalExistingPath(input: string | URL): Promise<string> {
  // Same "resolve symlinks in the existing prefix, fall back lexical" contract
  // as watchKey; kept async for callers that awaited the old fs-based one.
  return watchKey(input)
}

export function binding(
  entryId: string,
  entryUrl: string | URL,
  roots: Array<string | URL>,
  key: (input: string | URL) => string = canonicalPath,
): EntryBinding {
  const entryPath = key(entryUrl)
  return {
    entryId,
    entryUrl: pathToFileURL(entryPath).href,
    roots: roots.map((root) => key(root)),
  }
}

/** Resolve a changed path by exact entry URL, then longest explicit root. */
export function mapPath(input: string | URL, bindings: Iterable<EntryBinding>): MappingResult {
  const path = canonicalPath(input)
  const url = canonicalFileUrl(path)
  const urlKey = process.platform === "win32" ? url.toLowerCase() : url
  const all = [...bindings]
  const exact = all.filter((item) => (process.platform === "win32" ? item.entryUrl.toLowerCase() : item.entryUrl) === urlKey)
  if (exact.length) return { kind: "matched", entryIds: [...new Set(exact.map((item) => item.entryId))] }

  let bestLength = -1
  let matches: string[] = []
  for (const item of all) {
    for (const root of item.roots) {
      const child = relative(root, path)
      if (child === "" || child === ".." || child.startsWith("..\\") || child.startsWith("../") || isAbsolute(child)) continue
      if (root.length > bestLength) {
        bestLength = root.length
        matches = [item.entryId]
      } else if (root.length === bestLength) {
        matches.push(item.entryId)
      }
    }
  }
  matches = [...new Set(matches)]
  if (matches.length === 1) return { kind: "matched", entryIds: matches }
  if (matches.length > 1) return { kind: "ambiguous", path, entryIds: matches }
  return { kind: "unowned", path }
}