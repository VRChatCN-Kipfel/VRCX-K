import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertPluginIndexEntry,
  assertPluginManifest,
  assertSupportedRestartClass,
  validatePluginIndexEntry,
  validatePluginManifest,
  RESTART_CLASSES,
  SUPPORTED_RESTART_CLASSES,
} from "../src/contracts/pluginContract"
import { PluginManifestRegistry } from "../src/contracts/pluginRegistry"
import type { VRCXKPluginManifest } from "../src/contracts/pluginManifest.generated"
import type { VRCXKPluginIndexEntry } from "../src/contracts/pluginIndexEntry.generated"

const minimalManifest: VRCXKPluginManifest = {
  id: "friend-presence",
  version: "1.2.0",
  author: "me",
  name: "好友在线状态",
}

const fullManifest: VRCXKPluginManifest = {
  id: "friend-presence",
  version: "1.2.0-beta.1",
  author: "me",
  name: "好友在线状态",
  description: "追踪好友上下线与位置变化",
  repository: "https://github.com/me/vrcxk-plugins",
  homepage: "https://github.com/me/vrcxk-plugins#readme",
  license: "MIT",
  platforms: ["windows", "linux"],
  arch: ["x64", "arm64"],
  restartClass: "restartable",
  dependencies: { "audit-logger": "*", "secrets-vault": "~2.1.0" },
  services: { required: ["notify"], optional: ["dialog"], implements: ["friendPresence"] },
  permissions: { shell: ["window", "path"], notify: true, dialog: true },
  frontend: { entry: "ui/index.js", slots: ["dashboard.widget"] },
}

const minimalIndexEntry: VRCXKPluginIndexEntry = {
  id: "friend-presence",
  type: "feature",
  source: { url: "https://github.com/me/vrcxk-plugins.git" },
  name: "好友在线状态",
  description: "追踪好友上下线与位置变化",
  author: "me",
  repository: "https://github.com/me/vrcxk-plugins",
}

