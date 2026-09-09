import { describe, expect, test } from "bun:test"
import { bunTargetForTriple, resolveTargetTriple, sidecarName, RUST_TO_BUN_TARGET } from "./build-host"

describe("sidecar target mapping", () => {
  test("maps the full supported matrix without hard-coding x64", () => {
    expect(RUST_TO_BUN_TARGET).toEqual({
      "x86_64-pc-windows-msvc": "bun-windows-x64",
      "aarch64-pc-windows-msvc": "bun-windows-arm64",
      "x86_64-unknown-linux-gnu": "bun-linux-x64",
      "aarch64-unknown-linux-gnu": "bun-linux-arm64",
      "x86_64-apple-darwin": "bun-darwin-x64",
      "aarch64-apple-darwin": "bun-darwin-arm64",
    })
  })

  test("bunTargetForTriple fails fast on unknown triples", () => {
    expect(() => bunTargetForTriple("sparc64-unknown-linux-gnu")).toThrow(/unsupported Rust target triple/)
  })

  test("sidecarName appends .exe only for windows triples", () => {
    expect(sidecarName("x86_64-pc-windows-msvc")).toBe("host-x86_64-pc-windows-msvc.exe")
    expect(sidecarName("aarch64-pc-windows-msvc")).toBe("host-aarch64-pc-windows-msvc.exe")
    expect(sidecarName("aarch64-unknown-linux-gnu")).toBe("host-aarch64-unknown-linux-gnu")
    expect(sidecarName("aarch64-apple-darwin")).toBe("host-aarch64-apple-darwin")
  })
})

describe("target triple resolution", () => {
  test("explicit argument wins", () => {
    expect(resolveTargetTriple("aarch64-pc-windows-msvc")).toBe("aarch64-pc-windows-msvc")
  })

  test("Tauri env is honored when no explicit triple is given", () => {
    const previous = process.env.TAURI_ENV_TARGET_TRIPLE
    try {
      process.env.TAURI_ENV_TARGET_TRIPLE = "x86_64-unknown-linux-gnu"
      expect(resolveTargetTriple()).toBe("x86_64-unknown-linux-gnu")
    } finally {
      if (previous === undefined) delete process.env.TAURI_ENV_TARGET_TRIPLE
      else process.env.TAURI_ENV_TARGET_TRIPLE = previous
    }
  })

  test(
    "falls back to rustc host tuple",
    () => {
      const previous = process.env.TAURI_ENV_TARGET_TRIPLE
      try {
        delete process.env.TAURI_ENV_TARGET_TRIPLE
        const triple = resolveTargetTriple()
        expect(triple).toMatch(/^(x86_64|aarch64|i686)/)
      } finally {
        if (previous !== undefined) process.env.TAURI_ENV_TARGET_TRIPLE = previous
      }
    },
    30_000, // first rustc invocation can be a slow cold start on Windows
  )

  test("fails fast when no triple source is available", () => {
    const previousEnv = process.env.TAURI_ENV_TARGET_TRIPLE
    const previousPath = process.env.PATH
    try {
      delete process.env.TAURI_ENV_TARGET_TRIPLE
      // Empty PATH: the rustc probe cannot find the compiler.
      process.env.PATH = ""
      expect(() => resolveTargetTriple()).toThrow(/cannot resolve target triple/)
    } finally {
      if (previousEnv !== undefined) process.env.TAURI_ENV_TARGET_TRIPLE = previousEnv
      else delete process.env.TAURI_ENV_TARGET_TRIPLE
      if (previousPath !== undefined) process.env.PATH = previousPath
      else delete process.env.PATH
    }
  })
})
