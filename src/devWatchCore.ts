// Pure logic for the dev-watch panel (face side, dev only).
//
// Split out of devWatchPanel.tsx so the event normalization, log capacity
// policy and reload-toast mapping can be unit-tested with bun test without a
// React/DOM harness. This module must stay free of React/Tauri imports.

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

export const MAX_LOG = 8

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
 * the host ReloadStatus vocabulary.
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
    default:
      return push.error
        ? { level: "error", title: `Dev reload failed: ${target}`, description: push.error }
        : { level: "info", title: `Dev reload: ${target}`, description: push.status }
  }
}

/** Prepend a received push, keep at most `max` entries. */
export function appendLog(prev: DevWatchLog[], entry: DevWatchLog, max: number = MAX_LOG): DevWatchLog[] {
  return [entry, ...prev].slice(0, max)
}
