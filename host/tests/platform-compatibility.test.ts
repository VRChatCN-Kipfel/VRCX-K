/**
 * Platform compatibility, which is the entire REASON `platforms` and `arch` are
 * two fields instead of one enum.
 *
 * The failure being prevented is silent: a plugin shipping an x64-only native
 * library installs happily on arm64 Windows and throws when it loads. A single
 * `platforms: ["windows"]` declaration calls that compatible, so the pairing is
 * what makes the declaration able to say "Windows, but only x64".
 */
import { describe, expect, test } from "bun:test"
import {
  checkPlatformCompatibility,
  PLUGIN_ARCHES,
  PLUGIN_PLATFORMS,
  toPluginArch,
  toPluginPlatform,
} from "../src/contracts/platform"

const winX64 = { platform: "win32", arch: "x64" }
const winArm = { platform: "win32", arch: "arm64" }
const macArm = { platform: "darwin", arch: "arm64" }
const linuxX64 = { platform: "linux", arch: "x64" }

describe("host platform / arch mapping", () => {
  test("maps the Node names we ship hosts for", () => {
    expect(toPluginPlatform("win32")).toBe("windows")
    expect(toPluginPlatform("darwin")).toBe("macos")
    expect(toPluginPlatform("linux")).toBe("linux")
    expect(toPluginArch("x64")).toBe("x64")
    expect(toPluginArch("arm64")).toBe("arm64")
  })

  test("returns undefined for hosts we ship no host for", () => {
    // Must NOT silently match: a plugin cannot declare these and the host
    // cannot run there, so treating them as compatible hides a packaging bug.
    for (const p of ["freebsd", "aix", "sunos", "openbsd"]) {
      expect(toPluginPlatform(p)).toBeUndefined()
    }
    for (const a of ["ia32", "arm", "ppc64", "s390x", "riscv64"]) {
      expect(toPluginArch(a)).toBeUndefined()
    }
  })

  test("the accepted vocabularies are exactly the two enums", () => {
    expect([...PLUGIN_PLATFORMS]).toEqual(["windows", "linux", "macos"])
    expect([...PLUGIN_ARCHES]).toEqual(["x64", "arm64"])
  })
})

describe("compatibility verdicts", () => {
  test("no declaration means pure JS and runs anywhere", () => {
    for (const host of [winX64, winArm, macArm, linuxX64]) {
      expect(checkPlatformCompatibility({}, host)).toEqual({
        compatible: true,
        reason: "no-declaration",
      })
    }
  })

  test("platform alone matches every architecture of that OS", () => {
    const decl = { platforms: ["windows"] as const }
    expect(checkPlatformCompatibility(decl, winX64).compatible).toBe(true)
    expect(checkPlatformCompatibility(decl, winArm).compatible).toBe(true)
    expect(checkPlatformCompatibility(decl, macArm).compatible).toBe(false)
  })

  test("THE CASE THIS DESIGN EXISTS FOR: x64-only on arm64 is INCOMPATIBLE", () => {
    // With one combined enum this had to be spelled `windows-x64`; splitting the
    // axes is what lets the same fact be stated without mixing them.
    const decl = { platforms: ["windows"] as const, arch: ["x64"] as const }
    expect(checkPlatformCompatibility(decl, winX64)).toEqual({
      compatible: true,
      reason: "declared",
    })
    expect(checkPlatformCompatibility(decl, winArm)).toEqual({ compatible: false, reason: "arch" })
    expect(checkPlatformCompatibility(decl, macArm)).toEqual({
      compatible: false,
      reason: "platform",
    })
  })

  test("arch alone still constrains every platform", () => {
    const decl = { arch: ["arm64"] as const }
    expect(checkPlatformCompatibility(decl, macArm).compatible).toBe(true)
    expect(checkPlatformCompatibility(decl, winArm).compatible).toBe(true)
    expect(checkPlatformCompatibility(decl, winX64)).toEqual({ compatible: false, reason: "arch" })
  })

  test("multi-valued declarations are a union", () => {
    const decl = { platforms: ["windows", "linux"] as const, arch: ["x64"] as const }
    expect(checkPlatformCompatibility(decl, winX64).compatible).toBe(true)
    expect(checkPlatformCompatibility(decl, linuxX64).compatible).toBe(true)
    expect(checkPlatformCompatibility(decl, winArm).compatible).toBe(false)
    expect(checkPlatformCompatibility(decl, macArm).compatible).toBe(false)
  })

  test("an unsupported HOST is incompatible, not assumed to match", () => {
    expect(checkPlatformCompatibility({}, { platform: "freebsd", arch: "x64" })).toEqual({
      compatible: false,
      reason: "unsupported-host",
    })
    expect(
      checkPlatformCompatibility({ platforms: ["windows"] }, { platform: "win32", arch: "ia32" }),
    ).toEqual({
      compatible: false,
      reason: "unsupported-host",
    })
  })
})
