// Desktop-only shell capabilities added with the plugin round: `ctx.autostart`.
//
// WHY THIS IS A SERVICE AND NOT A RAW MIRROR
//   It is attributable and audited through `ctx.shell` already. It exists as a
//   curated service for the same reason `ctx.notify` does: SDK templates need one
//   stable entry point, and a plugin should not reach into the raw wire namespace
//   for a routine operation.
//
// ⚠ NOT a security boundary — declare-and-warn visibility only (`#24`). A plugin
//   that wants to write a startup entry can call the OS itself. The real boundary
//   is M4's subprocess isolation.
//
// ⚠ DESKTOP-ONLY: the shell does not register `shell.autostart.*` on mobile at
//   all, so this service must report "unsupported" rather than pretending the OS
//   refused something.
//
// NOTE ON `os` AND `clipboard`: neither lives here. OS facts were folded into the
// existing `ctx.os` service and clipboard into a `buildNode` mirror in
// `capability.ts` — both are stateless pass-throughs with no lifecycle, so a
// purpose-built `Service` subclass would add ceremony without adding a guarantee.
// `autostart` differs only in needing to distinguish "no shell" from "this
// platform has no such capability", which a plain mirror cannot express.

import { type Context, Service } from "cordis"
import type { ShellStdioBridge } from "./stdio"

declare module "cordis" {
  interface Context {
    autostart: AutostartService
  }
}

/** The verdict shape the capability services share: never throw, always report. */
export type AutostartVerdict =
  | { status: "ok" }
  /** The shell is not attached (`VRCXK_SHELL` unset) — nothing was attempted. */
  | { status: "no-shell" }
  /** The shell has no such route (mobile) — the capability does not exist here. */
  | { status: "unsupported" }
  | { status: "error"; error: string }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * "Start with the system" (desktop only).
 *
 * ⚠ The shell provides the MECHANISM only — nothing enables autostart at boot.
 * Whether the app should launch with the system is a user decision, so this
 * service never turns it on by itself; the UI owns the toggle.
 */
export class AutostartService extends Service {
  private bridge?: ShellStdioBridge

  constructor(ctx: Context) {
    super(ctx, "autostart")
  }

  attachShell(bridge: ShellStdioBridge): void {
    this.bridge = bridge
  }

  detachShell(): void {
    this.bridge = undefined
  }

  /**
   * Whether the OS registration exists right now.
   *
   * `false` covers "off", "no shell" AND "mobile" — the caller that wants the
   * state of a toggle cannot act differently on those, and one that needs to know
   * whether the capability exists at all asks `supported`.
   */
  async isEnabled(): Promise<boolean> {
    const api = this.bridge?.shell.autostart
    if (!api) return false
    try {
      return await api.isEnabled()
    } catch {
      return false
    }
  }

  /** Whether this platform has the capability at all. */
  get supported(): boolean {
    return this.bridge?.shell.autostart !== undefined
  }

  get attached(): boolean {
    return this.bridge !== undefined
  }

  /** Turn autostart on or off. A verdict, not a bool. */
  async setEnabled(enabled: boolean): Promise<AutostartVerdict> {
    // Distinguishing "no shell" from "mobile" matters: the first is a waiting
    // state that will resolve, the second never will, and a UI offering a toggle
    // needs to know which it is looking at.
    if (!this.bridge) return { status: "no-shell" }
    const api = this.bridge.shell.autostart
    if (!api) return { status: "unsupported" }
    try {
      const verdict = await api.setEnabled(enabled)
      return verdict.ok ? { status: "ok" } : { status: "error", error: verdict.error ?? "refused" }
    } catch (error) {
      return { status: "error", error: describe(error) }
    }
  }
}
