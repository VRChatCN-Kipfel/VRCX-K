# VRCX-K 项目开发约定

> 本文件对 VRCX-K 仓库生效。架构方案全文见 [`docs/architecture-proposal.md`](docs/architecture-proposal.md)（v4.2，评审通过）。

## 项目结构（三层：大脑-双手-脸）

```
VRCX-K/
├── src-tauri/     ← 双手 · Tauri 2 / Rust 壳（系统代理：托盘/通知/快捷键/对话框）
│   ├── Cargo.toml        Rust 依赖（cargo workspace 成员）
│   └── tauri.conf.json   窗口/打包配置
├── src/           ← 脸 · React UI (Vite 19)
├── host/          ← 大脑 · Cordis (bun) 宿主（业务/插件/服务）
├── docs/          ← architecture-proposal.md (v4.2) + ROADMAP.md（概览）+ poc-m0.md（M0 PoC 报告）+ adr-plugin-layout.md（目录布局 ADR）+ cordis-runtime-findings.md（Cordis 运行时实测）+ probes/（可复跑探针）+ vrcxk-arch-final.html（架构图）
├── Cargo.toml     ← cargo workspace 根（成员 src-tauri）
├── package.json   ← bun workspace 根（含 host）
└── runtime-research.md / ecosystem-research.md（支撑调研）
```

**通信（kkrpc 三通道，均为双向）**：
- `src` ⇄ `host`：`kkrpc/ws`（业务 RPC + 事件推送）
- `host` ⇄ `src-tauri`：`kkrpc/stdio` 双向桥（系统能力 ⇄ 业务/系统事件）
- `src` ⇄ `src-tauri`：Tauri IPC

## 工具链（全部在根目录执行）

### Rust / Tauri 侧（cargo workspace）
| 命令 | 作用 |
|---|---|
| `cargo check` | 只查编译错误（快） |
| `cargo build` | 编译 debug |
| `cargo test` | Rust 测试 |
| `cargo clippy` | lint |
| `cargo fmt` | 格式化 |
| `cargo tauri dev` | **完整开发**：自动起前端 vite + 编译 Rust 壳 + 弹窗口 |
| `cargo tauri build` | **完整打包**：前端 build → Rust release → 安装包（exe/msi） |

> `cargo tauri dev/build` 会自动调 `bun run build`（前端），是"壳+前端"的一条指令入口。注意：**尚不含 host（Cordis）**——host 接入链路是 M1 的事（M0 只验机制，未接壳）。

### JS / Bun 侧
| 命令 | 作用 |
|---|---|
| `bun install` | 装全部依赖（前端 + host） |
| `bun run dev` | 只起前端 vite dev server |
| `bun run build` | 只编前端 → dist/ |
| `bun run dev:host` | 起 Cordis 宿主（host/） |
| `bun run build:host` | 编译 host |

### 环境要求
- Rust: stable-x86_64-pc-windows-msvc（rustc 1.97+）
- WebView2（Windows 自带，Tauri 依赖）
- bun 1.4+
- cargo tauri-cli（已装：cargo tauri 2.11.4 / @tauri-apps/cli ^2）

## Git 约定
- **本机 `commit.gpgsign=true`**：git 提交可能卡在 gpg 签名等待。若长时间无响应，用 `git -c commit.gpgsign=false commit ...` 临时禁用签名提交（见全局规则）。
- 本地工具状态目录 `.agent-teams/` `.dsh/` `.mnemon/` `.opencode/` 通过 `.git/info/exclude` 忽略（**不提交、每台机器各自有**），勿加入 .gitignore（那会随仓库共享）。
- `.gitignore` 只放通用忽略（node_modules/dist//target/ 等）。

## 临时工作区（agent 专用）
- `.temp/`（已 gitignore，**不提交**）是 agent 的临时工作区：探针脚本、临时构建产物、中间实验都放这里，做完即弃，可随时整目录删除。仓库内任何**不打算进 git** 的实验性文件优先放 `.temp/`，别散落在根目录。
- 区分：`.temp/` 是仓库内临时区（随仓库存在但 gitignore）；`.agent-teams/` 等是每机工具状态（`.git/info/exclude`，各机器私有）。
- **要保留**的产物（报告/正式代码/文档）放正常位置（docs/、host/、src/…），不要留在 `.temp/` 里"假装提交"——临时区的东西一旦需要转正，就移出 `.temp/` 再提交。
- **转正触发点（2026-09 补，因曾踩坑）**：一旦某产物**被别人引用**——被 GitHub issue 引用、被 `docs/` 引用、或成为后续实现的依据——就**必须立刻移出 `.temp/`**。判断标准是"是否有第二份副本"：**`.temp/` 里的东西随时可能整目录删除，不能成为唯一副本**。探针若承担回归基线角色，应转正到 `docs/probes/` 或搬成 `host/tests/` 单测。