describe("plugin manifest contract (schema <-> TS mirror)", () => {
  test("accepts the minimal and the fully-populated manifest", () => {
    expect(validatePluginManifest(minimalManifest)).toBe(true)
    expect(validatePluginManifest(fullManifest)).toBe(true)
    expect(() => assertPluginManifest(fullManifest)).not.toThrow()
  })

  test("rejects missing required fields", () => {
    for (const field of ["id", "version", "author", "name"] as const) {
      const candidate = { ...minimalManifest } as Record<string, unknown>
      delete candidate[field]
      expect(validatePluginManifest(candidate)).toBe(false)
    }
  })

  test("rejects unknown fields (additionalProperties: false)", () => {
    expect(validatePluginManifest({ ...minimalManifest, unexpected: true })).toBe(false)
    expect(validatePluginManifest({ ...minimalManifest, schema_version: 1 })).toBe(false)
  })

  test("rejects a non-semver version, including the underscore form", () => {
    for (const version of ["1.2", "1.2.0.1", "v1.2.0", "1.2.0-", "1.2.0-alpha_1", "1.2.0-01"]) {
      expect(validatePluginManifest({ ...minimalManifest, version })).toBe(false)
    }
    // The forms we DO accept, including uppercase and dotted prereleases.
    for (const version of ["1.2.0", "1.2.0-alpha", "1.2.0-ALPHA", "1.2.0-rc.1", "1.2.0-alpha-1"]) {
      expect(validatePluginManifest({ ...minimalManifest, version })).toBe(true)
    }
  })

  test("rejects malformed plugin ids", () => {
    for (const id of ["Friend", "friend_presence", "-lead", "has space", ""]) {
      expect(validatePluginManifest({ ...minimalManifest, id })).toBe(false)
    }
    expect(validatePluginManifest({ ...minimalManifest, id: "a-b-9" })).toBe(true)
  })

  test("platforms is a closed enum of THREE coarse operating systems", () => {
    for (const platform of ["windows", "linux", "macos"]) {
      expect(validatePluginManifest({ ...minimalManifest, platforms: [platform] })).toBe(true)
    }
    // The trap this two-axis shape exists to close: a combined value like
    // `windows-x64` looks natural, mixes the axes, and cannot distinguish x64
    // from arm64. Neither a bun compile target nor a Rust triple is legal.
    for (const wrong of [
      "win32-x64",
      "windows-x64",
      "x86_64-pc-windows-msvc",
      "darwin",
      "macos-arm64",
      "win32",
    ]) {
      expect(validatePluginManifest({ ...minimalManifest, platforms: [wrong] })).toBe(false)
    }
  })

  test("arch is a separate axis", () => {
    expect(validatePluginManifest({ ...minimalManifest, arch: ["x64"] })).toBe(true)
    expect(
      validatePluginManifest({
        ...minimalManifest,
        platforms: ["windows", "linux"],
        arch: ["x64", "arm64"],
      }),
    ).toBe(true)
    for (const wrong of ["ia32", "arm", "x86_64", "AMD64", "arm64-v8a"]) {
      expect(validatePluginManifest({ ...minimalManifest, arch: [wrong] })).toBe(false)
    }
  })

  test("shell permissions accept only known sub-domains", () => {
    expect(validatePluginManifest({ ...minimalManifest, permissions: { shell: ["window"] } })).toBe(
      true,
    )
    expect(validatePluginManifest({ ...minimalManifest, permissions: { shell: true } })).toBe(true)
    expect(
      validatePluginManifest({ ...minimalManifest, permissions: { shell: ["window.show"] } }),
    ).toBe(false)
    expect(validatePluginManifest({ ...minimalManifest, permissions: { nope: true } })).toBe(false)
  })

  test("frontend.entry cannot escape the plugin directory", () => {
    expect(validatePluginManifest({ ...minimalManifest, frontend: { entry: "ui/index.js" } })).toBe(
      true,
    )
    for (const entry of ["../outside.js", "/abs/path.js", "ui/../../escape.js"]) {
      expect(validatePluginManifest({ ...minimalManifest, frontend: { entry } })).toBe(false)
    }
    // A TRAILING `..` segment is the shape an earlier version of this pattern let
    // through (it only guarded `../`, not `..` at the end). Regression-pinned here
    // because docs/probes/probe20.ts caught it, not the original test.
    for (const entry of ["..", "ui/..", "a/b/.."]) {
      expect(validatePluginManifest({ ...minimalManifest, frontend: { entry } })).toBe(false)
    }
  })

  test("a path pattern cannot catch every traversal shape — the loader must re-check", () => {
    // These are recorded as a KNOWN LIMITATION rather than assumed safe. A regex
    // over the literal string cannot see through percent-encoding, a Windows
    // drive letter, or a UNC path, so schema validation alone is not a containment
    // guarantee: whoever resolves the path must verify the result stays inside the
    // plugin directory.
    for (const entry of [
      "ui/%2e%2e/x.js",
      "..%2foutside.js",
      "C:/abs.js",
      "\\\\server\\share\\x.js",
    ]) {
      expect(validatePluginManifest({ ...minimalManifest, frontend: { entry } })).toBe(true)
    }
  })

  test("dependencies accept ranges but never a source", () => {
    expect(
      validatePluginManifest({ ...minimalManifest, dependencies: { a: "*", b: "~2.1.0" } }),
    ).toBe(true)
    // A non-string value (e.g. an object naming a source) must not validate: the
    // author cannot know which sources the user has configured.
    expect(
      validatePluginManifest({ ...minimalManifest, dependencies: { a: { version: "1" } } }),
    ).toBe(false)
  })
})

