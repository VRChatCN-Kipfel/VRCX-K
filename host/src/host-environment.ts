// The host's own environment facts, collected for the ready handshake.
//
// WHY THIS IS NOT IN `contracts/hostReady.ts`: that module is imported by the
// face (`src/host.ts`), and the frontend's `tsconfig.json` deliberately carries
// no Bun/node types ("Bun globals must not leak into shipped code"). Reading
// `process`/`Bun`/`node:os` inside a shared contract module would break the
// frontend typecheck while looking perfectly fine to the host's own config. So
// the contract module stays pure and the environment read lives here.
//
// Rust mirrors the resulting shape in `src-tauri/src/host_ready.rs`.

import { cpus, totalmem } from "node:os"
import { toArch, toPlatform, type HostReady } from "./contracts/hostReady"

/**
 * The environment half of the handshake, read from the running process.
 *
 * `mode` uses `Bun.isStandaloneExecutable` rather than sniffing paths: it is the
 * runtime's own answer to "am I a compiled binary", and a path heuristic would
 * be wrong for a sidecar launched from an unusual location.
 *
 * `capacity` is intentionally a snapshot of only the slow-moving facts. Free
 * memory, RSS and uptime are absent by design — see the schema's note: `ready`
 * is sent once per process, so a fast-moving value would be read as a constant.
 * (`os.loadavg()` is excluded too, and is useless here regardless: it returns
 * `[0,0,0]` on Windows.) `capturedAtMs` dates the snapshot so a log reader
 * cannot mistake it for live.
 *
 * `extra` is deliberately not emitted. The slot exists so a FUTURE addition does
 * not need a schema bump; pre-populating it with speculative fields would defeat
 * the point of having named groups.
 */
export function collectHostEnvironment(): Pick<HostReady, "runtime" | "host" | "paths" | "capacity"> {
  return {
    runtime: {
      bunVersion: Bun.version,
      nodeVersion: process.version,
    },
    host: {
      platform: toPlatform(process.platform),
      arch: toArch(process.arch),
      mode: Bun.isStandaloneExecutable ? "compiled" : "source",
    },
    paths: {
      cwd: process.cwd(),
      execPath: process.execPath,
    },
    capacity: {
      capturedAtMs: Date.now(),
      cpuCount: cpus().length,
      totalMemBytes: totalmem(),
    },
  }
}
