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
// host, which is spelled out in the idle hint below.

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  appendLog,
  MAX_LOG,
  summarize,
  toastPlan,
  type DevWatchLog,
  type DevWatchPush,
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
  const seqRef = useRef(0)

  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let cancelled = false

    const onPush = (push: DevWatchPush) => {
      if (cancelled) return
      const seq = ++seqRef.current
      setEverReceived(true)
      setLogs((prev) => appendLog(prev, { seq, at: new Date(), push }, MAX_LOG))
      showToast(push)
    }

    void listen<DevWatchPush>("dev-watch", (event) => onPush(event.payload)).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const last = logs[0]?.push

  return (
    <aside className="devwatch" aria-label="Dev watch">
      <header className="devwatch-head">
        <span className="devwatch-title">Dev Watch</span>
        <span className={everReceived ? "devwatch-dot devwatch-dot-on" : "devwatch-dot"} title={everReceived ? "已收到 dev-watch 事件" : "尚未收到 dev-watch 事件"} />
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
        <p className="devwatch-idle">
          {everReceived
            ? "等待 dev-watch 事件…"
            : "未收到 dev-watch 事件：宿主需以 VRCXK_DEV_WATCH=1 启动（重启宿主后生效）"}
        </p>
      ) : (
        <ul className="devwatch-log">
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
