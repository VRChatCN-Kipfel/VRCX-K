# HostWatcher 生命周期与错误语义

`HostWatcher` 是 Chokidar 4.0.3 的薄适配层，不负责 Cordis Fiber、Entry replacement 或 Include refresh。调用方拥有 `HostWatcher` 实例，并应在宿主停止阶段 `await watcher.close()`（`dispose()` 是同义别名）。

## 事件与错误

- `started`：底层 Chokidar 完成初始扫描。`ignoreInitial: true`，因此启动期间不会把已有文件当作 reload。
- `change`：`add`、`change`、`unlink` 经短 debounce 后进行 canonical path → Entry mapping。精确入口、最长显式 root、shared ambiguous/unowned 规则由 `watch-path.ts` 定义。
- `ambiguous` / `unowned`：仅发诊断事件，不调用 `onChange`；调用方可将其转换为 canonical lifecycle DTO 或 `restart-required`。
- `error`：包含底层 Chokidar error，或 `onChange` reject/throw。callback 错误被捕获，不会终止 watcher，也不自动执行 Fiber reload 或整宿主重启。
- `closed`：底层 `FSWatcher.close()` 完成且当前 flush 已结算后发出；同一实例最多一次。

## 资源语义

- `close()` 设置关闭闸门，取消 debounce timer，丢弃尚未 flush 的路径，不接收新事件。
- 若一个 flush 正在执行，`close()` 等待其完成；已经进入 `onChange` 的调用不会被强制取消。
- 并发 `close()` / `dispose()` 共享同一 Promise，且幂等；重复调用不会重复发 `closed`。
- `getWatched()` 在关闭后返回 `{}`。测试应验证没有孤儿文件监听器、定时器或 callback。
- `setBindings()` 仅替换 mapping 索引，不改变底层 watched roots；Include refresh 后由更高层决定是否重建 watcher。

## 边界

本轮不定义 `app.restart.graceful`、HostLifecycle 类型、Fiber reload/recover 事务或 Include refresh。对接这些能力时只使用 #7 提供的版本化 JSON Schema DTO/Facade；不要在 watcher 中复制生命周期类型。