## 许可证红线（抄代码禁令）
- **严禁抄 `vrcx-0`（Map1en 系）的任何代码/结构/文件**——它是 **GPL** 协议，复制/改写/照搬其文件会污染本仓库。仅可观察其"产品方向可行性"（界面长什么样、功能有哪些），且须在文档记录为独立设计。我们与它同为"VRCX 能力 + Tauri 重写"是需求同源，架构是独立决策（见 docs/ROADMAP.md §参照）。
- 可安全借鉴（MIT/Apache）：**VRCX 官方**（MIT，功能复刻主参照，能力清单/数据模型思路）、**koishi/cordis**（MIT）、**kkrpc**（Apache-2.0）。
- 任何**GPL/AGPL 项目**的代码/文件一律不得进入本仓库（含引用/复制/改写其结构文件）；只允许行为/能力层面观察参照。
- **进程注入/读游戏内存/Unity 内 UI** 类能力是禁区（官方不背书，ToS 风险），agent 不得实现或建议实现。
- 本仓库自身许可证**待定**（倾向 MIT），决定后补 LICENSE；决定前按宽松许可方向管理借鉴边界。
- 详表见 `docs/ROADMAP.md` §参照与许可证卫生。

## 已知坑（Cordis 运行时，2026-09 实测；详见 docs/cordis-runtime-findings.md）

> 这些是**实测**结论（探针 `docs/probes/probe{,2,3,4,5,6,7}.ts` 可复跑），写在这里是因为它们会在写插件/服务时立刻咬人。

- **调用者归因只有 `Service` 子类有**：`ctx.provide(name, 普通对象)` 的方法内 `this` 就是那个对象本身，无 `symbols.caller`，**两个插件调用结果完全一致（无法区分）**。要归因必须 `extends Service`。
- **方法必须是类方法**：写成箭头函数属性会**静默**丢失归因（`caller: null`），不报错。命名空间的子对象也必须是 `Service` 实例，普通对象字面量同样丢。
- **`Service` 是 per-caller 实例化**：读 `ctx.svc` 每次返回不同对象，且其 **`this.ctx` 是调用者的 ctx，不是提供者的**——迁移既有服务必须审计这一点。
- **`inject` 是就绪门不是访问门**：未 inject 的插件照样能读服务；但注入未提供服务的插件会卡在 `PENDING`（`state 0`），provide 后才 `ACTIVE`。⇒ **服务必须"先 provide、后 attachShell"**（`host/src/index.ts` 的 tray/shortcut 即此模式）。
- **Entry 级 `inject` 不进 `ctx[Context.intercept]`**：fiber 构造（`cordis/lib/index.js:1370`）只吃插件自身 inject，Entry inject 由 loader 事后合并（`plugin-loader/lib/index.js:577-581`）且**只进 `fiber.inject`**。⇒ **manifest 不能靠 intercept 实施**。
- **正确的挂钩点是 `caller.fiber.entry`**：可读到 `entry.id` / `options.inject` / `options.config`。但 **`EntryOptions` 没有自定义字段位**（实测 own keys 仅 `id/name/inject/config` + `group/disabled`）⇒ manifest 走**宿主按 `entry.id` 建注册表**。裸 `ctx.plugin()` **无 entry**，需单独处理。
- **`Service[symbols.filter]` 不是访问门**（读取全程未被调用，且 Service 实例无 `emit`）⇒ 将来做硬拒绝也不能靠它。
- **上游 `access` 特性在任何已发布版本都不存在**：`cordis` latest `rc.10` 的 `Context` 与锁定的 `rc.9` **逐字相同**；`loader` latest `rc.7` 的 `EntryOptions` 亦无 `access`。**文档写的是 master，"升级即可得"不成立**。
- **Include（`@cordisjs/plugin-include`）**：`config.initial` **必须传已解析的数据结构**，传 yml 文本会被 `yaml.dump` 序列化成块字面量（语法合法、语义全错）；`write()` 经 `setTimeout(0)` 落盘且**不返回 promise** ⇒ 只读路径下失败是**未捕获异步异常，调用方 catch 不到**；`ctx.baseUrl` 被改写成 **yml 所在目录**；只读时**静默**置 `readonly`，直到要写才炸；`config.patches` 在内存生效但 **`write()` 会烘焙进文件**。
- **Windows junction 下 `import.meta.url` 会 realpath**：请求 `.../current/x.ts`，模块内 URL 是 `.../v1/x.ts`。⇒ 在插件路径中间插指针会引入**第二路径键空间**，而本仓库已为此维护两套机制（`watch-path.ts` 的 `canonicalExistingPath`、`dev-reload.ts` 的双键空间匹配）。junction 本身**无需管理员**。
- **探针开发自身的坑**：`fn.name = "x"` 是**只读属性**（TypeError）；`ctx.plugin()` **是异步的，不 await 则插件停在 `LOADING` 且输出全空不报错**；PowerShell 里 `node -e "...&..."` 的 `&` 是保留字，**复杂脚本写成 `.cjs` 文件**再跑；bun 的 stderr 会被 PowerShell 包成 `NativeCommandError` 而掩盖真实报错。
- **issue 编号会被 PR 占用**：不能由 `max(issues)` 推断下一个编号（本轮预算 #14、实际 M2 拿到 **#16**，因 #14/#15 是同日新 PR）。建 issue 前先查 `state=all` 的完整列表。

