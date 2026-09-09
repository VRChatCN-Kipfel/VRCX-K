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

/** Wire shape relayed by host/src/stdio.ts `DevWatchPush`. */
export type DevWatchPush = {
  type: string
  entryId?: string
  path?: string
  status?: string
  error?: string
  entries?: string[]
}

/** One received event kept in the panel log. */
export type DevWatchLog = {
  seq: number
  at: Date
  push: DevWatchPush
}

const MAX_LOG = 8

function summarize(push: DevWatchPush): string {
  if (push.entryId) return push.entryId
  if (push.path) return push.path
  if (push.entries && push.entries.length > 0) return `${push.entries.length} entry(ies)`
  return ""
}

/** Reload result wording per host ReloadStatus. */
function reloadToast(status: string | undefined, push: DevWatchPush) {
  const target = push.entryId ? `${push.entryId}` : "entry"
  switch (status) {
    case "reloaded":
      toast.success(`Dev reload: ${target} 已重载`)
      break
    case "kept-old":
      toast.warning(`Dev reload: ${target} 保留旧模块（导入失败）`, {
        description: push.error,
      })
      break
    case "restored-old":
      toast.warning(`Dev reload: ${target} 已回滚旧模块`, { description: push.error })
      break
    case "restart-required":
      toast.error(`Dev reload: ${target} 需要重启宿主`, {
        description: push.error ?? "模块无法就地恢复，请重启宿主后重试",
      })
      break
    case "timeout":
      toast.error(`Dev reload: ${target} 超时`, { description: push.error })
      break
    default:
      // reload with an unexpected/missing status still deserves a line.
      toast(push.error ? `Dev reload failed: ${target}` : `Dev reload: ${target}`, {
        description: push.error,
      })
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
      setLogs((prev) => [{ seq, at: new Date(), push }, ...prev].slice(0, MAX_LOG))

      if (push.type === "reload") {
        reloadToast(push.status, push)
      } else if (push.type === "config-error" || push.type === "watcher-error") {
        toast.error(`Dev watch: ${push.type}`, { description: push.error })
      } else if (push.type === "started") {
        toast("Dev watch 已启动")
      }
      // change/unowned/ambiguous/config-refreshed/closed stay in the panel
      // log only — no toast storm while hot-reloading files.
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
