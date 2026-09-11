// Fixture plugin for the Entry-level inject probe. Loaded by @cordisjs/plugin-loader
// (not by a direct import), so it exercises the real loader path.

import { Context } from "../../../host/node_modules/cordis/lib/index.js"

export const name = "entryPlugin"

export function apply(ctx: any) {
  const g: any = globalThis
  const intercept = ctx[Context.intercept]
  g.__entryProbe = {
    fiberName: ctx.fiber?.name ?? null,
    interceptKeys: intercept ? Object.keys(intercept) : null,
    interceptEntrySvc: intercept ? JSON.stringify(intercept.entrySvc ?? null) : null,
    fiberInject: JSON.stringify(ctx.fiber?.inject ?? null),
  }
}