## 状态
- ✅ 架构方案定稿（docs/，5 轮评审通过）
- ✅ 项目骨架（三层结构 + cargo/bun workspace）
- ✅ **M0 PoC 完成**（报告 `docs/poc-m0.md`）：
  - bun 1.4.2 跑 Cordis(rc.9)+loader(rc.6)+include(1.0.5)：L1 启停/配置热 ✅、L2 窗口期降级（插件级重启，清 require.cache 同 URL 重求值）✅
  - **分发形态定案：宿主骨架 compile + 插件外置目录运行时加载**——compile 产物须**静态 import 宿主依赖**（含 include），插件用**绝对 file URL** 动态 import；宿主依赖勿经 `ctx.loader.create` 字符串名动态加载（compile 打不进 bundle）
  - kkrpc/ws 脸⇄脑双向链路 ✅（D-6 ws 通道实证；stdio 双向桥属 M1）
  - Node 24.12 备降 spot check ✅（同代码跑通；`--expose-internals` 下 loader.internal=true，L2 HMR 可用）
  - 上游复核：bun#35690 仍 DRAFT 未合、cordis#85 未合 → 窗口期维持，bun 主线 + 插件级重启
- ⏳ M1：壳与生命周期（Tauri sidecar spawn/supervise + 51 重启 + stdio 双向桥 + watcher 宿主骨架）
- 🏗 **M1 骨架已搭（2026-09，未提交）**：
  - `src-tauri/`：Cargo.toml 依赖齐（tauri `tray-icon` feature + single-instance 2.4.4 / global-shortcut 2.3.2 / dialog 2.7.3 / notification 2.4 / opener；Windows 专属 `tauri-winrt-notification` 0.8 已就位**但代码零引用**，待 F3）+ `src/{lib.rs 装配, tray.rs 托盘, notify.rs 通知薄层}`，cargo check ✅ 绿
  - `host/`：index.ts 结构化（lifecycle 雏形：退出码 51 常量、stdin "stop" 优雅停机、SIGTERM 处理、日志走 stderr 保 stdout 干净），启动冒烟 ✅
  - `src/`：加 `sonner` 2.0.8（应用内 toast，M1-5 接入）
