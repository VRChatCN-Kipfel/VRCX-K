// M2-1 spike v6 (decisive for M2-8): the service cannot read the ENTRY's
// `inject` config through ctx[Context.intercept] (probe4 proved the loader
// merges entry options into fiber.inject AFTER the intercept map is built).
//
// But the loader sets `fiber.entry` (plugin-loader/lib/index.js:578-580). So the
// service should be able to walk caller -> fiber -> entry -> options, and read
// the plugin's manifest/declaration directly.
//
// This probe verifies that walk, for BOTH plugin shapes:
//   - a loader ENTRY (the real plugin shape), and
//   - a bare ctx.plugin() (host-internal plugins, e.g. tray/shortcut wiring).

import { fileURLToPath, pathToFileURL } from "node:url"
import { Context, Service, symbols } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"

const out: Record<string, unknown> = {}
const g: any = globalThis

function err(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

async function main() {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(fileURLToPath(new URL("./fixtures", import.meta.url))).href + "/"

  class Auditor extends Service {
    constructor(c: any) {
      super(c, "auditor")
    }
    /** What an access-warning implementation would need. */
    audit() {
      const self: any = this
      const caller: any = self[symbols.caller]
      const fiber: any = caller?.fiber
      const entry: any = fiber?.entry
      return {
        callerFiberName: fiber?.name ?? null,
        callerFiberUid: fiber?.uid ?? null,
        hasEntry: !!entry,
        entryId: entry?.id ?? null,
        entryName: entry?.options?.name ?? null,
        entryDisabled: entry?.options?.disabled ?? null,
        entryInject: entry ? JSON.stringify(entry.options?.inject ?? null) : null,
        entryConfig: entry ? JSON.stringify(entry.options?.config ?? null) : null,
        // Can the entry carry our manifest? (unknown key survives on options?)
        entryExtraKeys: entry ? Object.keys(entry.options ?? {}) : null,
        // The fiber's own inject dict (entry inject merged in by the loader)
        fiberInject: JSON.stringify(fiber?.inject ?? null),
        // The intercept map (probe4 showed the entry config is NOT here)
        interceptKeys: Object.keys(caller?.[Context.intercept] ?? {}),
      }
    }
  }
  new Auditor(ctx)

  await ctx.plugin(Loader)

  // 1. A loader ENTRY — the real plugin shape.
  try {
    const id = await ctx.loader.create({
      name: "./auditPlugin.ts",
      config: { someOption: "hello" },
      inject: { auditor: { declared: ["notify", "dialog"] } },
    })
    out.entryId = id
    await new Promise((r) => setTimeout(r, 80))
    out.fromEntry = g.__auditFromEntry ?? null
  } catch (e) {
    out.entryError = err(e)
  }

  // 2. A bare ctx.plugin() — host-internal plugins have no Entry.
  try {
    await ctx.plugin(function barePlugin(inner: any) {
      try {
        const r = inner.auditor.audit()
        r.hostPlugin = "barePlugin"
        out.fromBarePlugin = r
      } catch (e) {
        out.fromBarePlugin_error = err(e)
      }
    })
  } catch (e) {
    out.bareError = err(e)
  }

  console.log(JSON.stringify(out, (k, v) => (typeof v === "symbol" ? v.toString() : v), 2))
}

await main()
