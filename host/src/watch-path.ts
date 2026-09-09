import { realpath } from "node:fs/promises"
import { isAbsolute, normalize, relative, resolve } from "node:path"
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
  const url = input instanceof URL
    ? input
    : /^file:/i.test(input)
      ? new URL(input)
      : undefined
  if (url && url.protocol !== "file:") {
    throw new TypeError(`watch paths must use the file: protocol, received ${url.protocol}`)
  }
  if (!url && /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) {
    throw new TypeError(`watch paths must use the file: protocol, received ${input}`)
  }
  const value = url ? fileURLToPath(url) : input as string
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

export async function canonicalExistingPath(input: string | URL): Promise<string> {
  try {
    return canonicalPath(await realpath(lexicalPath(input)))
  } catch {
    return canonicalPath(input)
  }
}

export function binding(entryId: string, entryUrl: string | URL, roots: Array<string | URL>): EntryBinding {
  return {
    entryId,
    entryUrl: canonicalFileUrl(entryUrl),
    roots: roots.map(canonicalPath),
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