- **通知分层定稿（2026-09，避免桌面锁死 + 移动对齐）**：L0 应用内弹窗=脸 React sonner（跨平台一致）；L1 原生系统通知=手 Rust 壳——官方 `tauri-plugin-notification` 2.4，**一包覆盖 win/linux/macos/android/ios**（插件元数据五端均 `level=full`；各端各用原生 API：Win=WinRT Toast、Linux=FreeDesktop.org D-Bus 规范、mac=`mac-usernotifications`、移动=插件代理原生）；L2/L3 远程推送+服务器=**独立架构立项，现在不写认知架构**（壳层只备 Tauri 跨平台插件，将来移动端不返工）
  - **⚠️ 易误读澄清（2026-09-11 取证）**：`tauri-winrt-notification` **不是**官方插件的替代方案，而是官方插件在 **Windows 的底层实现**——`tauri-plugin-notification 2.4` → `notify-rust 4.18` → `tauri-winrt-notification 0.7.3`（Cargo.lock 已证）。外壳注册与全部调用都走官方插件（`lib.rs` `.plugin(notification::init())`、`notify.rs::notify_simple`、`shell_sys.rs` 的 `shell.notify`）；`notify.rs::notify_windows_deep` 只是 `Ok(())` 空壳（`TODO(F3)`），**全仓库对 winrt crate 零 `use`**。
  - **F3 深度为何必须下沉**：桌面版官方插件 `desktop.rs::show()` **只转发 title/body/icon/sound 四个字段**，其余 builder 字段静默丢弃，且在 spawn 里丢掉 `NotificationHandle` → 桌面**结构上做不到**按钮/hero/进度条/点击回调。这些只有直连 winrt（`hero`/`add_button`/`progress`/`scenario`/`on_activated`）才有 → F3 真用到时再编码。
  - **版本策略（2026-09-11 用户决定）**：显式依赖**保持高版本 `0.8`**（开发期尽量往高版本靠），明知它与传递进来的 `0.7.3` 并存、多拉一棵 `windows 0.62` 树；**这是有意选择，不是遗漏**（若将来要减依赖，改成 `"0.7"` 可与其统一，能力不减）。
- **D1 探针结论（M1-4 关键，见 .temp/D1-findings.md）**：crates.io `kkrpc` Rust crate 0.6.1 是 **JSON-mode 协议**（`{method,args,type,version:"json"}`），与 npm kkrpc 2.1.0 的 **compact 协议**（`{t:"q",op,p,a}`）**不互通**（实测 Rust Client 全 HANG；手写 compact 帧全通）。GitHub main 的 interop/rust 已改 compact 但未发版 → **M1-4 自研 ~100 行 compact 端点**（官方 skill 算法），不依赖 crates.io crate，等官方发版后可换
- **E′ 探针（M1-4 桥形态定稿，.temp/d1probe/src/bin/e2.rs 全绿）**：Rust 不自研完整 Client，做"轻量喊话"——读循环分发 `q`(服务 host)+`cb`(回调表)，忽略 `r`；**Rust→host 即时信号=裸写 compact 命令帧**（host 事件驱动读循环立即执行，零轮询）；要返回值=带 kkrpc 回调参数→host `t:cb` 回推（实测 612µs）；回调值须 unwrap value-envelope（官方 interop skill 规则）
- 锁定版本组合：**bun 1.4.2 + cordis 4.0.0-rc.9 + loader 1.0.0-rc.6 + include 1.0.5 + kkrpc 2.1.0**（源态与 compile 态均已实证）
- 🔧 **M1 修复轮（2026-09，未提交；针对 `b60ebfe4` 复审）**：
  - **构建自愈**：`src-tauri/build.rs` 发现 `src-tauri/binaries/host-<triple>[.exe]` 缺失时自动执行 `bun run scripts/build-host.ts --target-triple <triple>`（Windows 下先直连 `bun`，失败再经 `cmd /C bun` 兼容 npm shim；可用 `VRCXK_BUN` 指定解释器）。**新克隆直接 `cargo check/test/tauri dev/build` 均可**，不再依赖手工先跑 `build:host`
  - **窗口语义**：`CloseRequested` → `prevent_close()` + `hide()`（托盘常驻），退出只走托盘 `app.quit.graceful/force`；`RunEvent::Exit` 兜底 `force_app_exit()`，子进程不再可能比壳活得久
  - **托盘契约闭环**：host→shell `shell.tray.setSnapshot(snapshot) -> {ok,revision,error?}`（经 `tray_schema::validate_wire_shape` + 域模型双重校验，core 组一律拒绝；`source` 改为**必填**，杜绝缺字段被默认成 core 的越权）；shell→host `tray.action({id,command,args})` 通知（`Peer::notify` 裸写 compact 帧，不阻塞 supervisor）
  - **托盘刷新与缓存**：`HostState` supervisor 在快照指纹（排除每 50ms 跳动的 `nextRetryMs`）变化时回调 → 重投影 `core.host.*` 的 enabled + emit `host-lifecycle`；托盘侧按合并快照指纹缓存，未变化不重建原生菜单
  - **托盘字段全部落地**：分组 `label` 渲染为原生子菜单；`confirm`/`danger` 走确认对话框；`args` 随 `tray.action` 下发（core/app 动作携带 args 会被模型拒绝）；radio 互斥改为**全快照级**
  - **host 监督**：ping 失败补 `reap_tree()`（此前唯一漏掉回收的失败路径）；`promote_ready` 清 `nextRetryMs`；退避被 Start 唤醒时不再翻倍；`host_reload` 改非阻塞喊话；代际分配复用 `allocate_generation`
  - **dev-watch**：`fileURLToPath` 修复（Windows 上 `.pathname` 让 cordis.yml 热刷新彻底失效）；就绪断言恢复为**快速失败**（坏 cordis.yml 亚秒退出，不再空转 15s）；watcher 受 `ctx.signal.stopping` 门控且 disposer 返回 `close()` promise；配置刷新后新增目录自动 `chokidar.add`；路径匹配统一走 `watch-path.ts`
  - **流程**：新增 `bun run verify`（= `typecheck` + `test` + `build`）、`tsconfig.host.json`（host/scripts 生产代码类型检查，0 error）、`bun run test` 同时跑前端与 host；`cargo clippy -- -D warnings` 与 `cargo fmt --check` 全绿
  - 实证：`cargo fmt/clippy/check/test`（80 passed）、`bun run verify`（前端 45 + host 107 passed）、`build:host` + sidecar 冒烟（2 passed）、`cargo tauri build` 产出 MSI/NSIS 且 `host.exe` 已作为组件打进安装包
