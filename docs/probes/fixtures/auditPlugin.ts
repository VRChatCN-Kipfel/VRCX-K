// Fixture for probe5: an Entry-loaded plugin that calls the auditor service,
// so we can verify the caller -> fiber -> entry -> options walk.

import { Context } from "../../../host/node_modules/cordis/lib/index.js"

export const name = "auditPlugin"

export function apply(ctx: any) {
  const g: any = globalThis
  try {
    g.__auditFromEntry = (ctx as any).auditor.audit()
  } catch (e) {
    g.__auditFromEntry = { callError: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}
