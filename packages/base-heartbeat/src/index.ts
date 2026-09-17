/**
 * The heartbeat plugin — the host's readiness probe.
 *
 * `host/src/index.ts` asserts on startup that this service is present (see
 * `declaresHeartbeat`), so it is the one plugin the host genuinely depends on.
 *
 * WHY IT IS A PACKAGE AND NOT A FILE UNDER host/plugins
 *   Base plugins live in `packages/base-*` so that they are shaped like every
 *   other plugin: a directory with its own manifest, its own version, and its own
 *   tests. `host/plugins/` cannot express that — a file there has no place to put
 *   a manifest, and the host would have to special-case the base package instead
 *   of treating it like anything else it loads.
 *
 * WHY `ctx.provide` AND NOT A `Service` SUBCLASS
 *   `provide(name, plainObject)` is enough here because nothing needs to attribute
 *   a call to a caller: the host only asks whether the service EXISTS. A service
 *   other plugins call into must be a `Service` subclass instead, or the host
 *   cannot tell two callers apart (docs/cordis-runtime-findings.md §1.2).
 */
import type { Context } from "cordis"

export function apply(ctx: Context) {
  ctx.provide("heartbeat", { ok: true })
}
