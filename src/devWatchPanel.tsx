// Dev-watch monitor (face side, dev only).
//
// The host relays dev-watch events (issue #11) to the shell through
// `shell.devWatchEvent`, which the Rust shell re-emits as a Tauri
// `dev-watch` event for the webview. This panel consumes that stream so a
// developer can see plugin reload results while running `cargo tauri dev`
// with `VRCXK_DEV_WATCH=1` set for the host process.
//
// This is NOT a production feature: `App.tsx` renders the panel only when
// `import.meta.env.DEV && isTauri()`, so release builds never mount it and
// never attach the Tauri event listener.
//
// Gate UX: the watcher is enabled by the *host* environment variable
// `VRCXK_DEV_WATCH=1`, read once at host startup. There is deliberately no
// runtime toggle on this side — flipping the gate requires restarting the
// host. Because the host emits `started` exactly once at boot
// (`host/src/dev-watch.ts:180`), an empty log after an F5 does NOT mean the
// watcher is off: the hint below distinguishes "this page received nothing"
// from "the host is not pushing at all".

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  appendLog,
  dedupPush,
  DEV_WATCH_DEDUP_WINDOW_MS,
  idleHint,
  MAX_LOG,
  summarize,
  toastPlan,
  type DevWatchListenState,
  type DevWatchLog,
  type DevWatchPush,
  type PushDedupState,
} from "./devWatchCore"

function showToast(push: DevWatchPush) {
  const plan = toastPlan(push)
  if (!plan) return
  switch (plan.level) {
    case "success":
      toast.success(plan.title, { description: plan.description })
      break
    case "warning":
      toast.warning(plan.title, { description: plan.description })
      break
    case "error":
      toast.error(plan.title, { description: plan.description })
      break
    case "info":
      toast(plan.title, { description: plan.description })
      break
  }
}

export function DevWatchPanel() {
  const [logs, setLogs] = useState<DevWatchLog[]>([])
  const [everReceived, setEverReceived] = useState(false)
  const [listenState, setListenState] = useState<DevWatchListenState>("pending")
  const [listenError, setListenError] = useState<string | undefined>(undefined)
  const seqRef = useRef(0)
  const dedupRef = useRef<PushDedupState | null>(null)

  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let cancelled = false

    const onPush = (push: DevWatchPush) => {
      if (cancelled) return
      // Chokidar duplicates the same change/reload on Windows; suppress the
      // repeat instead of adding a second log row and a second toast.
      const { duplicate, state } = dedupPush(
        dedupRef.current,
        push,
        Date.now(),
        DEV_WATCH_DEDUP_WINDOW_MS,
      )
      dedupRef.current = state
      if (duplicate) return
      const seq = ++seqRef.current
      setEverReceived(true)
      setLogs((prev) => appendLog(prev, { seq, at: new Date(), push }, MAX_LOG))
      showToast(push)
    }

    void listen<DevWatchPush>("dev-watch", (event) => onPush(event.payload))
      .then((fn) => {
        if (cancelled) fn()
        else {
          unlisten = fn
          setListenState("ok")
        }
      })
      .catch((err: unknown) => {
        // Never leave an unhandled rejection: report it and keep the panel usable.
        console.error("[dev-watch] listen failed", err)
        if (cancelled) return
        setListenState("failed")
        setListenError(String(err))
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const last = logs[0]?.push
  const dotLabel =
    listenState === "failed"
      ? "dev-watch 事件监听失败"
      : everReceived
        ? "已收到 dev-watch 事件"
        : "尚未收到 dev-watch 事件"

  return (
    <aside className="devwatch" aria-label="Dev watch">
      <header className="devwatch-head">
        <span className="devwatch-title">Dev Watch</span>
        <span
          className={
            listenState === "failed"
              ? "devwatch-dot devwatch-dot-bad"
              : everReceived
                ? "devwatch-dot devwatch-dot-on"
                : "devwatch-dot"
          }
          role="img"
          aria-label={dotLabel}
          title={dotLabel}
        />
        {logs.length > 0 ? (
          <button
            type="button"
            className="devwatch-clear"
            onClick={() => setLogs([])}
            aria-label="Clear dev watch log"
          >
            清空
          </button>
        ) : null}
      </header>

      {logs.length === 0 ? (
        <p className="devwatch-idle">{idleHint({ everReceived, listen: listenState, listenError })}</p>
      ) : (
        <ul className="devwatch-log" aria-live="polite" aria-relevant="additions">
          {logs.map(({ seq, at, push }) => (
            <li key={seq} className={`devwatch-item devwatch-type-${push.type.replace(/[^a-z0-9-]/g, "")}`}>
              <span className="devwatch-kind">{push.type}</span>
              <span className="devwatch-time">
                {at.toLocaleTimeString([], { hour12: false })}
              </span>
              {push.status ? <span className="devwatch-status">{push.status}</span> : null}
              <span className="devwatch-summary" title={push.error ?? undefined}>
                {summarize(push)}
                {push.error ? " — " + push.error : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {last ? <p className="devwatch-last">最近：{last.type}{last.entryId ? ` · ${last.entryId}` : ""}</p> : null}
    </aside>
  )
}
