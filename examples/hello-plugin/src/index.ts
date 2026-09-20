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
    /**
     * From `@cordisjs/plugin-timer` — mixed onto every context by the host.
     *
     * ⚠ Re-declared here for the same reason as `notify` above: the host's own
     *   augmentations are not importable by a plugin outside `host/`, so a plugin
     *   restates what it uses. This duplication — and the drift it invites — is
     *   exactly what a published `@vrcx-k/plugin-sdk` types package should remove
     *   (#19). Until then, restating is the honest picture of the authoring
     *   experience.
     *
     *   ⚠ And remember the rule that goes with it: ANY `ctx.*` access needs the
     *     matching name in `inject`, or the plugin never loads at all.
     */
    interval(callback: () => void, delay: number): () => void
    timeout(callback: () => void, delay: number): () => void
    throttle<T extends (...args: never[]) => void>(callback: T, delay: number): T
    debounce<T extends (...args: never[]) => void>(callback: T, delay: number): T
  }
}

import type { Context } from "cordis"

/**
 * ⚠ DECLARE WHAT YOU USE — and this is not optional.
 *
 * `ctx.notify` and `ctx.interval` are inject-gated. Touching one WITHOUT the
 * matching `inject` entry is a HARD failure: the fiber goes FAILED and the plugin
 * never loads at all. Measured both ways (host/tests/upstream-plugins.test.ts):
 *
 *     no inject        -> FAILED
 *     inject: ['timer'] -> ACTIVE
 *
 * So the `inject` array below is not documentation. It is the difference between
 * a plugin that runs and one that silently does not.
 */
export const inject = ["notify", "timer"]

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

  // ── 2. Schedule work with ctx.interval, NOT setInterval ─────────────────
  //
  // This used to be a hand-written `ctx.effect(() => { const t = setInterval(…)
  // return () => clearInterval(t) })` with a comment warning that forgetting the
  // disposer is the most common leak in this plugin model.
  //
  // `ctx.interval` removes the opportunity to forget: it registers the timer
  // through ctx.effect itself, so unloading the plugin stops it, and there is no
  // disposer for an author to omit. The discipline stopped being a rule to
  // remember and became the only way to write it.
  //
  // (Requires the `timer` entry in `inject` above — see the note there.)
  ctx.interval(() => {
    // Reaching the host through a CURATED DOMAIN SERVICE, not ctx.shell.
    // `ctx.shell.notify` also exists, but it is the low-level channel — the
    // curated services exist so a template has one stable entry point.
    void ctx.notify.send("hello-plugin", `still alive at ${new Date().toISOString()}`)
  }, 60_000)
}
