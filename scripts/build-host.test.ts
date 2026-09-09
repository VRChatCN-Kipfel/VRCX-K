import { describe, expect, test } from "bun:test"
import { bunTargetForTriple, compileFailureMessage, parseArgs, resolveTargetTriple, sidecarName, RUST_TO_BUN_TARGET } from "./build-host"

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

describe("CLI argument parsing", () => {
  test("parses explicit flags", () => {
    expect(parseArgs(["--target-triple", "aarch64-pc-windows-msvc", "--out-dir", "tmp"])).toEqual({
      targetTriple: "aarch64-pc-windows-msvc",
      outDir: "tmp",
    })
    expect(parseArgs(["--triple", "x86_64-unknown-linux-gnu"])).toEqual({ targetTriple: "x86_64-unknown-linux-gnu" })
    expect(parseArgs(["-h"])).toEqual({ help: true })
    expect(parseArgs([])).toEqual({})
  })

  test("a valueless --target-triple is an error instead of a silent fallback", () => {
    expect(() => parseArgs(["--target-triple"])).toThrow(/requires a Rust target triple/)
    // A following flag is not a value either.
    expect(() => parseArgs(["--target-triple", "--out-dir", "x"])).toThrow(/requires a Rust target triple/)
  })

  test("a valueless --out-dir is an error", () => {
    expect(() => parseArgs(["--out-dir"])).toThrow(/requires a directory path/)
  })

  test("unknown arguments are rejected", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument: --nope/)
  })
})

describe("compile failure reporting", () => {
  test("a spawn failure reports compile.error, never the string 'undefined'", () => {
    const message = compileFailureMessage({
      triple: "x86_64-pc-windows-msvc",
      bunTarget: "bun-windows-x64",
      status: null, // spawn failed: no exit status, no stderr
      stderr: null,
      error: new Error("spawn bun ENOENT"),
    })
    expect(message).toContain("spawn error: spawn bun ENOENT")
    expect(message).toContain("triple=x86_64-pc-windows-msvc")
    expect(message).toContain("target=bun-windows-x64")
    expect(message).not.toContain("undefined")
  })

  test("a non-zero exit reports the status and stderr", () => {
    const message = compileFailureMessage({
      triple: "aarch64-apple-darwin",
      bunTarget: "bun-darwin-arm64",
      status: 1,
      stderr: "error: could not resolve\n",
    })
    expect(message).toContain("exit status 1")
    expect(message).toContain("error: could not resolve")
  })

  test("a killed compile reports the signal", () => {
    const message = compileFailureMessage({
      triple: "x86_64-unknown-linux-gnu",
      bunTarget: "bun-linux-x64",
      status: null,
      signal: "SIGKILL",
    })
    expect(message).toContain("killed by signal SIGKILL")
  })
})
