// Fixture for probe4: an Entry-loaded plugin that CALLS a service, so we can
// check both halves of the chain — the entry's own inject config reaching the
// service, and the service resolving the entry as the caller.

import { Context } from "../../../host/node_modules/cordis/lib/index.js"

export const name = "entryCallerPlugin"

export function apply(ctx: any) {
  const g: any = globalThis
  const seen: Record<string, unknown> = {
    fiberName: ctx.fiber?.name ?? null,
    fiberUid: ctx.fiber?.uid ?? null,
    interceptKeys: Object.keys(ctx[Context.intercept] ?? {}),
  }
  try {
    seen.callResult = (ctx as any).entryAwareSvc.readPolicy()
  } catch (e) {
    seen.callError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  }
  g.__entryCallerProbe = seen
}
