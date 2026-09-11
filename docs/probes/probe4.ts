// M2-1 spike v5: does an ENTRY-level `inject` (loader EntryOptions) also land in
// ctx[Context.intercept], the way a plugin-level `inject` does (probe2 §D2)?
//
// This decides whether a plugin MANIFEST can declare per-caller capability
// policy that the service can actually read — i.e. whether the access
// declaration surface (M2-8) can hang off the manifest at all.

import { pathToFileURL } from "node:url"
import { Context } from "../../host/node_modules/cordis/lib/index.js"
import Loader from "../../host/node_modules/@cordisjs/plugin-loader/lib/index.js"

const out: Record<string, unknown> = {}
const g: any = globalThis

function err(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

async function main() {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(new URL("./fixtures/", import.meta.url).pathname.replace(/^\//, "")).href
  // Windows path fix: pathname gives "/E:/..." — use fileURLToPath instead.
  const { fileURLToPath } = await import("node:url")
  ctx.baseUrl = pathToFileURL(fileURLToPath(new URL("./fixtures", import.meta.url))).href + "/"

  out.baseUrl = ctx.baseUrl

  try {
    await ctx.plugin(Loader)
    out.loaderOk = true
  } catch (e) {
    out.loaderError = err(e)
    console.log(JSON.stringify(out, null, 2))
    return
  }

  // A service for the entry to inject, provided BEFORE the entry is created.
  ctx.provide("entrySvc", { tag: () => "svc" })

  try {
    const id = await ctx.loader.create({
      name: "./entryPlugin.ts",
      inject: { entrySvc: { mode: "entry", limit: 7 } },
    })
    out.entryId = id
    // Let the entry's fiber settle.
    await new Promise((r) => setTimeout(r, 60))

    const entry = ctx.loader.resolve?.(id)
    out.entryFiberState = entry?.fiber?.state ?? null
    out.entryOptionsInject = JSON.stringify(entry?.options?.inject ?? null)
    out.entryProbe = g.__entryProbe ?? null

    // Also: what does the entry's own ctx carry?
    const ectx: any = entry?.ctx
    if (ectx) {
      out.entryCtxInterceptKeys = Object.keys(ectx[Context.intercept] ?? {})
      out.entryCtxInterceptEntrySvc = JSON.stringify(ectx[Context.intercept]?.entrySvc ?? null)
      out.entryFiberInject = JSON.stringify(ectx.fiber?.inject ?? null)
      out.entryFiberName = ectx.fiber?.name ?? null
    }

    // And can a SERVICE read the entry's per-caller config the same way?
    const { Service, symbols } = await import("../../host/node_modules/cordis/lib/index.js")
    class EntryAwareSvc extends Service {
      constructor(c: any) {
        super(c, "entryAwareSvc")
      }
      readPolicy() {
        const self: any = this
        return {
          callerName: self?.[symbols.caller]?.fiber?.name ?? null,
          callerUid: self?.[symbols.caller]?.fiber?.uid ?? null,
          policy: JSON.stringify(self?.ctx?.[Context.intercept]?.entryAwareSvc ?? null),
        }
      }
    }
    new EntryAwareSvc(ctx)

    const id2 = await ctx.loader.create({
      name: "./entryCallerPlugin.ts",
      inject: { entryAwareSvc: { mode: "fromEntry" } },
    })
    out.entryId2 = id2
    await new Promise((r) => setTimeout(r, 60))
    out.entryCallerProbe = g.__entryCallerProbe ?? null
  } catch (e) {
    out.entryError = err(e)
  }

  console.log(JSON.stringify(out, (k, v) => (typeof v === "symbol" ? v.toString() : v), 2))
}

await main()
