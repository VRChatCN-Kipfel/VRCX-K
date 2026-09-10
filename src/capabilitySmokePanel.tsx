// Capability smoke panel (face side, dev only) — issue #6's last task.
//
// One place that exercises the five system capabilities (tray / single-instance
// / shortcut / notification / dialog) so the manual acceptance run is a
// checklist instead of ad-hoc poking. Every button calls the Rust
// `capability_smoke` command and shows the real verdict; the steps that a human
// must observe (tray icon, toast, native dialog, window focus after a second
// launch) are printed next to the button instead of being pretended away.
//
// Not a production feature: `App.tsx` mounts it only outside release builds, and
// it additionally requires the Tauri runtime (a bare Vite session has no IPC).
// All logic that can be decided without a runtime lives in
// `capabilitySmokeCore.ts` and is unit-tested there.
//
// Subscription discipline follows `devWatchPanel.tsx`: one listener, guarded by
// `cancelled` + `unlisten`, so React 19 StrictMode double-invoke neither
// double-subscribes nor leaks the listener.

import { useEffect, useReducer, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  CAPABILITIES,
  CAPABILITY_LABEL,
  SMOKE_BUTTONS,
  describeValue,
  formatPress,
  formatRedirect,
  initialSmokeView,
  parseRedirectEvent,
  parseShortcutPress,
  parseSmokeReport,
  reduceSmoke,
  registeredAccelerator,
  shortcutHint,
  singleInstanceHint,
  summarizeCapability,
  type RedirectEvent,
  type ShortcutPress,
  type SmokeButton,
} from "./capabilitySmokeCore"

export function CapabilitySmokePanel() {
  const [view, dispatch] = useReducer(reduceSmoke, undefined, initialSmokeView)
  const [busy, setBusy] = useState<string | null>(null)
  const [listenError, setListenError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let unlistenPress: UnlistenFn | undefined
    let unlistenRedirect: UnlistenFn | undefined
    let cancelled = false

    void listen<ShortcutPress>("shortcut-pressed", (event) => {
      const press = parseShortcutPress(event.payload)
      if (!press) {
        console.error("[smoke] malformed shortcut-pressed payload", event.payload)
        return
      }
      dispatch({ kind: "press", press })
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlistenPress = fn
      })
      .catch((err: unknown) => {
        console.error("[smoke] shortcut-pressed listen failed", err)
        if (!cancelled) setListenError(String(err))
      })

    // A second launch is redirected here by the single-instance plugin. The
    // event is the only proof it arrived: the second process exits by design, so
    // an empty Task Manager proves nothing either way.
    void listen<RedirectEvent>("single-instance-redirect", (event) => {
      const redirect = parseRedirectEvent(event.payload)
      if (!redirect) {
        console.error("[smoke] malformed single-instance-redirect payload", event.payload)
        return
      }
      dispatch({ kind: "redirect", event: redirect })
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlistenRedirect = fn
      })
      .catch((err: unknown) => {
        console.error("[smoke] single-instance-redirect listen failed", err)
        if (!cancelled) setListenError(String(err))
      })

    return () => {
      cancelled = true
      unlistenPress?.()
      unlistenRedirect?.()
    }
  }, [])

  if (!isTauri()) {
    return (
      <section className="smoke">
        <h2>系统能力 smoke</h2>
        <p className="smoke-hint">非 Tauri 运行时：无能力 IPC，此面板不触发任何系统调用。</p>
      </section>
    )
  }

  const run = async (button: SmokeButton) => {
    setBusy(button.id)
    try {
      const raw = await invoke<unknown>("capability_smoke", { action: button.request })
      const parsed = parseSmokeReport(raw)
      if (!parsed) {
        // A reply we cannot read is reported against the capability that was
        // asked for, never rendered as a verdict (and never filed under a
        // different capability's row).
        console.error("[smoke] malformed report", raw)
        dispatch({
          kind: "report",
          report: {
            capability: button.capability,
            ok: false,
            detail: `无法解析的返回值：${JSON.stringify(raw)}`,
          },
        })
        return
      }
      dispatch({ kind: "report", report: parsed })
      // The shell canonicalises the chord; remember ITS spelling, and only for
      // the button that actually registered/unregistered.
      if (button.id === "shortcut.register") {
        dispatch({ kind: "bound", accelerator: registeredAccelerator(parsed) })
      } else if (button.id === "shortcut.unregister" && parsed.ok) {
        dispatch({ kind: "bound", accelerator: null })
      }
    } catch (err: unknown) {
      console.error("[smoke] capability_smoke failed", err)
      dispatch({
        kind: "report",
        report: { capability: button.capability, ok: false, detail: `调用失败：${String(err)}` },
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="smoke">
      <header className="smoke-head">
        <h2>系统能力 smoke（dev）</h2>
        <button type="button" onClick={() => dispatch({ kind: "reset" })}>
          清空
        </button>
      </header>
      {listenError ? <p className="smoke-hint">按键事件订阅失败：{listenError}</p> : null}

      {CAPABILITIES.map((capability) => {
        const result = view.results[capability]
        const buttons = SMOKE_BUTTONS.filter((button) => button.capability === capability)
        return (
          <div className="smoke-row" key={capability}>
            <h3>{CAPABILITY_LABEL[capability]}</h3>
            <div className="smoke-actions">
              {buttons.map((button) => (
                <button
                  key={button.id}
                  type="button"
                  disabled={busy !== null}
                  title={button.manual}
                  onClick={() => void run(button)}
                >
                  {busy === button.id ? "运行中…" : button.label}
                </button>
              ))}
            </div>
            <p className="smoke-status">{summarizeCapability(view, capability)}</p>
            {result && describeValue(result) ? (
              <p className="smoke-value">{describeValue(result)}</p>
            ) : null}
            {/* A checklist, not a mystery button row: every button states the
                outcome a human has to confirm by eye. */}
            <ul className="smoke-expect">
              {buttons.map((button) => (
                <li key={button.id}>
                  <strong>{button.label}</strong>：{button.manual}
                </li>
              ))}
            </ul>
            {capability === "shortcut" ? (
              <>
                <p className="smoke-hint">{shortcutHint(view)}</p>
                <ul className="smoke-presses">
                  {view.presses.length === 0 ? (
                    <li>尚未收到按键</li>
                  ) : (
                    [...view.presses].reverse().map((entry) => (
                      <li key={entry.seq}>{formatPress(entry)}</li>
                    ))
                  )}
                </ul>
              </>
            ) : null}
            {capability === "single-instance" ? (
              <>
                <p className="smoke-hint">{singleInstanceHint(view)}</p>
                <ul className="smoke-presses">
                  {view.redirects.length === 0 ? (
                    <li>尚未收到重定向</li>
                  ) : (
                    view.redirects
                      .map((event, index) => (
                        <li key={index}>{formatRedirect(event, index + 1)}</li>
                      ))
                      .reverse()
                  )}
                </ul>
              </>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
