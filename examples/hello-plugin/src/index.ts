// A minimal, loadable VRCX-K plugin — copy this directory to start a new one.
//
// WHY THIS FILE EXISTS
//   Until now the only example was `heartbeat.ts`, which provides a service and
//   does nothing else. A new author had no runnable starting point showing the
//   two things that are easy to get wrong:
//
//     1. the EFFECT DISCIPLINE — every side effect registered via ctx.effect, so
//        it is torn down in reverse when the plugin unloads, and
//     2. reaching the host through a CURATED DOMAIN SERVICE (ctx.notify) rather
//        than the raw escape hatch (ctx.shell).
//
// ⚠ READ THIS BEFORE TYPING `ctx.notify`
//   The VRCX-K services are declared by a MODULE AUGMENTATION that lives in the
//   host (`host/src/capability.ts`), not in cordis itself. A plugin outside
//   `host/` therefore has no `ctx.notify` type until it pulls that declaration
//   in — which is why the import below exists. Without it the editor reports
//   "Property 'notify' does not exist on type 'Context'".
//
// HOW TO RUN IT
//   From the repo root, with a shell attached:
//     bun run dev:host
//   It logs a line on load and exposes `ctx.hello` for other plugins to call.
//
// WHAT TO CHANGE
//   · `id` in .vrcxk/manifest.json  (unique, and matching the index entry)
//   · the service name you provide, if any
//   · the timer interval, or drop the timer entirely

// Type-only declaration of the host services this plugin uses.
//
// WHY NOT `import type {} from "../../../host/src/capability"`:
//   That works, but it drags the whole host source tree into this project's
//   typecheck — and the host needs compiler settings this example does not have,
//   so unrelated host errors surface here. A plugin is an INDEPENDENT artifact;
//   it should depend on the host's TYPES, not compile the host's SOURCES.
//
// The long-term answer is a published `@vrcx-k/plugin-sdk` types package (see
// #19). Until it exists, a plugin re-declares the little it uses — which is also
// an honest picture of the current authoring experience.
declare module "cordis" {
  interface Context {
    /** Curated domain service. Prefer this over the raw `ctx.shell` channel. */
    notify: {
      send(title: string, body: string): Promise<boolean>
    }
  }
}

import type { Context } from "cordis"

/** The service this plugin provides to others. Typed so callers get autocomplete. */
export interface HelloService {
  greet(who: string): string
}

export function apply(ctx: Context) {
  // ── 1. Provide a service other plugins can inject ────────────────────────
  //
  // ⚠ `ctx.provide(name, plainObject)` gives callers NO attribution: the methods
  //   carry no `symbols.caller`, so two different plugins calling in look
  //   identical (docs/cordis-runtime-findings.md §1.2). If you need to know WHO
  //   called, use a `Service` subclass — and its methods must be CLASS METHODS,
  //   because an arrow-function property silently loses attribution (§1.8).
  const service: HelloService = {
    greet: (who) => `hello, ${who}`,
  }
  ctx.provide("hello", service)

  // ── 2. Register EVERY side effect through ctx.effect ────────────────────
  //
  // The disposer returned from the effect is what cordis calls, in REVERSE
  // order, when the plugin unloads. A bare `setInterval` would keep firing after
  // unload and leak a little on every reload — exactly what the t11 requirement
  // (N=100 load/unload back to baseline) measures.
  ctx.effect(() => {
    const timer = setInterval(() => {
      // Reaching the host through a CURATED DOMAIN SERVICE, not ctx.shell.
      // `ctx.shell.notify` also exists, but it is the low-level channel — the
      // curated services exist so a template has one stable entry point.
      void ctx.notify.send("hello-plugin", `still alive at ${new Date().toISOString()}`)
    }, 60_000)

    // Reclaim the timer. Forgetting this return value is the single most common
    // leak in this codebase's plugin model.
    return () => clearInterval(timer)
  })
}
