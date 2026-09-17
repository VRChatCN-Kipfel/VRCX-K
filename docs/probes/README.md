# Probe dev pitfalls (dogfooding `docs/probes/`, measured 2026-09)

> Applies to anything under `docs/probes/` — and to any throwaway experiment in `.temp/`.

- **`ctx.plugin()` is async, and it does not error if you forget to await**: the plugin stays in `LOADING` and the output is entirely empty. `probe.ts` v1 was lost to this ("every plugin was still LOADING when the report printed"). Always `await ctx.plugin(...)`.
- **`fn.name = "x"` is a read-only property** — assigning throws `TypeError`. Use `Object.defineProperty` if you really need to fake a name.
- **`[].every()` is `true`**: any "wait until all rows have settled" loop that forgets `rows.length > 0` breaks on the very first iteration **without erroring**. Symptom is "nothing was collected", not a failure. Bit us once in `probe122.ts`; check for it in every collection loop.
- **PowerShell wraps bun's stderr as `NativeCommandError`**, masking the real error message. Prefer `bun run <file>` over inline `node -e` / `bun -e`, and prefer a `.cjs` file over inline `-e` (in PowerShell `&` inside a double-quoted `-e "..."` is a reserved word).
- **`docs/probes/` cannot resolve `host/node_modules`**: reference dependencies explicitly as `../../host/node_modules/...` (existing convention; see `probe11`).

## Re-running

```
bun run docs/probes/probeN.ts
```