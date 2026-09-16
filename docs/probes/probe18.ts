// M2/M4 decision evidence: is DLL loading IN-PROCESS, and what does that mean
// for the "tier" (access whitelist / subprocess isolation) model?
//
// The architecture (§1.4) puts dll/native plugins in T2 = "独立受管子进程",
// on the premise that process isolation is what constrains them. But the normal
// way a plugin uses a native library is `dlopen`/`LoadLibrary` — which loads it
// INTO THE CALLING PROCESS.
//
// This probe proves the in-process claim in the most direct way available:
// call GetCurrentProcessId() through FFI and compare it to the JS process's own
// pid. If they are equal, the native code runs inside the host process and can
// do anything the host can — no JS-level access whitelist can constrain it.
//
// RUN: bun run docs/probes/probe18.ts

import { dlopen, FFIType } from "bun:ffi"

const out: Record<string, unknown> = {}

try {
  // kernel32 exists on every Windows box; this is the same mechanism a plugin
  // would use for its own bundled DLL.
  const lib = dlopen("kernel32.dll", {
    GetCurrentProcessId: { args: [], returns: FFIType.u32 },
  })
  const nativePid = lib.symbols.GetCurrentProcessId()
  const jsPid = process.pid

  out.mechanism = "bun:ffi dlopen"
  out.library = "kernel32.dll"
  out.nativePid = nativePid
  out.jsPid = jsPid
  out.sameProcess = nativePid === jsPid

  // The consequence, stated as a check rather than prose: the loaded native code
  // executes with this process's identity, so an fs/http whitelist enforced in
  // JS cannot bind it.
  out.nativeCodeSharesProcessIdentity = nativePid === jsPid
  out.ok = nativePid === jsPid
} catch (e) {
  out.ok = false
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

console.log(JSON.stringify(out, null, 2))
if (out.ok !== true) process.exitCode = 1