- 🔍 **M1 修复轮复审（2026-09，三端只读评审）与二轮修复**：
  - **[严重] 托盘重放门禁与 host 重启解耦**：`TrayState` 曾用 `generation == cached && revision <= cached_revision` 判重放，而 host 的 `TrayService` 是**新进程**（revision 从 1 重计、`generation` 恒 0）→ 重启后首次推送被判"重放"丢弃，托盘保留死进程的菜单。已改为**内容指纹判等**（`TrayCache::accept`，`Ingress::{Changed,Unchanged}`），重启/乱序/重复推送都正确；回归测试 `restarted_host_content_is_never_mistaken_for_a_replay` 在旧逻辑下实测失败
  - `CloseRequested` 仅对 `label == "main"` 生效（次要窗口可正常关闭）；`ExitRequested` Noop 分支加 45s 退出看门狗（worker 崩了也不会变成不可退出）
  - `build.rs`：`VRCXK_BUN` 显式指定失败改为 fail-fast（不再静默降级）；sidecar **新鲜度**检查——任一 host 输入（`host/src`、`host/plugins`、`scripts`、`contracts`、`cordis.yml`、锁文件）比产物新就重建，并逐文件 `rerun-if-changed`
  - 脑/脸：`declaresHeartbeat` 改为**精确匹配**（`heartbeat` id 或 `heartbeat.<ext>` 文件名，避免 `my-heartbeat-monitor` 误伤导致启动失败）；FIBER 状态常量移入无副作用的 `host/src/fiber.ts` 并由 `host/tests/host-wiring.test.ts` 用真实 fiber 钉住；`reduceHostLifecycle` 的 response 分支补 `live` 守卫；dev-watch 去重窗 1500ms → 400ms（不再吞掉人手的第二次保存）；窄屏两个浮层改为上下堆叠
  - 流程：`tsconfig.test.json` 独立测试 program（bun 类型不再泄漏进生产代码面），`typecheck` 覆盖 app/test/host 三套
  - 实证：`cargo fmt/clippy/test`（82 passed）、`bun run verify`（前端 46 + host 112 passed）、sidecar 缺失/过期两条路径均触发自动重建
