# Probe dev pitfalls (dogfooding `docs/probes/`, measured 2026-09)

> Applies to anything under `docs/probes/` — and to any throwaway experiment in `.temp/`.

- **`ctx.plugin()` is async, and it does not error if you forget to await**: the plugin stays in `LOADING` and the output is entirely empty. `probe.ts` v1 was lost to this ("every plugin was still LOADING when the report printed"). Always `await ctx.plugin(...)`.
- **`fn.name = "x"` is a read-only property** — assigning throws `TypeError`. Use `Object.defineProperty` if you really need to fake a name.
- **`[].every()` is `true`**: any "wait until all rows have settled" loop that forgets `rows.length > 0` breaks on the very first iteration **without erroring**. Symptom is "nothing was collected", not a failure. Bit us once in `probe122.ts`; check for it in every collection loop.
- **PowerShell wraps bun's stderr as `NativeCommandError`**, masking the real error message. Prefer `bun run <file>` over inline `node -e` / `bun -e`, and prefer a `.cjs` file over inline `-e` (in PowerShell `&` inside a double-quoted `-e "..."` is a reserved word).
- **`docs/probes/` cannot resolve `host/node_modules`**: reference host-only dependencies explicitly as `../../host/node_modules/...` (existing convention; see `probe11`). **Check the depth**: a probe in a subdirectory needs one more `../` (`../../../host/node_modules/...`, as `stdio-lifecycle/*` does).
- **Not every bare specifier is a hoisting accident — check `package.json` before "fixing" one.** A dependency declared in the **root** `package.json` (e.g. `kkrpc`, used by `src/host.ts` and also by probes) resolves from the repo root legitimately, so `import ... from "kkrpc"` in a probe is not itself a violation. The rule above exists for **host-only** dependencies (`cordis`, `@cordisjs/*`, `isomorphic-git`), which are absent from the root and would only resolve by luck.
- **`bun -e` resolves bare specifiers against the CWD, not against your probe file.** A probe that spawns `bun -e "<code>"` (see `stdio-lifecycle/13-final-matrix.ts`) breaks the moment it is run from another directory, and the failure is **silent**: the child dies on import, prints nothing, and the probe reports "nothing fired" instead of "never ran". Resolve such modules in the parent with `Bun.resolveSync` / `pathToFileURL(...)` and inline the absolute `file://` URL. When a child can fail this way, assert on the child's own `shapeHonored`-style echo and exit non-zero rather than printing a table of `undefined`.

## `stdio-lifecycle/` (subdirectory)

The stdio lifecycle investigation behind PR #38. Read
[`stdio-lifecycle/FINDINGS.md`](stdio-lifecycle/FINDINGS.md) first — it carries the
mechanism (flowing mode, not the lock) and §4 lists the exact runnable commands.
Five of its 23 probes were promoted; the rest stayed in `.temp/` and are gone.

```
bun run docs/probes/stdio-lifecycle/13-final-matrix.ts   # the consolidated matrix, ~50s
$env:N="3"; bun run docs/probes/stdio-lifecycle/12-rpcchannel-repeat.ts
```

Note `04` and `09` need a real pipe on fd 0 to reproduce the documented readings
(pipe a byte in); `11` is normally run *via* `12`. See FINDINGS §4.3.

## Re-running

```
bun run docs/probes/probeN.ts
```