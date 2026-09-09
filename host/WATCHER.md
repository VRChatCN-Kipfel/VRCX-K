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

## DevWatch（issue #11 装配层，P1–P4 已实现）

`host/src/dev-watch.ts` 的 `DevWatch` 把 HostWatcher 接到真实 Cordis include 树上：

- **装配**：Include 以 loader-tree builtin entry（`cordis:include`）挂载（`host/src/index.ts`）；`DevWatch` 遍历其 `subtree.entries()` 建立 entryId → (Entry, roots) 索引。roots = 显式 `VRCXK_DEV_WATCH_MAP`（entryId → 路径数组；内联 JSON 或 JSON 文件路径）+ 入口文件本身。
- **dev gate**：仅 `VRCXK_DEV_WATCH=1` 启用；生产默认不监听。
- **文件事件**：chokidar 事件经 trailing debounce（默认 250ms；Windows atomic-rename 双事件折叠为一次保存）后做 canonical 路径 → entryId 匹配；入口文件精确命中、root 最长前缀；ambiguous/unowned 仅诊断。`.tmp`/`.#*`/`*.swp`/`~$*` 与 `node_modules`/`.git`/`dist` 一律忽略。
- **per-entry reload**（`host/src/dev-reload.ts`）：每 entry 一条串行队列 + dirty 合并（无并发 dispose）。事务 = 快照缓存 → 清 entry 文件 + roots 内 `require.cache` 键（键为绝对路径）→ 经 owning tree import 重取模块 → 抑制 Loader unload==disable 写回后 dispose 旧 fiber → 在 entry ctx 重建 fiber 并回填。**绝不**清宿主/Cordis/node_modules 缓存；单次超时 10s（低于宿主 25s stop hard cap）。
- **失败分层**：import/语法/非 plugin → 强回滚（恢复缓存快照，旧 fiber 未动，`kept-old`）；apply/init/dispose 失败 → 尽力用旧模块重建（`restored-old`），仍失败 → `restart-required`。
- **restart-required**：仅经 `onRestartRequired` 上报，watcher 从不自行退出。`host/src/index.ts` 在 shell 模式（`VRCXK_SHELL=1`）复用既有 exit-51 路径请求整宿主重启，带每 entry 60s 限流 + 启动 10s 宽限（#7 壳另有稳定窗口风暴 cap）。
- **include refresh**：cordis.yml 变化走独立 debounce（`debounceMs × 2`）→ `include.refresh()`（Include 1.0.5 内置内容消重，宿主自写 temp+rename 不触发回环）→ 成功后重建 bindings。YAML 非法/缺失：保留当前树，等下个 change 重试。

> 版本记录：issue #11 P1–P4 实现 Fiber reload、失败恢复与 include refresh；整宿主重启仍只通过 `onRestartRequired` + 既有 exit-51 路径表达；未复制 #7 类型、未创建 supervisor/app lifecycle。
