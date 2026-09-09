// Pure logic for the dev-watch panel (face side, dev only).
//
// Split out of devWatchPanel.tsx so the event normalization, log capacity
// policy, duplicate suppression, idle-hint wording and reload-toast mapping can
// be unit-tested with bun test without a React/DOM harness. This module must
// stay free of React/Tauri imports.

/**
 * Wire shape relayed by host/src/stdio.ts `DevWatchPush`.
 *
 * PINNED SOURCE: `host/src/stdio.ts` (`DevWatchPush`), produced by
 * `host/src/index.ts#toDevWatchPush` and mirrored by the Rust shell's
 * `shell_sys.rs#devWatchEvent`. Keep this copy field-for-field identical.
 *
 * Deliberately duplicated rather than imported: a type-only import of
 * `host/src/stdio.ts` drags the whole host module graph (Bun globals, cordis
 * types) into the frontend `tsc` program and breaks `bunx tsc --noEmit`.
 * Verified 2026-09 — do not re-add the import.
 */
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

export const MAX_LOG = 8

/**
 * Identical consecutive pushes (chokidar fires duplicate `change`/`reload`
 * pairs on Windows, and the host may relay the same reload twice) are collapsed
 * inside this window so one save yields one log row and one toast.
 *
 * Kept well below a human save cadence: a 1.5s window also swallowed a genuine
 * second save of the same content. The host already debounces file events
 * (250ms) before they reach this panel, so the duplicate burst to absorb is
 * short.
 */
export const DEV_WATCH_DEDUP_WINDOW_MS = 400

export function summarize(push: DevWatchPush): string {
  if (push.entryId) return push.entryId
  if (push.path) return push.path
  if (push.entries && push.entries.length > 0) return `${push.entries.length} entry(ies)`
  return ""
}

export type ToastLevel = "success" | "warning" | "error" | "info"

export type ToastPlan = {
  level: ToastLevel
  title: string
  description?: string
}

/**
 * Map one received push to the toast that should be shown, or null when the
 * event is noise that belongs in the panel log only. Reload outcomes follow
 * the host ReloadStatus vocabulary (`host/src/dev-reload.ts#ReloadStatus`).
 */
export function toastPlan(push: DevWatchPush): ToastPlan | null {
  if (push.type === "reload") return reloadToastPlan(push)
  if (push.type === "config-error" || push.type === "watcher-error") {
    return { level: "error", title: `Dev watch: ${push.type}`, description: push.error }
  }
  if (push.type === "started") return { level: "info", title: "Dev watch 已启动" }
  return null
}

function reloadToastPlan(push: DevWatchPush): ToastPlan {
  const target = push.entryId ? `${push.entryId}` : "entry"
  switch (push.status) {
    case "reloaded":
      return { level: "success", title: `Dev reload: ${target} 已重载` }
    case "kept-old":
      return {
        level: "warning",
        title: `Dev reload: ${target} 保留旧模块`,
        description: push.error ?? "导入阶段失败，旧模块未受影响",
      }
    case "restored-old":
      return {
        level: "warning",
        title: `Dev reload: ${target} 已回滚旧模块`,
        description: push.error,
      }
    case "restart-required":
      return {
        level: "error",
        title: `Dev reload: ${target} 需要重启宿主`,
        description: push.error ?? "模块无法就地恢复，请重启宿主后重试",
      }
    case "timeout":
      return { level: "error", title: `Dev reload: ${target} 超时`, description: push.error }
    case "skipped":
      // Real host status (`host/src/dev-reload.ts:29`, produced at `:102` and
      // `host/src/dev-watch.ts:315`): nothing to reload. Informational, and it
      // must not fall through to the generic branch printing a raw token.
      return {
        level: "info",
        title: `Dev reload: ${target} 已在队列中跳过`,
        description: push.error ?? "该条目无活动 fiber 或已被禁用，无需重载",
      }
    default:
      return push.error
        ? { level: "error", title: `Dev reload failed: ${target}`, description: push.error }
        : { level: "info", title: `Dev reload: ${target}`, description: push.status }
  }
}

// ── duplicate suppression (pure, window is a parameter) ────────────────────

/** Stable identity of a push: same type + payload ⇒ same signature. */
export function pushSignature(push: DevWatchPush): string {
  return JSON.stringify([
    push.type,
    push.entryId ?? null,
    push.path ?? null,
    push.status ?? null,
    push.error ?? null,
    push.entries ? [...push.entries] : null,
  ])
}

export type PushDedupState = { signature: string; at: number }

export type PushDedupResult = { duplicate: boolean; state: PushDedupState }

/**
 * Collapse an identical push that repeats within `windowMs` of the previous
 * accepted push. The returned state keeps the *first* timestamp while a burst
 * is being suppressed, so a steady stream cannot extend the window forever and
 * a later distinct event always starts a fresh window.
 */
export function dedupPush(
  prev: PushDedupState | null,
  push: DevWatchPush,
  now: number,
  windowMs: number = DEV_WATCH_DEDUP_WINDOW_MS,
): PushDedupResult {
  const signature = pushSignature(push)
  const elapsed = prev ? now - prev.at : Number.NaN
  if (prev && prev.signature === signature && windowMs > 0 && elapsed >= 0 && elapsed < windowMs) {
    return { duplicate: true, state: prev }
  }
  return { duplicate: false, state: { signature, at: now } }
}

// ── idle hint (pure) ───────────────────────────────────────────────────────

/** Whether the Tauri `dev-watch` listener has been attached yet. */
export type DevWatchListenState = "pending" | "ok" | "failed"

export type DevWatchPanelState = {
  everReceived: boolean
  listen: DevWatchListenState
  listenError?: string
}

/**
 * Wording for the empty-log hint.
 *
 * `started` is emitted once at host boot (`host/src/dev-watch.ts:180`), so
 * after an F5 the panel legitimately has received nothing even though the
 * watcher is running: never claim "宿主需以 VRCXK_DEV_WATCH=1 启动" as a fact.
 */
export function idleHint(state: DevWatchPanelState): string {
  if (state.listen === "pending") return "正在连接 dev-watch 事件流…"
  if (state.listen === "failed") {
    return `无法监听 dev-watch 事件：${state.listenError ?? "未知错误"}（面板仍可用，可清空或重试）`
  }
  if (state.everReceived) return "等待 dev-watch 事件…"
  return "本页面尚未收到 dev-watch 事件（刚刷新页面属正常：宿主只在启动时推送一次 started）。若宿主未以 VRCXK_DEV_WATCH=1 启动，则不会有任何推送。"
}

/** Prepend a received push, keep at most `max` entries. */
export function appendLog(prev: DevWatchLog[], entry: DevWatchLog, max: number = MAX_LOG): DevWatchLog[] {
  return [entry, ...prev].slice(0, max)
}
