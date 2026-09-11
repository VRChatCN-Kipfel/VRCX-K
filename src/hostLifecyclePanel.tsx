// Live host-lifecycle readout (face side, M1).
//
// The Rust shell owns the host process. It exposes:
//   - command `get_host_lifecycle` → `{ snapshot: HostSnapshot }`
//   - event   `host-lifecycle`     → `HostSnapshot` envelope, emitted whenever
//                                    the snapshot actually changes
//
// This panel renders that state (phase/desired/generation/attempt/pid/port/
// nextRetryMs/lastError) so a developer can see backoff/failure without
// digging through shell logs. It degrades gracefully: an older shell without
// the command (or a non-Tauri webview) shows an explanatory line instead of
// throwing.
//
// Subscription discipline follows devWatchPanel.tsx: one listener, guarded by
// `cancelled` + `unlisten` so React 19 StrictMode double-invoke neither
// double-subscribes nor leaks the listener.

import { useEffect, useState } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  formatHostSnapshot,
  hostLifecycleSummary,
  initialHostLifecycleView,
  reduceHostLifecycle,
  type HostLifecycleAction,
  type HostLifecycleView,
} from "./hostLifecycle"

export function HostLifecyclePanel() {
  const [view, setView] = useState<HostLifecycleView>(initialHostLifecycleView)

  useEffect(() => {
    const apply = (action: HostLifecycleAction) => {
      setView((prev) => reduceHostLifecycle(prev, action))
    }

    if (!isTauri()) {
      // A plain Vite browser session has no Tauri IPC at all: never call it.
      apply({ kind: "unsupported", reason: "非 Tauri 运行时，无 host-lifecycle IPC" })
      return
    }

    let cancelled = false
    let unlisten: UnlistenFn | undefined
    const applyIfLive = (action: HostLifecycleAction) => {
      if (!cancelled) apply(action)
    }

    // Register the listener BEFORE reading a seed. Tauri neither buffers nor
    // replays events, so anything emitted before this registration is gone for
    // good. Reading the seed only after `listen` resolves makes it reflect the
    // current state instead of a spawn-time snapshot that may never be
    // corrected (the fingerprint feed re-emits only on change) — the case where
    // the `ready` event is dropped while the mount response still says
    // `starting`. `reduceHostLifecycle` ignores a response once an event has
    // made the view live, so an event that lands in between still wins.
    const readSeed = () =>
      invoke<unknown>("get_host_lifecycle")
        .then((raw) => applyIfLive({ kind: "response", raw }))
        .catch((err: unknown) => {
          // Missing command on an older shell → unsupported, never a crash.
          applyIfLive({ kind: "unsupported", reason: `get_host_lifecycle 不可用：${String(err)}` })
        })

    void listen<unknown>("host-lifecycle", (event) => applyIfLive({ kind: "event", raw: event.payload }))
      .then((fn) => {
        if (cancelled) {
          fn()
          return
        }
        unlisten = fn
        return readSeed()
      })
      .catch((err: unknown) => {
        console.error("[host-lifecycle] listen failed", err)
        // The listener failed, but the command may still work: read the seed
        // first so the `error` state keeps the last known snapshot (its reducer
        // branch preserves `view.snapshot`) instead of showing nothing.
        return readSeed().then(() =>
          applyIfLive({ kind: "error", message: `无法监听 host-lifecycle：${String(err)}` }),
        )
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const summary = hostLifecycleSummary(view)
  const fields = view.snapshot ? formatHostSnapshot(view.snapshot) : []
  const dotClass =
    view.status === "live"
      ? "hostlife-dot hostlife-dot-on"
      : view.status === "pending"
        ? "hostlife-dot"
        : "hostlife-dot hostlife-dot-bad"

  return (
    <aside className="hostlife" aria-label="宿主生命周期">
      <header className="hostlife-head">
        <span className="hostlife-title">宿主</span>
        <span className={dotClass} role="img" aria-label={summary} title={summary} />
        <span className="hostlife-state">{summary}</span>
      </header>
      {fields.length > 0 ? (
        <div className="hostlife-grid">
          {fields.map((field) => (
            <div className="hostlife-row" key={field.key}>
              <span className="hostlife-key">{field.label}</span>
              <span className="hostlife-val" title={field.value}>
                {field.value}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="hostlife-idle">{view.notice ?? "等待宿主生命周期快照…"}</p>
      )}
    </aside>
  )
}