- 🔧 **M1-1 收口轮（2026-09，未提交）：快捷键回调 + 五能力统一 smoke 入口 + 单实例 smoke**
  - **快捷键回调（此前完全缺失）**：`shell.shortcut.*` 只注册不回调，按快捷键没有任何反应（#6 验收"快捷键触发"当时无法满足）。新增 `src-tauri/src/shortcut.rs`：`ShortcutRegistry` 纯逻辑（只转发**本壳注册过**的组合键、只转发 key-down 沿；键用 `HashSet<Shortcut>` 结构化匹配——插件解析大小写不敏感，故同一物理组合键只有一把键），`lib.rs` 用 `Builder::with_handler` 接插件全局 handler → 经 kkrpc/stdio `shortcut.pressed` 通知 host，并 emit `shortcut-pressed` 供 smoke 面板观察（含"是否已投递 host"）
  - **canonical 拼写只有一份**：`shell.shortcut.register/unregister` 回复由 `bool` 改为 `{ok, accelerator?, error?}`，`accelerator` 是插件 `into_string()` 的规范拼写（如 `shift+control+KeyK`）。host/前端一律按该字符串匹配、**不自行解析**——否则 TS 侧复制一份解析规则会静默漂移成"注册了却永不触发"
  - **host 侧**：`stdio.ts` 新增 `shortcut.pressed`（shell→host）扇出（与 `tray.action` 共用 `fanout()`）；新增 `host/src/shortcut.ts` 的 `ShortcutService`（`ctx.shortcut`，按 shell 回传的规范拼写绑定 handler；无 shell 返回 `no-shell` 而非抛错），`index.ts` 装配
  - **五能力统一 smoke 入口（#6 末项）**：`src-tauri/src/smoke.rs` + `capability_smoke` 命令 + `src/capabilitySmokePanel.tsx`（仅 dev 挂载）+ `src/capabilitySmokeCore.ts`（纯逻辑）。托盘派发走**真实路由** `dispatch_menu_action`（与菜单点击同一条路），白名单只放 `core.window.show|close`、`core.webview.reload`，quit/host.stop 等破坏性项一律拒绝
  - **单实例 smoke**：按钮真的再启动本进程（`current_exe()`，不模拟），由插件通知首实例聚焦主窗口后第二实例自退
  - **可测性切分（OS 回调抽成纯函数）**：`tray_click_intent`（仅左键 Up → 显示主窗口，Down 不重复触发）、`focus_plan`（show → [unminimize] → focus，顺序即契约）、`dialog_opts`（字符串→枚举映射与 pick 优先级，`shell.dialog.*` 与 smoke 共用一份，原先两处会漂移）
  - 实证：`cargo clippy -D warnings`/`check`/`test`（103 passed）、`bun run verify`（前端 64 + host 128 passed）、sidecar 因 host 源码变更被 `build.rs` 新鲜度检查自动重建
- ✅ **M1-1 收口验收轮（2026-09）：实机验收 + 修出 dev-launch 真 bug**。`cargo tauri dev` 实机跑通：托盘右键全功能、快捷键回调、单实例聚焦、通知、对话框均正常；#6 五条已勾。本轮还修出一个 **dev 构建长跑失败的真根因**：
  - **[严重] dev 态宿主永远起不来**：`tauri dev` 会把 externalBin 复制到 `target/debug/host.exe`（去 triple 后缀），`resolve_host_launch` 第 2 步先命中该副本 → 以 **cwd=`target/debug`** 启动宿主 → 那里没有 `cordis.yml` → 宿主立刻死 → 所有 shell→host 通知（托盘动作/快捷键）都报"未投递 host"。修法（`host.rs`）：**dev 构建彻底跳过打包分支**（`tauri::is_dev()`，判定下沉为纯函数参数可测）；打包态 sidecar 旁缺 `cordis.yml` → **响亮报错**不再静默重启循环
  - **新增 `[shell] host launch: <程序> <args> (cwd <cwd>)` 日志**——这次排查花多步推理，以后一行定位
  - **单实例可观测**：原回调 `let _ = show_main_window(app)` 吞掉聚焦失败；插件仅在 `FindWindowW` 找到窗口时才通知（找不到就继续当第二 app 跑）。改为日志 + `single-instance-redirect` 事件，smoke 面板显示"第二个实例已到达并聚焦"/"聚焦失败：原因"，并明示"第二进程自行退出、任务管理器看不到属正常"（实测 861ms 后 exit 0）
  - **投递失败细分**：`shortcut-pressed` 由 `delivered: bool` 改为 `delivery: delivered|no-host|write-failed` + `host{phase,pid,lastError}`；注册时即提示"宿主当前不可用（phase）"而非等按键后才知道
  - **通知归因 PowerShell 澄清**：`winrt-notification` 对未注册 AUMID 的既定回退（源码注释原话），dev 态必现；验收"AUMID+图标"须安装态（`cargo tauri build`+装）复验，面板提示已写明
  - 实证：`cargo fmt --check` 0 / `clippy -D warnings` 0 / `cargo test` **110 passed**（+7：dev 不取 target 副本、打包缺运行文件响亮失败、Delivery 细分等回归）/ `bun run verify` 前端 **72** + host **128**；`build.rs:149` 既有 rustfmt 漂移已**单独提交** `7b3a454b`（与功能 diff 分离）