describe("restartClass vocabulary vs the supported subset", () => {
  test("the schema carries all three classes", () => {
    expect([...RESTART_CLASSES]).toEqual(["restartable", "frontend", "background"])
    for (const restartClass of RESTART_CLASSES) {
      expect(validatePluginManifest({ ...minimalManifest, restartClass })).toBe(true)
    }
  })

  test("only `restartable` is honoured today, and the rest are REJECTED", () => {
    expect([...SUPPORTED_RESTART_CLASSES]).toEqual(["restartable"])
    expect(() => assertSupportedRestartClass(minimalManifest)).not.toThrow()
    // Reject rather than downgrade: a silent downgrade would tell the author
    // their declaration was honoured when it was not.
    for (const restartClass of ["frontend", "background"] as const) {
      expect(() => assertSupportedRestartClass({ ...minimalManifest, restartClass })).toThrow(
        /not supported yet/,
      )
    }
  })

  test("an omitted restartClass means restartable", () => {
    expect(() => assertSupportedRestartClass(minimalManifest)).not.toThrow()
  })
})

describe("plugin index entry contract", () => {
  test("accepts the minimal entry and rejects missing required fields", () => {
    expect(validatePluginIndexEntry(minimalIndexEntry)).toBe(true)
    for (const field of [
      "id",
      "type",
      "source",
      "name",
      "description",
      "author",
      "repository",
    ] as const) {
      const candidate = { ...minimalIndexEntry } as Record<string, unknown>
      delete candidate[field]
      expect(validatePluginIndexEntry(candidate)).toBe(false)
    }
  })

  test("source.url MUST end in .git (the suffix is the discriminator)", () => {
    expect(validatePluginIndexEntry(minimalIndexEntry)).toBe(true)
    for (const url of [
      "https://github.com/me/vrcxk-plugins",
      "http://github.com/me/x.git",
      "git@github.com:me/x.git",
    ]) {
      expect(validatePluginIndexEntry({ ...minimalIndexEntry, source: { url } })).toBe(false)
    }
    expect(
      validatePluginIndexEntry({
        ...minimalIndexEntry,
        source: { url: "https://github.com/me/x.git", path: "packages/a" },
      }),
    ).toBe(true)
  })

  test("source.path cannot escape the repository", () => {
    const withPath = (path: string) => ({
      ...minimalIndexEntry,
      source: { ...minimalIndexEntry.source, path },
    })
    expect(validatePluginIndexEntry(withPath("packages/a"))).toBe(true)
    for (const path of ["../outside", "/abs", "a/../../b"]) {
      expect(validatePluginIndexEntry(withPath(path))).toBe(false)
    }
    // Same trailing-`..` regression as frontend.entry — both patterns are one
    // shape, so both are pinned (docs/probes/probe20.ts).
    for (const path of ["..", "a/.."]) {
      expect(validatePluginIndexEntry(withPath(path))).toBe(false)
    }
  })

  test("type is the closed official vocabulary", () => {
    for (const type of ["core", "library", "feature", "ui", "integration", "tool"]) {
      expect(validatePluginIndexEntry({ ...minimalIndexEntry, type })).toBe(true)
    }
    for (const type of ["plugin", "unknown", "Feature", "application"]) {
      expect(validatePluginIndexEntry({ ...minimalIndexEntry, type })).toBe(false)
    }
  })

  test("tags carry an optional colour and are presentation-only", () => {
    expect(
      validatePluginIndexEntry({
        ...minimalIndexEntry,
        tags: [{ label: "好友", color: "#ea5252" }],
      }),
    ).toBe(true)
    expect(validatePluginIndexEntry({ ...minimalIndexEntry, tags: [{ label: "好友" }] })).toBe(true)
    expect(
      validatePluginIndexEntry({ ...minimalIndexEntry, tags: [{ label: "x", color: "red" }] }),
    ).toBe(false)
    expect(validatePluginIndexEntry({ ...minimalIndexEntry, tags: [{ color: "#ea5252" }] })).toBe(
      false,
    )
  })

  test("the index carries NO version, checksum or permissions (P3)", () => {
    // Removing these from the index is what makes a release PR-free. If one is
    // ever re-added this test should fail loudly rather than let it slip in.
    for (const forbidden of ["version", "sha256", "permissions", "dependencies"]) {
      expect(validatePluginIndexEntry({ ...minimalIndexEntry, [forbidden]: 1 })).toBe(false)
    }
  })
})

describe("PluginManifestRegistry", () => {
  test("keys on the entry-id SUFFIX, since the prefix changes every run", () => {
    // Measured in docs/probes/probe11.ts: `<random>:<yaml-id>`, and the prefix is
    // the Include entry's own id, which differs on every boot.
    expect(PluginManifestRegistry.keyOf("9978a6ed:friend-presence")).toBe("friend-presence")
    expect(PluginManifestRegistry.keyOf("776b8d0a:friend-presence")).toBe("friend-presence")
    // An id with no separator is already its own suffix.
    expect(PluginManifestRegistry.keyOf("friend-presence")).toBe("friend-presence")

    const registry = new PluginManifestRegistry()
    registry.register("9978a6ed:friend-presence", minimalManifest)
    // A DIFFERENT run's prefix must resolve to the same registration.
    expect(registry.get("776b8d0a:friend-presence")?.id).toBe("friend-presence")
    expect(registry.has("deadbeef:friend-presence")).toBe(true)
    expect(registry.keys()).toEqual(["friend-presence"])
  })

  test("register validates, but an absent manifest is not an error", () => {
    const registry = new PluginManifestRegistry()
    expect(() => registry.register("x:bad", { id: "bad" })).toThrow(/invalid plugin manifest/)
    // No declaration simply means nothing to compare against; the caller decides.
    expect(registry.get("x:missing")).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  test("unregister drops the entry", () => {
    const registry = new PluginManifestRegistry()
    registry.register("p:friend-presence", minimalManifest)
    registry.unregister("q:friend-presence")
    expect(registry.has("p:friend-presence")).toBe(false)
  })

  test("injectFor derives from services.required only (D2 option A)", () => {
    // required -> inject: a readiness gate.
    expect(PluginManifestRegistry.injectFor(fullManifest)).toEqual(["notify"])
    // optional must NOT be injected: injecting an absent service would park the
    // fiber in PENDING forever instead of degrading.
    expect(PluginManifestRegistry.injectFor(fullManifest)).not.toContain("dialog")
    expect(PluginManifestRegistry.injectFor(minimalManifest)).toEqual([])
  })

  test("readFrom loads <dir>/.vrcxk/manifest.json and rejects a bad one", async () => {
    const root = mkdtempSync(join(tmpdir(), "vrcxk-manifest-"))
    try {
      const good = join(root, "good")
      mkdirSync(join(good, ".vrcxk"), { recursive: true })
      writeFileSync(join(good, ".vrcxk", "manifest.json"), JSON.stringify(fullManifest))

      const loaded = await PluginManifestRegistry.readFrom(good)
      expect(loaded.id).toBe("friend-presence")
      expect(loaded.version).toBe("1.2.0-beta.1")

      // Trailing separator must not produce a doubled path segment.
      expect((await PluginManifestRegistry.readFrom(`${good}/`)).id).toBe("friend-presence")

      const bad = join(root, "bad")
      mkdirSync(join(bad, ".vrcxk"), { recursive: true })
      writeFileSync(join(bad, ".vrcxk", "manifest.json"), JSON.stringify({ id: "x" }))
      await expect(PluginManifestRegistry.readFrom(bad)).rejects.toThrow(/invalid plugin manifest/)

      const missing = join(root, "missing")
      mkdirSync(missing, { recursive: true })
      await expect(PluginManifestRegistry.readFrom(missing)).rejects.toThrow(/not found/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
