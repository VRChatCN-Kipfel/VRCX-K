# VRCX-K Cordis+Tauri 目标架构方案与分级热更新设计

> 作者: architect（t3 整合 / t5 修订 / t7 修复 round 2 / t9 定稿 v4 / v4.1 双向桥修正 / t11 修复 t10 findings v4.2）
> 日期: 2026-09-06
> 版本: v1（Node 推荐）→ **v2（bun 全链主线 + Node 备降 + 上游追踪 TODO）** → **v3（编号体系统一 L0-L3 + compat-patch cautionary + #11732 补证）** → **⚑ v4（通信=kkrpc 三通道 大脑-双手-脸 + UI 定稿 React + 团队技能策略 + 多客户端备注 + 功能范围分层）** → **⚑ v4.1（Cordis⇄Rust stdio 修正为双向桥：双手也能主动向大脑汇报/请求）** → **⚑ v4.2（t11 修复 t10 findings：F1 §3.2 去自研 RPC 残留 / F2 tauri-demo 确认为 Svelte 5 / F3 双向表述 / F4 11x 口径与来源行）**
> 修订触发: 用户拍板先用 bun 全链（技术偏好 + bun 性能/单文件分发）；调研后出现新上游证据（bun 官方正在补 Cordis 所需的 ESM loader hooks）；t6/t7 评审修复（编号统一、cautionary 标注、#34174 日期、#11732）；t9 定稿讨论（kkrpc 三通道、React 选型、团队策略、功能范围）；v4.1 用户追问修正（Cordis⇄Rust kkrpc/stdio 为双向通道非单向代理）；t11 修复 t10 findings（F1 §3.2 去自研 RPC 残留 / F2 tauri-demo=Svelte 5 / F3 双向表述 / F4 11x 口径来源行）+ 用户提出插件装卸内存泄漏硬约束与 M2 泄漏回归验收（§2.4/M2）
> 输入证据: [t1] runtime-research.md（bun vs Node 承载 Cordis 的运行时/HMR 能力边界）、[t2] ecosystem-research.md（koishi/cordis 插件装卸/热更新/社区插件平台调研）
> 新证据（t5/t7/t9，gh API 实证 2026-09-06）: [gh-35690] oven-sh/bun#35690 registerHooks DRAFT 未合、[gh-27369] bun#27369、[gh-11905] bun#11905、[gh-41168] bun#41168（bun 官方承认破坏 Cordis，dup of #11905）、[gh-34174/34171] bun#34174/#34171（created 2026-07-14 / closed 2026-08-13）、[gh-11732] bun#11732（compile 动态 import 已知未决，open）、[gh-patch] MonshinYu/dsh-bun-compat-patch（cautionary）、[gh-c87] cordis#87、[gh-c85] cordis#85、[gh-c105] cordis#105、[gh-kkrpc] kunkunsh/kkrpc（RPC 协议库：ws/stdio 双 transport + interop/rust + examples/tauri-demo，见附录 A）
> 目标读者: 队长/评审（t4/t6/t8/t10）、落地工程师
> 引用约定: 本文每项结论以 `[t1 §x.y]` / `[t2 §x.y]` / `[gh-*]` 标注来源章节与实证编号；§5 为结论→证据索引表。**v2/v3/v4 改动处均以 ⚑ 标注（v4 另以 「v4」 字样显式标注）。**

---

## 0. TL;DR（可评审结论先行）

1. **架构方向成立**：「Tauri 2 壳（只做系统交互）+ Cordis 宿主子进程 + 前端 UI + 社区插件生态」在绝对重写前提下可行，且与既有生产先例同构（DeepSeek Harness Desktop = Electron 主进程内 Cordis 宿主 + 同款 HMR 插件，[t1 §8]）。
2. **⚑ 宿主选型（v2 拍板）：生产主线 = Bun 1.4.x（bun compile 单文件 sidecar 分发）；Node 24 LTS（≥24.12）保留为「若 bun 上游窗口关闭/无望」的备降路径。** bun 全链可承载 L0/L1/L3 + L2（窗口期降级=插件级重启，[t1 §3.5/§5.3]）；唯一缺口 = L2 代码级 HMR（生态 plugin-hmr 构造即抛错，因 loader.internal 恒 undefined，[t1 §2.4/§3.3]），**但 bun 官方 PR #35690（registerHooks，DRAFT）正在补 Cordis 所需的 ESM loader hooks 公开 API**（[gh-35690]，详见 §4.5 上游追踪）。「bun 打包 Node 运行」不成立——bun compile 产物仍是 bun 语义（[t1 §7.1 案 C]）。⚠ compat-patch 为 cautionary 实证：bun 可跑 Cordis 系宿主但需兼容补丁且必须禁 HMR（[gh-patch]，见 §3.1/§3.2）。
3. **分级热更新按「三类服务承诺 × 四层机制」设计**：可重启级（普通插件装卸/升级/配置）、仅前端刷新级（UI/皮肤类）、后台服务自热级（dll/子进程承载的常驻服务）。四层机制 = 代码包装卸（重启）/ 启停配置（Fiber restart 进程内热）/ 源码代码 HMR（dev；**⚑ v2：Node 即刻可用、bun 为上游窗口期功能**，窗口期内以插件级重启降级，见 §4.5/§2.4）/ 前端扩展（entry+data 广播+Vite HMR）。koishi 事实上没有「运行时真·热装卸」，市场装卸=包管理器+全进程重启——VRCX-K 应把「秒级 sidecar 重启」作为默认承诺，把「进程内热」作为体验增强（[t2 §0.1/§1.2]）。
4. **⚑ v4 IPC 定稿：kkrpc 三通道 + 「大脑-双手-脸」职责模型（stdio 为双向桥）。** React（脸/UI）⇄ Cordis（大脑/宿主）= **kkrpc/ws**（WebSocket 业务 RPC + 事件）；Cordis（大脑）⇄ Rust（双手/系统代理）= **kkrpc/stdio 双向通道**（Rust interop，两端均可 expose + call；Cordis 调 Rust 要系统能力，**Rust 也可主动调 Cordis 要业务信息/命令宿主**）；React ⇄ Rust = **Tauri IPC**（UI 触发的系统动作：托盘/通知/对话框）。Rust 额外 spawn/supervise 宿主（51 重启，虚线生命周期通道）。**双向桥表述：Rust 是 Cordis 通往「系统」的门，Cordis 是 Rust 通往「业务/插件」的门，kkrpc/stdio 是两者间的双向桥——双手也能主动向大脑汇报/请求**（托盘菜单命令宿主、查询插件状态/版本、推送系统事件 休眠唤醒/网络变化/全局快捷键、让插件启停而不整宿主重启）。协议库 = kkrpc（kunkunsh/kkrpc，174 stars，ws+stdio 双 transport + interop/rust + 官方 tauri-demo，[gh-kkrpc] 见附录 A；替代原 v1-v3 的「Rust 字节中继 JSON-RPC」自研方案）。
5. **不依赖 tauri-plugin-js**（20 stars/0 forks/单维护者/0.2.0/332 下载，bus factor=1，[t1 §6.2]）；⚑ **宿主可执行 = bun compile 单文件 sidecar（经 Tauri externalBin / tauri-plugin-shell 分发，§3.2）**；pkg/SEA 仅保留为 **Node 备降路径**的分发方式（§3.3/§3.4，[t1 §6.3]）。
6. **插件安全必须自建**：koishi 无 JS 沙箱（插件=宿主全权），VRCX-K 插件可带 dll/子进程/Overlay → 必须「信任分级 + access 能力白名单 + 高风险插件子进程隔离 + 市场签名校验」（[t2 §0.5/§5.2-9/§5.3-12]）。
7. **⚑ v4 UI 定稿：React**（推翻 v3 的「Vue 倾向」）。理由：团队对 React/Vue 都不熟（无存量偏好），纯 AI 编程 + 联网场景下 **React 训练语料 ≈ Vue 的 11 倍**（口径：npm 周下载量 react ≈1.72 亿 vs vue ≈1560 万 ≈11x，[§4.4.1] 来源行）→ AI 生成 React 代码质量/成功率显著更高、「抄作业」（参考成熟 React 开源项目）更方便（§4.4/D-5 + §4.6 团队技能策略）。
8. **⚑ v4 产品范围分层初稿**：VRCX 核心功能按「首版 / 后续 / 交社区」三档 + 映射 M0-M5（§4.7）。

---

## 1. 目标架构图与进程/IPC 边界（⚑ v4/v4.1：Tauri 壳=双手 / Cordis 子进程=大脑 / React=脸；stdio 双向桥）

> ⚑ v4 附图：最终架构图见 **`docs/vrcxk-arch-final.html`**（可交互 HTML，含三 actor 边界、kkrpc 连线与职责卡；源 JSON `vrcxk-arch-final.architecture.json`）。本节为图的文字版。

### 1.1 进程拓扑与三 actor 职责（大脑-双手-脸）

```
┌─────────────────────────────────────────────────────────────────────┐
│ Tauri 应用进程（Rust 壳 =「双手」+ WebView =「脸」宿主容器）        │
│                                                                     │
│  ┌──────────── WebView（React UI =「脸」）────────────┐             │
│  │  应用外壳 UI · UI 插件渲染区（slot/iframe，§4.4）  │             │
│  │  ⇄ Cordis: kkrpc/ws（业务 RPC + 事件，主通道）     │             │
│  │  ⇄ Rust:   Tauri IPC（UI 触发的系统动作）          │             │
│  └───────┬────────────────────────────────┬───────────┘             │
│          │ Tauri IPC（脸→手：托盘/通知/对话框/系统动作）             │
│  ┌───────▼─────────────────────────────────────────────────────┐      │
│  │ Rust 壳 =「双手」：系统代理（双向桥）                      │       │
│  │ · 服务 Cordis 系统能力请求（通知/托盘/对话框/快捷键）      │       │
│  │ · 主动调 Cordis：托盘命令/插件状态查询/系统事件推送        │       │
│  │ · spawn/supervise 宿主（51 重启，生命周期主动）            │       │
│  └──────────┬──────────────────────────────────────────────────┘      │
└─────────────┼─────────────────────────────────────────────────────────┘
              │ ① spawn / supervise / 51 重启（Rust→Cordis 生命周期）
              │ ② kkrpc/stdio 双向桥：Cordis⇄Rust（系统能力 ⇄ 业务/系统事件）
┌─────────────▼─────────────────────────────────────────────────────────┐
│ Cordis 宿主 =「大脑」Bun 1.4.x 主线（bun compile 单文件 sidecar）      │
│   cordis@4 rc.x + loader + include · 全部业务逻辑 + 插件生态          │
│   （L2 代码 HMR = bun 上游窗口期 → 未合前插件级重启，§4.5）           │
│   核心 ctx：配置(Include) · 日志 · 市场 · 权限/access · 生命周期       │
│   前端 entry/data 广播 · C 类插件子进程管理                            │
│  ┌─── 插件层（信任分级 T0/T1/T2，见 §1.4）─────────────────────┐      │
│  │  A. 进程内信任插件（T0/T1）  B. UI 插件（前端执行）          │      │
│  │  C. 重能力插件（T2，带 dll/子进程/Overlay）→ 独立受管进程    │      │
│  └─────────────────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────────────────┘
```

**读图要点（⚑ v4.1 职责方向修正：stdio 双向桥）**：

- **大脑 = Cordis 宿主**：所有业务逻辑与插件在这里。React 通过 kkrpc/ws 与它对话（业务 RPC + 事件）；Cordis 通过 kkrpc/stdio 调 Rust 获取系统能力（托盘、通知、对话框、全局快捷键等——插件需要系统能力时，大脑调双手）。**同时 Cordis 也是 Rust 通往「业务/插件」的门**——Rust 可反向调 Cordis（见下条）。这是与 v1-v3「Rust 只做字节中继 + 宿主被壳监督」模型的方向性重构：Rust 从「转发者」变为「Cordis 的系统代理 + 双向对等体」。
- **双手 = Rust 壳（双向桥）**：① **被动面**——服务 Cordis 插件的系统能力请求（响应 kkrpc/stdio 调用）与 React 的 Tauri IPC 系统动作；② **主动面**——**Rust 也可主动经同一 kkrpc/stdio 调 Cordis**：托盘菜单命令宿主做事、查询插件状态/版本、推送系统事件（休眠唤醒/网络变化/全局快捷键）、让某插件启停（不必整宿主重启）；③ 生命周期——spawn + supervise 宿主（51 重启协议，[t2 §1.2]）。Rust 不承载业务逻辑、不解析插件协议（tauri-plugin-js 教训：Rust 只做系统代理不做业务解析，[t1 §6.3]）。
- **脸 = React UI**：渲染与交互。业务状态全部经 kkrpc/ws 向大脑要；只有「用户点了系统级按钮」（如全局快捷键注册、系统通知、文件对话框）才走 Tauri IPC 找双手。
- **双向桥总述**：Rust 是 Cordis 通往「系统」的门，Cordis 是 Rust 通往「业务/插件」的门，**kkrpc/stdio 是两者间的双向桥**（两端 RPCChannel 均可 expose + call；kkrpc interop/rust 的 server/client 对称存在）——双手也能主动向大脑汇报/请求。
- **单个 sidecar 秒级重启**：市场装卸/升级的默认生效方式 = 宿主重启，壳与 WebView 存活，UX =「后端重连中」（kkrpc/ws 断线重连由 React 侧处理）。
- **重能力在宿主层派生**：插件带 dll/开子进程等「重能力」由 Cordis 宿主（有完整 OS 进程能力）以 `child_process`/`worker_threads` 为 C 类插件再派生受管进程（[t1 §5.3] 插件级子进程隔离；[t2 §5.2-9] dll 场景必须进程级隔离）——与团队约束「VR Overlay 等重原生能力由插件自带 dll 在子进程实现」一致。

### 1.2 进程职责表（⚑ v4：大脑-双手-脸）

| actor | 进程/运行时 | 职责（只做这些） | 不做 |
|---|---|---|---|
| 脸 Face | ⚑ React UI（WebView2 / 对应 WebView，Vite 构建） | 渲染与交互；业务数据经 kkrpc/ws 与大脑通信；UI 插件渲染（slot/iframe）；用户触发的系统动作经 Tauri IPC 找双手 | 不直连业务后端以外资源；不自己实现业务逻辑；不信任外部输入 |
| 手 Hands | Tauri 2 / Rust | **系统代理（双向桥）**：① 被动服务 Cordis（kkrpc/stdio）与 React（Tauri IPC）的系统调用（托盘/通知/对话框/快捷键等）；② **主动经 kkrpc/stdio 调 Cordis**：托盘菜单命令、插件状态/版本查询、系统事件推送（休眠/网络/快捷键）、请求插件启停；③ 生命周期 spawn/supervise 宿主（51 重启）+ updater | 不跑业务/插件逻辑；不解析插件协议（[t1 §6.3]）；不做 UI |
| 脑 Brain | ⚑ Bun 1.4.x sidecar（Node 24 备降） | Cordis 核心装配、插件生命周期（EntryTree/Fiber）、配置持久化（Include）、市场装卸执行、日志汇聚、权限/access 执行、前端 entry/data 广播、C 类插件子进程管理；**经 kkrpc/stdio 双向桥**：主动调 Rust 要系统能力 + **响应 Rust 反向调用**（业务信息/命令宿主/插件启停） | 不做 UI；不做系统级托盘/快捷键（那是双手）；不直接碰系统 API |
| 插件 T0/T1/T2 | 进程内 / 前端 / 受管子进程 | 各自业务；B 类只注册前端资源；C 类自持 dll/Overlay/长连 | T1/T2 无宿主全权（见 1.4） |

### 1.3 IPC 边界与协议（⚑ v4 定稿：kkrpc 三通道）

> 协议库选型 = **kkrpc**（[gh-kkrpc] kunkunsh/kkrpc，174 stars，活跃维护 2026-08）：TypeScript-first RPC，同一 API 抽象跨多 transport（ws/stdio/iframe/worker/electron/tauri），类型安全代理对象、双向调用、回调参数、middleware。官方 Tauri demo（`examples/tauri-demo`，⚠ 前端为 Svelte 5）提供「前端 ⇄ 后端运行时」的 stdio 接入参照（`TauriShellStdio` + `@tauri-apps/plugin-shell` spawn，transport 模式与 UI 框架无关）；`interop/rust` 提供 Rust 侧实现（stdio + ws 双测试）。完整采用记录见附录 A。

| 通道 | 端⇄端（方向） | 载体/transport | 帧格式 | 用途 | 说明 |
|---|---|---|---|---|---|
| **业务主通道** | 脸 React ⇄ 脑 Cordis（双向） | **kkrpc/ws**（localhost WebSocket，动态端口） | kkrpc JSON-RPC（类型安全代理） | 全部业务 RPC + 事件：状态查询、插件启停/配置、市场、日志流、数据广播 | 大脑暴露 API，脸 wrap transport 调远程函数；宿主重启后 React 侧自动重连 |
| **系统桥通道（双向）** | 脑 Cordis ⇄ 手 Rust（**互相主动调**） | **kkrpc/stdio**（tauri-plugin-shell sidecar 管道，Rust interop 实现） | kkrpc JSON-RPC over stdio | **双向**：C→R 插件要系统能力（托盘/通知/对话框/全局快捷键/系统命令 白名单）；R→C 托盘菜单命令宿主、插件状态/版本查询、系统事件推送（休眠/网络/快捷键）、请求插件启停（免整宿主重启） | **双向桥**（两端 RPCChannel 均可 expose+call；kkrpc interop/rust server/client 对称）；Rust 侧用官方 `interop/rust` |
| **系统动作通道** | 脸 React → 手 Rust | **Tauri IPC**（command/event） | Tauri 原生 | UI 触发的系统动作：打开对话框、系统通知、窗口操作、快捷键注册 | 脸不直接碰系统 API，经 Tauri IPC 找双手 |

**安全边界**：
- Rust（双手）对 kkrpc/stdio 与 Tauri IPC 暴露的**系统命令做白名单鉴权**（如高权限系统动作需用户确认；插件 manifest 声明的能力经 Cordis 校验后才转成 Rust 调用，§1.4 access 白名单的延伸）。
- kkrpc/ws 仅监听 `127.0.0.1` 动态端口 + 会话 token（宿主启动生成，经 kkrpc/stdio 或初始化注入 React），防本地其他进程连入；CSP 限定源。
- React（脸）不直连任何系统能力，所有系统副作用都经双手白名单。

**动态端口与重连**：宿主启动后绑定 `127.0.0.1:0` 随机端口 → 经 kkrpc/stdio 上报 Rust → Rust 以 Tauri event / 初始化脚本注入 WebView；宿主重启（51）后 React 侧 kkrpc/ws 自动重连（大脑-脸通道无状态恢复由前端处理，见 §2.2 类别三可恢复性）。

> ⚑ v4 变更说明：v1-v3 的「WebView↔宿主走 Tauri command/event 中继 + localhost WebSocket 数据面、Rust 做字节中继 JSON-RPC」自研方案被 kkrpc 替代——React⇄Cordis 直接 kkrpc/ws（不再经 Rust 中转），Cordis⇄Rust 用官方 kkrpc/stdio + interop/rust，避免自研 RPC 协议（[t1 §6.3] 曾建议自研薄层，v4 升级为采用成熟 kkrpc 库，理由见附录 A 采用记录）。⚑ v4.1 修正：Cordis⇄Rust 的 kkrpc/stdio 为**双向通道**（两端 RPCChannel 均可 expose+call，interop/rust server/client 对称），非单向「Cordis 调 Rust」代理——Rust 也主动调 Cordis（托盘命令/插件查询/系统事件推送/请求插件启停），见 §1.1 读图要点与 §1.2/§1.3 表。

### 1.4 信任边界与插件隔离（安全架构骨架）

koishi 的事实：**插件无沙箱，以宿主全权进程内运行**，仅靠 `insecure` 标识与社区背书（[t2 §4.4]）；Cordis 新雏形有安全模式 + 每插件 `access: { fs, http }` 白名单，基于 isolate/intercept，发布未久（[t2 §4.4]）。VRCX-K 插件可带 dll/子进程，**照搬「全权」不可接受**，三级信任：

| 级 | 插件来源/性质 | 运行域 | 能力 | 依据 |
|---|---|---|---|---|
| T0 内核 | 官方随包 | 宿主进程内 | 全权（含生命周期/市场/权限自身） | 等同 koishi 官方插件组（[t2 §4.1]） |
| T1 已验证 | 官方商店/签名验证通过 | 宿主进程内 | 受 `ctx` access 白名单约束（fs 子集/http 白名单/spawn 禁），宿主按 manifest 声明（`service.required/optional/implements` + 能力声明，[t2 §4.2]）执行 | koishi authority 4 装卸门槛（[t2 §4.4]）+ Cordis access 白名单思想（[t2 §4.4/§5.2-9]） |
| T2 高风险/重能力 | 带 dll/原生/Overlay/需宽权限或未验证 | **独立受管子进程**（宿主派生，宿主代理 ctx） | 崩溃隔离、副作用隔离；宿主按 manifest 声明的能力映射到子进程权限（如禁止写宿主配置目录） | [t1 §5.3]（插件级子进程隔离是 L2 窗口期降级的 bun 现实替代，也是干净隔离模型）；[t2 §5.2-9]（dll 场景进程级隔离才是答案） |

> 隔离细节（UI 沙箱是否加 `node:vm` 等）属落地 PoC 决策，不在本方案裁决；生产先例 DSH Desktop 用 `node:vm` 动态包沙箱 + 子进程运行器双通道（[t1 §8/§5.3]），VRCX-K 可在 PoC 中对比。JS 沙箱适合低风险插件，dll 场景必须进程级（[t2 §5.2-9]）。

### 1.5 生命周期管理

- **启动序**：双手（Rust）启动 → 单实例检查 → spawn sidecar（版本与壳锁定的宿主可执行，见 §4.2 风险 R2）→ 大脑装配 Cordis + loader + include（读 `cordis.yml` 期望状态，EntryTree 装配）→ 大脑上报 kkrpc/ws 端口与就绪（经 kkrpc/stdio）→ 双手以 Tauri event 注入 WebView → 脸（React）加载并连 kkrpc/ws。
- **停止序**：应用退出 → 双手发 `stop`（经 kkrpc/stdio，优雅）→ 大脑逆序 dispose 全部 Fiber（`ctx.effect` 纪律，[t2 §2.5]）→ 落盘配置 → 退出码 0。超时（如插件 hang）→ 双手强杀并记录。
- **重启编排**：大脑退出码约定——`51` = 请求重启（对齐 koishi daemon 语义 [t2 §1.2]），双手 supervisor 见 51 自动拉起；其他非零 = 按崩溃策略（记录 + 询问用户重试或进入安全模式：禁用最近变更插件后重启）。
- **崩溃隔离**：C 类插件子进程崩溃不影响大脑；T0/T1 进程内崩溃由大脑兜底（可整宿主重启，秒级）。
- **升级 UX**：koishi 在重启前经 `envData.message` 注入「升级完成将重启」提示（[t2 §1.2/§4.5]）——VRCX-K 复刻为 React toast/进度条。

---

## 2. 分级热更新方案

### 2.1 设计原则（直接映射 koishi 事实四层）

koishi 没有显式分级，事实分层为：**npm 包（安装单元）/ 配置条目（启停单元）/ 源码模块（HMR 单元）/ 控制台前端（刷新单元）**（[t2 §0.4]）。VRCX-K 的「三类服务承诺」是用户可感知层，其下由这四层机制承载：

```
用户三类承诺                    底层机制（四层）              运行时依赖
──────────────────────────────────────────────────────────────────────
类别一  可重启级          L0 代码包装卸(装/卸/升级) → 重启     无内部依赖
(普通插件)               L1 启停/改配置 Fiber restart(进程内热) 无（bun 亦可 [t2 §1.3/§2.3]）
类别二  仅前端刷新级      L3 前端扩展 entry/data 广播+Vite HMR  无（前端）
(UI/皮肤类)
类别三  后台服务自热级    L2 dev 源码代码 HMR(dev only)          ⚑ bun: 上游窗口期
(常驻服务/dll)           + 插件自身 refresh 契约 + 子进程滚动重启   [gh-35690]；窗口期内
                                                               插件级重启降级(§2.4)
```

**关键认知（写进方案，防过度承诺）**：koishi 生态自身对「新装/卸载/升级代码包」一律 = 改 package.json + 包管理器 + **全进程重启**，不存在运行时热换 node_modules 的机制（[t2 §1.2 结论 A/§0.1]）。真正「热」的是启停/改配置（进程内 Fiber restart）与 dev 源码 HMR（[t2 §1.3/§1.4]）。因此 VRCX-K 的分级热更新产品承诺应为：

- **默认承诺**：市场装卸/升级 = 秒级 sidecar 重启（壳与 UI 存活、自动重连）；启停/改配置 = 即时生效（进程内热）；UI 插件变更 = 前端刷新即生效。
- **开发承诺**（仅 dev）：插件源码改动按依赖图局部热替换——⚑ Node 宿主即刻可用（loader.internal）；bun 宿主在 #35690 合并前以「插件级重启」降级（见 §4.5 TODO-1/§2.4），合并后接入 registerHooks 公开路径。
- 不做「生产环境运行时热换插件代码」的空头承诺（生态做不到，[t2 §1.2/§3.5]）。

### 2.2 三类服务承诺明细

#### 类别一：可重启级（默认路径，覆盖绝大多数功能插件）

| 用户动作 | 生效机制 | 体验 | 依据 |
|---|---|---|---|
| 市场安装/卸载/升级 | 写清单 → 原子替换包目录 → **sidecar 重启** | 进度条 + 「完成将重启」提示 + 自动重连；秒级 | koishi 装/卸/升 = 重启（[t2 §1.2]）；VRCX-K 桌面无 npm → 内置包解析/原子替换（[t2 §5.2-8]） |
| 启用/停用插件 | Include.refresh → EntryTree diff → Fiber 启动/dispose | **即时生效，无重启** | Fiber restart 进程内热（[t2 §1.3/§2.2]） |
| 改插件配置 | Entry.update diff → `_patchContext` + fiber.restart | **即时生效**（同模块重跑 apply，不重新 import） | [t2 §2.2] |
| 改 cordis.yml 本身 | watcher → include.refresh()（防抖） | 即时（加行=热启用，删行=热停用） | [t2 §2.3]；需显式 refresh（两运行时同此行为，[t1 §2.3]） |

#### 类别二：仅前端刷新级（UI/皮肤/面板类插件）

| 用户动作 | 生效机制 | 体验 | 依据 |
|---|---|---|---|
| UI 插件代码/资源变更（dev） | Vite HMR（前端模块热替换） | 无感刷新 | 前端 Vite HMR 不依赖宿主（[t1 §5.2 L4]；[t2 §3.4]） |
| UI 插件变更（prod/用户侧） | entry 清单刷新 + `refresh('entry')` 数据广播 → WebView 重载该插件资源 | 页面/局部刷新即可，后端进程不动 | koishi prod：entry/数据广播 + 刷新（[t2 §3.4]） |
| 新增/移除 UI 插件 | 前端入口清单更新 + 宿主广播 | 无需宿主重启 | [t2 §3.4] `ctx.console.addEntry/refresh` 等价物（VRCX-K 自建，[t2 §5.3-14]） |

#### 类别三：后台服务自热级（常驻后台/dll/Overlay/长连类）

这类插件的约束：不能因宿主整体重启而丢失状态/断流；可能持有 dll 句柄或 OS 资源。三档策略（按插件 manifest 声明）：

1. **配置自热**（所有后台插件必须实现）：宿主把配置变更以事件下发（koishi `hmr/reload` 事件范式，[t2 §3.6]），插件实现自己的 refresh 契约（重连、换端点、改参数），**不重启**。写入插件 SDK 硬约束。
2. **插件级滚动重启**（需换代码/升级时）：C 类插件在受管子进程中运行 → 宿主对该子进程做「先起新、交接、再杀旧」的滚动替换（局部借鉴 cordis 0dt 交接思想，但只用于「不能断」的关键服务；单机桌面场景一般秒级重启已够，0dt 仅日志/Overlay 等真不能断处使用，[t2 §5.3-15]）。dll 场景注意句柄释放纪律（进 SDK 约束）。
3. **宿主内 Fiber 重启**：后台插件若为进程内 A 类，代码变更走 dev HMR（⚑ Node 即刻 / bun 待 #35690，窗口期走插件级重启，§4.5）或随类别一的 sidecar 重启；自热窗口由插件自身状态持久化兜底（重启后自动恢复现场——插件 SDK 要求：长连类必须支持断线重连，状态必须可恢复，[t2 §2.5] 副作用可逆纪律的延伸）。

> **对「后台服务需自热生效」的准确表述**：VRCX-K 承诺的是「后台服务插件的**可恢复性 + 可自热性**」（配置变更即时自热、升级可滚动替换、崩溃可自动恢复），不是「在宿主进程里热换 dll 代码」——后者在 Node/bun 任何运行时都不现实。

### 2.3 底层机制与运行时支撑矩阵（宿主选型的约束来源）

> ⚑ v3 编号统一说明（修复 round 2）：本文统一为**四层**编号——**L0=装卸重启 / L1=启停配置 / L2=代码级 HMR（dev；bun 窗口期内以插件级重启降级实现）/ L3=前端刷新**。与 t1 §5.1 五级体系的映射：本文 L0↔t1 L1（进程重启级）、L1↔t1 L2（配置刷新级）、**L2↔t1 L3（代码热替换级）**、L3↔t1 L4（纯前端刷新级）；**t1 的 L2b（自研轻量 reload）不再单列为能力层**——它是 bun 窗口期内本文 L2 的降级机制（插件级重启），见 §2.4 对应小节。

| 层 | 能力 | Node 24.9(+addon) | Bun 1.4.2 | 机制 | 依据 |
|---|---|---|---|---|---|
| L0 | 进程重启/装卸 | ✓ | ✓ | sidecar spawn/kill | [t1 §5.2] |
| L1 | 配置刷新/启停 Fiber restart | ✓ | ✓（等价） | Include 重读 + EntryTree.update + partial-dispose；纯公开 API | [t1 §5.2]；[t2 §2.3] |
| L2 | 代码级 HMR（dev） | ✓（需 loader.internal） | ⚑ **上游窗口期**：生态 plugin-hmr 现在构造即抛错；bun 官方 #35690（registerHooks，DRAFT）落地后 cordis 可走公开 API（§4.5 TODO）。**窗口期内降级机制 = 插件级重启**（清 require.cache 可重跑 ESM 但无依赖图，[t1 §3.5]；实现见 §2.4） | loadCache 清除 + ModuleJob.linked 依赖图 + fiber 重建（plugin-hmr 三段式）；窗口期降级 = watcher + cache evict + 插件级 dispose/restart | [t1 §2.4/§5.2]；[t2 §3.2]；[gh-35690] |
| L3 | 前端刷新 | ✓（无关宿主） | ✓ | Vite HMR / entry+data 广播 | [t1 §5.2]；[t2 §3.4] |
| — | 生态 HMR 插件直接可用 | ✓ | ✗（待 #35690 + cordis 迁移） | `@cordisjs/plugin-hmr` 硬依赖 loader.internal | [t1 §5.2]；[t2 §3.2]；[gh-35690]；[gh-c87] |

**推论（⚑ v2/v3）**：bun 主线可承载 **L0/L1/L3 + L2（窗口期降级）**——这覆盖「类别一(装卸重启+启停配置即时) + 类别二(前端刷新) + 类别三(插件级重启降级 + 自热)」的全部产品承诺（[t1 §5.3] 早已指出：若只承诺 L1+L2+L4，bun 完全够用；compat-patch 属 cautionary 实证——bun 可跑 Cordis 系宿主但需兼容补丁且必须禁 HMR，见 §3.1/§3.2，[gh-patch]）。唯一缺口是 **L2 代码级 HMR**：生态现成工具链（plugin-hmr）在 bun 上不可用，但 bun 官方 #35690 正在补 registerHooks 公开 API，cordis 亦已立项「以公开 loader hooks 取代 --expose-internals」（#87，虽暂未合，[gh-c87]）——即 **bun 侧与 cordis 侧在同一方向相向而行，L2 属「上游窗口期功能」而非「结构性不可用」**。窗口期内 dev 用插件级重启降级（§2.4/§4.5 TODO-4）。若窗口关闭/上游无望，Node 备降路径整链可用（§3.3）。

### 2.4 各层关键实现要点

- **L1 配置热（A/B/C 插件公共底盘）**：cordis.yml = 期望状态声明；Include 覆写 EntryTree.write 落盘；watcher（dev 期 chokidar 由 hmr 插件管，prod 期宿主自带轻量 watcher）触发 `include.refresh()` → 整组 diff → create/update/remove（[t2 §2.1/§2.3]）。UI 的启停/配置操作一律翻译成对 EntryTree 的增删改 + write() 持久化（[t2 §5.1-2]）。
- **L1 副作用纪律 + 防泄漏硬约束（插件 SDK 硬约束；⚑ t11 强化——用户提出：插件装卸内存泄漏直接关系生态能否安全频繁装卸）**：
  - **副作用逆序回收**：插件 `apply()` 里注册的一切必须随 fiber dispose **逆序回收**——`ctx.on` 监听、`ctx.effect()`、定时器、子进程、WebSocket、kkrpc channel。裸资源不回收 = 每次装卸泄漏一点，几百次后宿主内存膨胀（[t2 §2.5] Fiber 逆序 disposer 纪律）。
  - **模块级变量也是泄漏源**：插件模块顶层 `let/const` 缓存（单例、全局 Map、闭包持有 ctx）即使 fiber dispose 后，若模块对象仍被外部引用（事件回调、缓存表）则不会释放——插件卸载时宿主需断开外部对该模块的引用链（registry 清理 + 事件源移除）。
  - **SDK 硬约束清单**：① 所有副作用必须经 `ctx.effect()` 注册（dispose 自动逆序回收）；② kkrpc channel / WS / 定时器 / 子进程必须经 ctx 注册或显式 destroy（不裸开）；③ 插件模板 + CI 检查强制「无 ctx 生命周期外的全局副作用」；④ 裸资源（dll 句柄等）在 ctx dispose 钩子显式关闭。
  - 这是「插件可重启/可频繁装卸」安全性的前提；写进插件模板、文档与 CI lint 规则（对应 [t2 §2.5] 可逆副作用纪律 + [t2 §5.1-3] 生态硬约束）。
- **L2 代码 HMR（仅 dev）**：⚑ v2 分宿主——**Node 备降宿主**：`@cordisjs/plugin-hmr`（cordis 4 全 ESM 版）三段式：Stage1 全量 re-import 验证（失败回滚缓存不动运行态）→ Stage2 registry.delete 全 unload（保留 fiber 快照）→ Stage3 用 replacement 重建 fiber；externals/框架文件变更 → 整宿主重启（loader.exit）（[t2 §3.2]）。**bun 主线宿主（现期）**：走 L2 窗口期降级机制（下一条）——插件级重启，不依赖 loader.internal。**bun 远期**：#35690（registerHooks）合并 + cordis 迁公开 API 后，接生态 plugin-hmr（§4.5 追踪）。
- **⚑ L2 窗口期降级机制 = 插件级重启（v2 新增；bun 主线 dev 现期主通道；不再单列 L2b 能力层）**：bun 清 `require.cache` 即可令 ESM 重跑（[t1 §3.5]），但没有依赖图（无 ModuleJob.linked）——降级方案 = **宿主自管插件级重启**：watcher 监听插件源码目录 → 命中文件属于哪个 Entry（按 import 时的模块 URL 前缀映射，dev 期由宿主注入）→ 对该 Entry 做 `fiber.dispose()` + `tree.import()` 重载 + `fiber.restart()`（机制同 L1 但走「重新 import」而非「仅改配置」，[t2 §2.2] Entry.update 首次装载路径）→ 失败回滚并提示「需整宿主重启」。粒度 = 插件级（非模块级）：改一个 util 会重启依赖它的插件——比生态 HMR 粗，但比「重启整个宿主」细；对 dev 作者体验足够（对应 koishi 社区「Ctrl+S 重载这几个插件」诉求的粗粒度版，[t2 §3.5]）。**同样纪律适用**：副作用经 ctx 回收（§2.4 L1 纪律），否则 dispose 泄漏。
- **L3 前端扩展（VRCX-K 自建契约，⚑ v4 = React）**：宿主侧 API ≈ `addEntry({dev, prod})` + `refresh('entry')` 广播 + DataService push（[t2 §3.4]）；前端侧 React 等价物 ≈ 插件清单注册 + portal/context 挂载点 + 订阅数据（[t2 §3.4]；选型定稿见 §4.4）。**prod 静态资源按版本化 URL + 缓存控制管理**（新版本 entry 广播后 WebView 拉新资源，[t2 §5.3-14]）。
- **重启编排**：大脑 51 退出码 → 双手（Rust supervisor）拉起 → 重启后恢复（配置已落盘；服务插件现场恢复见 §2.2 类别三；脸侧 kkrpc/ws 自动重连）。
- **UX 状态提示**：把「改配置即时生效 / 改代码需重启 / 装卸需重启」差异做成界面提示（⚑ bun 主线下 L2 窗口期尤其必要——dev 插件改码需提示「已为你重启该插件」而非假装热替换，[t2 §5.3-16]）。

### 2.5 前端 UX 状态机（三类承诺的产品化）

```
市场安装/升级 ──▶ 确认(权限提示) ──▶ 原子替换 ──▶ [sidecar 重启中] ──▶ 自动重连 → 完成 toast
启停/改配置  ──▶ 即时生效（无重启；失败回滚配置并提示）
UI 插件变更  ──▶ entry 广播 → WebView 重载对应前端资源（无后端重启）
后台服务升级 ──▶ 该插件子进程滚动替换 / Fiber 重启（其他一切不受影响）
dev 源码改动 ──▶ (Node 备降) plugin-hmr 局部热替换；失败回滚并提示「将整宿主重启」→ 51 重启
            └─▶ (⚑ bun 主线现期) 插件级重启（watcher→dispose→重 import→restart）；失败回滚并提示「需整宿主重启」
            └─▶ (⚑ bun 远期, #35690 合) 走公开 registerHooks 接生态 HMR → 模块级热替换
```

---

## 3. 宿主选型建议（⚑ v2: bun 主线 + Node 备降；三案对比重写）

> ⚑ v2 修订：原 v1（Node 推荐）已被用户拍板推翻——先 bun 全链（技术偏好 + bun 性能/单文件）。v2 改为 bun 主线；Node 保留为备降（触发条件见 §3.3/§4.5）。本节省略的旧论证（Node type-stripping、pkg/SEA 分发细节、`node-addon-require-builtin` 免旗标等）仍可作为备降路径的操作手册，见 §3.4 备降部署要点与 [t1 §4]。

### 3.1 三案对比（重写；依据 t1 §7.1 + t5 新上游证据）

| 维度 | ⚑ B: bun 1.4.x 宿主（v2 主线） | A: Node 24 宿主（备降） | C: bun 打包 Node 运行 |
|---|---|---|---|
| Cordis 核心运行 | ✓（实测可跑 [t1 §3]） | ✓（官方目标环境） | **不成立**：bun compile 产物 = bun 运行时 + bun 语义，不能「内含 Node」（[t1 §7.1]） |
| loader 静态加载 .ts 插件 | ✓ | ✓ | — |
| 宿主能力（L0/L1/L3 + L2 窗口期降级） | ✓（全链） | ✓ | — |
| L2 代码级 HMR（dev） | ⚑ **上游窗口期**：生态 plugin-hmr 现不可用（loader.internal 缺失）；bun#35690 registerHooks DRAFT 未合（[gh-35690]）；cordis#87 立项改公开 API 未合（[gh-c87]）。窗口期降级机制=插件级重启（§2.4/§4.5） | ✓（loader.internal 可用，addon 免旗标 [t1 §4.2]） | — |
| 生态 HMR 插件直接可用 | ✗（待 #35690 + cordis 迁移，双追踪 §4.5） | ✓ | — |
| dev 作者体验（改码即生效） | ⚑ 现期=插件级重启（秒级、UI 提示）；远期=热替换 | 热替换 | — |
| TS 语法子集 | 原生全支持（含 enum/参数属性） | enum/参数属性需 `--experimental-transform-types` 或预编译 | — |
| 免装运行时分发 | bun compile 单文件（v2 主线分发形态） | pkg/SEA sidecar（**备降路径**分发） | — |
| 分发体积/启动 | 优（bun 单文件小、启动快） | 一般（pkg 产物 + addon 平台二进制） | — |
| 插件动态 import/本地目录解析 | bun compile 后**动态 import 外部插件目录受限**（已知未决项 #11732，需 PoC 验证，R1） | pkg/SEA 虚拟 FS 需验证（同 R1） | — |
| 生产实证（同类宿主） | ⚑ **cautionary（反向证据）**：MonshinYu/dsh-bun-compat-patch 证明 bun **可跑** Cordis 系宿主（DSH）但**需兼容补丁**（stripTypeScriptTypes 重实现）且**必须禁 HMR**（env-gated）——与 t1 loader 实证（核心可跑 / HMR 不可用）同向，作为「bun 可行但有 HMR 缺口需补丁」的警示而非可行性背书（[gh-patch]） | DSH Desktop 生产先例（[t1 §8]，正向） | — |
| 生态锚点 | bun 官方主动补 Node loader hooks（#35690） | koishi 官方要求 Node（[t1 §4.1]） | — |

> 注：bun compile 对外部插件目录的动态 import 能力是 bun 已知未决项（#11732 open，见 §4.5 事实基线/R1），与 Node pkg/SEA 一样需要 M0 PoC 实证；这与「bun 运行时能动态 import」是两回事——compile 打包的是宿主骨架，插件目录仍外置按需加载。

### 3.2 推荐方案（⚑ v2 重写，三句话）

1. **生产宿主 = Bun 1.4.x（bun 全链主线）**，跑 Cordis 4 rc.x + loader + include；宿主可执行以 `bun compile` 打成单文件 sidecar 分发（bun 官方单文件方案，体积/启动优于 pkg 产物）。理由：用户拍板 bun 全链（技术偏好 + 性能 + 单文件分发）；t1 实测 bun 核心可跑、loader 静态加载可跑、L0/L1/L3 + L2（窗口期降级）全链可用（[t1 §3/§5.2/§5.3]）。⚠ **compat-patch 在此定位为 cautionary（反向）证据而非可行性背书**：它证明 bun 可跑 Cordis 系桌面宿主（DSH），但同时证明**必须自带兼容补丁**（stripTypeScriptTypes 重实现）且**必须禁 HMR**（env-gated guard）——与 t1「核心可跑 / HMR 不可用」的 loader 实证同向，警示「bun 全链 ≠ 开箱即用，需兼容垫片 + HMR 降级」（[gh-patch]；对照 [t1 §2.4/§3.3]）。
2. **L2 代码 HMR = bun 上游窗口期功能，不是结构性死路**：bun 官方 #35690（registerHooks，+49 测试）正在实现 Cordis 需要的同步 module hooks 公开 API（[gh-35690]）；cordis 官方 #87 已立项「以公开 loader hooks 取代 --expose-internals」（虽 PR #85 暂未合，方向明确，[gh-c87/gh-c85]）。窗口期内 dev 以 L2 降级机制=插件级重启（§2.4/§4.5 TODO-4），体验损失有限且 UI 明示。
3. **宿主分发 = Tauri 官方 sidecar**（externalBin + tauri-plugin-shell），宿主可执行 = **`bun compile` 单文件**；**不依赖 tauri-plugin-js**（成熟度不足，[t1 §6.2]）。**⚑ v4 通信协议已定稿采用 kkrpc（D-6/§1.3/附录 A），不再自研 RPC 薄层**——「自研」仅剩宿主派生 C 类插件子进程的 runner（进程管理，非 IPC 协议）。**bun 同时承担开发/构建工具链**（install/test/build 一体化，无第二运行时）。pkg/SEA 分发仅保留给 Node 备降路径（§3.3/§3.4）。

### 3.3 ⚑ Node 备降路径（v2 保留；触发条件与操作手册）

Node 不再是默认推荐，但作为**保险路径整链保留**——一旦 bun 上游窗口关闭（见 §4.5 TODO 判定），随时可切：

- **触发条件**（任一）：
  1. bun#35690 长期不合并或 registerHooks 实现与 cordis 所需语义不兼容（§4.5 TODO-1 判定）；
  2. cordis 官方放弃「公开 loader hooks」方向（#87/#85 关闭且无后续，[gh-c87/gh-c85]），生态 plugin-hmr 永远只能吃 Node internal；
  3. bun compile 分发在 M0 PoC 中证实无法满足插件动态加载（R1 高危分支）；
  4. 团队/社区插件作者对「dev 模块级热替换」形成硬需求，且 bun 窗口期体验（插件级重启）不可接受。
- **备降操作手册**（原 v1 结论仍有效，[t1 §4/§7.2]）：生产宿主 = Node 24 LTS（**锁 ≥24.12** 避 loader v1/v2 分类坑，[t1 §4.3]）；跑 Cordis + loader + include +（dev）plugin-hmr；loader.internal 用 `node-addon-require-builtin` 原生桥免 `--expose-internals`（每平台 optional 二进制，[t1 §4.2]）；宿主以 `@yao-pkg/pkg`（Tauri 官方 Learn 路径）或 Node SEA 编 sidecar；Node 24 原生 type-stripping 跑纯注解 `.ts`（enum/参数属性需 `--experimental-transform-types` 或预编译，[t1 §3.6]）。
- **双宿主兼容策略**：代码层保持「同一 Cordis 代码库 + 同一插件 API」即可双跑（t1 实测同代码双运行时跑通，[t1 §3]）；差异只在 dev 热更新工具链（§2.4）与分发形态。切换成本 ≈ 宿主启动脚本 + CI 打包矩阵，插件生态不受影响。

### 3.4 版本锁定与已知坑（⚑ v2：bun 主线为主，Node 备降要点保留）

**bun 主线**

| 坑 | 事实 | 规避 | 依据 |
|---|---|---|---|
| bun 谎报 `process.versions.node` = 26.3.0 | loader 版本门禁被「骗过」→ 误判有 internal（实际无） | 以 `process.versions.bun` 判别运行时（[t1 §3.1]）；宿主启动时显式检测 bun 能力位（internal 是否可用）并决定 HMR 开关 | [t1 §3.1/§3.3] |
| `--expose-internals` / 原生桥在 bun 均不可达 | internal 模块不存在；addon 读不到 Node 上下文（"Unsupported/no-context"） | 不依赖 internal；L2 走上游窗口追踪（§4.5）或插件级重启降级 | [t1 §3.3] |
| bun 无 ESM 依赖图（无 ModuleJob.linked） | L2 窗口期降级只能插件级重启，不能模块级热替换 | dev 降级粒度 = 插件级（§2.4 L2 窗口期降级）；watch 映射模块→Entry | [t1 §3.5] |
| bun compile 对外部插件目录动态 import 是已知未决项 | 插件市场按需安装 = 运行时加载外部目录；bun#11732（open）证实非静态可分析动态 import 需 `--include` 类旗标 | **M0 PoC 必测项**（R1）：compile 产物能否动态 import 外置插件目录 + 加载插件自带原生/依赖；备选「骨架 compile + 插件外置目录运行时加载」 | [gh-11732]；[t1 §7.3] 引申；R1 |
| Cordis loader/HMR 版本演进 | 上游在 Node 24 loader 形状上迭代（#105 修复 v1/v2 误判，[gh-c105]）；bun 兼容依赖 registerHooks 落地 | 锁 bun ≥ 合入 #35690 的版本（或按 §4.5 追踪表逐步升级）；cordis/loader 版本进 M0 回归 | [gh-c105]；[gh-35690] |

**Node 备降部署要点**（v1 结论保留，切 Node 时启用；[t1 §4]）

| 坑 | 事实 | 规避 | 依据 |
|---|---|---|---|
| loader v1/v2 分类 | rc.6 按 major≥24 一律标 v2，但 Node 24.0–24.11 实际形状 v1（无 `getOrCreateModuleJob`）；上游 main 已改 shape 检测 | 锁 **Node ≥24.12**，或升级含 shape 检测的 loader 版本 | [t1 §4.3]；[gh-c105] |
| 免 `--expose-internals` | 生产不该开 `--expose-internals`（暴露内部全局）；`node-addon-require-builtin` 原生桥可免旗标 | 依赖 addon（每平台 optional 二进制，进打包矩阵）；或 dev 期开旗标 | [t1 §4.2/§7.3] |
| Node 24 type-stripping 子集 | enum/参数属性/namespace 默认拒绝 | 插件规范禁这些语法或预编译（esbuild/tsc）；推荐「预编译 + 直跑纯注解」双轨 | [t1 §3.6] |
| pkg/SEA 动态性 | 「插件目录运行时 import」与原生 addon 在 pkg 虚拟 FS 下的行为未验证 | **M0 PoC 必测项**：pkg 化宿主能否动态 import 外部插件目录 + 加载 addon | [t1 §7.3] |

---

## 4. 落地路线与风险清单

### 4.1 里程碑路线（每阶段有可验证产出）

| 阶段 | 内容 | 验证产出 | 关键风险预演 |
|---|---|---|---|
| **M0 PoC（先决）** | ⚑ **bun 主线 PoC**：bun 1.4.x 跑 Cordis+loader+include；`.ts` 插件装配；配置热增删（L1）；watcher + L2 窗口期降级（插件级重启）跑通；`bun compile` 单文件 sidecar 化后**动态 import 外置插件目录**验证（对应已知未决项 #11732）；WebView↔宿主 IPC smoke。并行备降验证（低成本）：Node 24.12+ 同代码跑 + pkg 动态性 spot check | PoC 报告：bun 三问三答（compile 后动态 import 插件目录 / L1+L2 降级实测 / 分发体积与启动）+ Node 备降 spot check 结论 | §3.4 bun 坑表 + R1（#11732）；若 bun compile 动态 import 失败 → 评估「宿主骨架 compile + 插件外置目录运行时加载」边界（R1 缓解） |
| **M1 壳与生命周期** | Tauri 壳（托盘/单实例/快捷键/通知/对话框）+ sidecar spawn/supervise + 51 重启协议 + 优雅停机 + 动态端口 | 壳↔宿主↔WebView 全链路跑通；杀宿主自动拉起 | IPC 帧协议、重启时序竞态 |
| **M2 插件机制 + 配置热** | EntryTree 语义完整落地；启停/改配置即时生效；插件 SDK v0（effect 纪律模板 + 防泄漏硬约束，§2.4）；access **声明 + warn 观测**（执行层挂 #13 会话身份/分级授权） | 插件市场 mock：装/卸/升级 = 重启；启停/配置 = 即时；**⚑ t11 泄漏回归测试：插件装卸 N=100 次后内存回到基线（±容差）**——宿主打点 registry.size / 监听器计数 / heapUsed，装卸前后对比 | Fiber 副作用回收不全导致的重启泄漏（[t2 §2.5]）；模块级变量泄漏（§2.4 t11 硬约束） |
| **M3 前端扩展契约** | ⚑ v4 React 前端插件 entry/slot/data 广播契约（定稿 §4.4）+ 版本化资源加载 + prod 刷新路径 | UI 插件示例：注册面板 + 数据推送 + 刷新生效 | 前端热契约无现成框架（[t2 §5.3-14]）；React 化自研成本靠 AI 辅助摊薄（§4.6） |
| **M4 重能力插件与市场** | C 类插件子进程 runner（dll/Overlay/崩溃隔离/滚动替换）；自建市场：索引/短名/manifest/签名校验/原子替换 | dll 示例插件跨重启存活（自热）；市场端到端（含防投毒演练） | 市场后端运维；签名体系（[t2 §5.3-12]） |
| **M5 分发与更新** | ⚑ bun compile sidecar 全平台矩阵 + tauri updater（壳 + sidecar 版本对齐）+ 插件源多镜像回退 | 三平台安装包升级演练 | sidecar 二进制与壳版本耦合（风险 R2）；**L2 上游窗口状态复核（§4.5 TODO-1/2）决定 M5 是否切 Node 备降** |

### 4.2 风险清单

| # | 风险 | 影响 | 概率 | 缓解 | 依据 |
|---|---|---|---|---|---|
| R1 | ⚑ **宿主可执行（bun compile / pkg/SEA）虚拟 FS 不支持插件目录动态 import + 原生/依赖加载**（bun 侧为已知未决项 #11732，open） | M0 后推翻分发方案 | 中 | M0 先行验证（bun compile + pkg 双侧）；备选：插件目录外置宿主旁 + 启动扫描注册；或宿主保持源码运行、仅壳做便携封装（运行时捆绑进包） | [t1 §7.3]；[t1 §7.1]（bun compile 动态性受限）；[gh-11732] |
| R2 | **sidecar 二进制与壳版本耦合/平台矩阵膨胀**（宿主可执行 × win/mac/linux × arch + 可选原生依赖二进制） | 发布复杂度高 | 中 | externalBin 版本化命名 + tauri updater 同时更新壳与 sidecar；可选原生依赖用 optionalDependencies 平台解析；CI 矩阵产物化 | [t1 §4.2/§7.3] |
| R3 | **插件安全边界不足**：dll 插件 = 宿主全权（koishi 无沙箱先例） | 恶意/带毒插件窃取登录态、动系统资源 | 高 | 信任分级（1.4）+ access 白名单（manifest 能力声明 → 运行时校验）+ C 类子进程隔离 + 市场签名校验（发布者签名防投毒）+ insecure 标识与官方不背书（[t2 §4.4]）+ 权限确认 UX（koishi authority 4 等价物，[t2 §5.1-5]） | [t2 §0.5/§4.4/§5.2-9/§5.3-12] |
| R4 | **HMR 运行时边界问题**（官方也有：局部重载粒度、回滚、无法停用等历史 issue，[t2 §3.5/§3.6]） | dev 体验不稳定 → 作者流失 | 中 | L2 限定 dev；plugin-hmr 三段式回滚 + 失败降级整宿主重启提示；超时兜底（loader.exit 51）；把已知边界写进插件文档 | [t2 §3.2/§3.5/§3.6]；[t1 §7.3] |
| R5 | **前端插件热契约自研成本**（⚑ v4 已定 React：无 koishi 现成 slot 注入框架，需自建 React 化契约） | M3 延期；作者上手门槛高 | 高 | §4.4 契约最小化 + React 化（portal/context + 成熟模板 shadcn/TanStack）+ 文档/模板/脚手架；选型已定稿（D-5），AI 辅助摊薄自研成本（§4.6） | [t2 §5.3-14] |
| R6 | **koishi 插件 ≠ VRCX-K 插件直接兼容**（服务命名、config schema、console API 不同） | 「社区插件生态」预期错位 | 高 | 定位明确：**复用它山之石而非二进制兼容**——VRCX-K 插件跑在 Cordis 层但暴露 VRCX-K 专属服务契约（friend/log/photo/overlay/VR 等）+ 专属市场；兼容层（若未来要做 koishi 插件适配）需 adapter 映射 ctx 服务，单独立项 | [t2 §4/§5] 全篇生态差异 |
| R7 | **Cordis rc 版本漂移 / 双宿主形状差异**（rc.6 与上游 shape 检测差异；bun 兼容依赖 registerHooks 落地，[gh-35690]） | 升级踩坑 | 中 | 锁定经 PoC 验证的版本组合（cordis 4 rc.x + loader 版本 + ⚑ bun ≥ #35690 合入版或 Node ≥24.12 备降），升级走 M0 回归 | [t1 §4.3]；[gh-c105]；[gh-35690] |
| R8 | **WebView 平台差异**（Windows WebView2 为主 vs koishi 浏览器环境） | 前端插件跨平台不一致 | 中 | Tauri 多 WebView 抽象；前端契约按 WebView2 能力基线声明（特性检测 + 降级） | [t2 §3.4] 前端机制 |
| R9 | ⚑ **bun 上游窗口期风险**：#35690 合并不确定（DRAFT、单作者 cirospaciari）；cordis#87/#85 未合；#41168 证实 bun 现版 loader hooks 缺失会破坏 Cordis（无限重启）；窗口期 dev 体验=L2 降级（插件级重启，非热替换） | bun 主线 L2 长期不可用；作者 dev 体验折损 | 中高 | §4.5 追踪表按触发条件定期复核（TODO-1/2 判定）；窗口关闭即切 Node 备降（§3.3）；窗口期以插件级重启（L2 降级机制）+ UI 明示兜底 | [gh-35690]；[gh-27369]；[gh-41168]；[gh-c87/gh-c85] |

### 4.3 架构决策记录（ADR 摘要——供评审拍板）

| ID | 决策 | 选项 | 依据 |
|---|---|---|---|
| D-1 | ⚑ **生产宿主 = Bun 1.4.x 全链主线（bun compile 单文件分发）**；L2 代码 HMR 归入 bun 上游窗口追踪（§4.5）；**Node 24 LTS（≥24.12）保留备降**，触发条件见 §3.3/§4.5 | （旧）Node 24 作生产宿主 | 用户拍板 bun 全链（技术偏好 + 性能 + 单文件）；bun 承载 L0/L1/L3 + L2（窗口期降级）实测可用（[t1 §3/§5.2/§5.3]）；compat-patch 作 cautionary 证据提示需兼容垫片 + 禁 HMR（[gh-patch]）；L2 缺口由 bun#35690/cordis#87 双上游窗口收敛（[gh-35690]；[gh-c87]），窗口期插件级重启降级（§2.4/§4.5）；Node 备降保底（§3.3，[t1 §7.2]） |
| D-2 | ⚑ **宿主分发 = Tauri 官方 sidecar（externalBin + tauri-plugin-shell）+ `bun compile` 单文件宿主**；不依赖 tauri-plugin-js | 依赖/自研 tauri-plugin-js；pkg/SEA（Node 备降时启用） | 成熟度不足（bus factor=1，[t1 §6.2]）；官方路径已覆盖（[t1 §6.3]）；bun compile 分发体积/启动优（§3.2） |
| D-3 | **分级热更新承诺**：装卸/升级=秒级重启；启停/配置=即时；UI=前端刷新；后台服务=可恢复+自热；dev 源码=L2（⚑ bun 主线下为上游窗口期功能，窗口期=插件级重启） | 承诺运行时真热装卸 | koishi 事实无真热装卸（[t2 §1.2]）；四层机制齐备才是完整体验（[t2 §1.4]） |
| D-4 | **插件安全 = 信任分级 + access 白名单 + C 类子进程隔离 + 市场签名** | 照搬 koishi 无沙箱模式 | VRCX-K 插件带 dll/进程能力（[t2 §5.2-9/§5.3-12/§5.3-13]） |
| D-5 | ⚑ v4 **UI 框架定稿 = React**（推翻 v3「Vue 倾向」） | React vs Vue3 | 见 §4.4.1 决策记录：团队两框架都不熟 → 纯 AI 编程场景选 **React**（训练语料 ~11x Vue，口径=npm 周下载量 react 1.72亿/vue 1560万，§4.4.1 → AI 生成质量/成功率更高、「抄作业」更方便）；前端插件契约 slot/热加载仍自研（[t2 §5.3-14]），框架只决定注入模型形态 |
| D-6 | ⚑ v4.1 **通信协议 = kkrpc 三通道**（脸⇄脑 kkrpc/ws、脑⇄手 kkrpc/stdio **双向桥**、脸⇄手 Tauri IPC）；「大脑-双手-脸」职责 + **stdio 双向**（Cordis 调 Rust 要系统能力，Rust 反向调 Cordis 要业务/命令宿主） | 自研 RPC 薄层；Rust 字节中继；单向 stdio | kkrpc 成熟（174 stars、双 transport、Rust interop、官方 tauri-demo，[gh-kkrpc] 附录 A）；kkrpc/stdio 本质全双工（两端 RPCChannel 均可 expose+call）；避免自研协议维护成本；ws 保留多客户端可能性（§4.8） |

### 4.4 UI 选型决策与前端插件扩展契约（⚑ v4 定稿：React）

#### 4.4.1 选型决策记录（v3「Vue 倾向」→ v4 拍板 React）

前置事实（[t2 §3.4/§5.3-14]）：koishi 控制台 = Vue3 + Element Plus + Vite；`ctx.slot()`/`ctx.action()`/`DataService` 是 Vue 组件注入模型，**React 生态没有现成的等价「插件槽」框架**——选 React 意味着前端插件契约（slot 注入/热加载/数据广播）要自研。v3 曾据此倾向 Vue。

**⚑ v4 反转理由（本团队 AI 编程现实）**：

| 维度 | Vue 3 + Element Plus | **React（v4 选定）** |
|---|---|---|
| 团队熟练度 | 都不熟（无存量偏好） | 都不熟（**同一起点** → 框架差异失去「团队熟练」权重） |
| AI 编程效率（决定性） | 训练语料相对少 | **React 训练语料 ≈ Vue 的 11 倍**（口径：npm 周下载量 2026-09 react ≈1.72 亿 vs vue ≈1560 万 ≈ 11.0x——以下载量为「生态活跃度/训练语料」的代理指标，下载量≠语料量但强相关；数字经 t10 reviewer 独立核验 npm API：react 171,637,376 / vue 15,608,415 = 11.0x；纯 AI 编程 + 联网检索场景：语料多 → 生成质量/成功率/少走弯路显著占优） |
| 抄作业（参考开源） | koishi 控制台可抄 | **React 生态成熟项目多得多**（shadcn/ui、TanStack、electron-vite-react 模板等），抄作业更方便 |
| 社区插件作者门槛 | 低（koishi 作者多为 Vue） | 中高（契约自研，作者需学 VRCX-K slot API）——**这是选 React 的代价，接受** |
| 前端插件契约 | koishi 四件套可平移 | 自研（entry/slot/data/refresh 等价物，语义参照 koishi 但注入模型 React 化） |
| 与宿主机制契合 | 无差异（契约在宿主侧） | 无差异 |

> **数据来源行（⚑ t11 补）**：「React 语料 ≈ Vue 11x」口径 = npm registry 周下载量（2026-09，代理指标）：react 171,637,376 vs vue 15,608,415 = 11.0 倍——经 t10 reviewer 以 npm API 独立核验。下载量≠训练语料量，但作为生态活跃度的代理与语料规模强相关；AI 编程效率差异据此判断。

**结论：⚑ v4 定稿 React。** 判定逻辑：团队两框架都不熟 → 「降低作者门槛/复用 koishi console」的 Vue 优势无法兑现（团队不会比作者更熟 Vue，且自研契约工作量相同）→ 决定性变量变成 **AI 编程效率**（本项目重度 AI 辅助 + 联网）→ React 语料 11x 优势胜出。前端插件契约自研成本（原 R5 风险）保留，但选 React 后由 AI 辅助 + 成熟 React 模板摊薄。

#### 4.4.2 前端插件扩展契约（React 化，VRCX-K 自建）

- 宿主侧 API ≈ `addEntry({dev, prod})` + `refresh('entry')` 广播 + DataService push（[t2 §3.4] 语义平移）；前端侧 React 等价物 ≈ 插件清单注册 + 组件挂载点（slot 概念用 React 的 portal/context 实现）+ 订阅数据（[t2 §3.4]）。
- 经 kkrpc/ws 通道：宿主 entry 广播 → React 拉新插件资源 → 局部刷新（对应「仅前端刷新级」，§2.2 类别二）；prod 静态资源版本化 URL + 缓存控制（[t2 §5.3-14]）。
- UI 插件渲染隔离：iframe 受控桥或模块 federation 二选一（M3 PoC 定）；slot 注册信息存宿主（随 entry 广播），渲染代码走前端模块加载器。
- **与「仅前端刷新级」热更新关系**：契约须让「UI 插件变更 → 前端重载该插件资源」独立于后端（§2.2 类别二）。

### 4.5 ⚑ bun 上游追踪 TODO（v2 新增；负责人 + 触发条件）

> 事实基线（gh API 实证 2026-09-06，[gh-*] 见 §5）：
> - **oven-sh/bun#35690**：`node:module: implement synchronous module.registerHooks() (+49 tests)` — cirospaciari，**DRAFT、open、未合并**（2026-07-25 开，2026-08-22 更新）。实现 Node 23+ 同步 module customization hooks：resolve/load 链、shortCircuit、virtual specifiers、hook.deregister、node: 内建观察等——**正是 Cordis loader/HMR 走公开 API 所需的能力面**（对照 [t1 §2.1/§2.4] 的 internal 依赖清单）。
> - **oven-sh/bun#27369**：`Bun does not support module.registerHooks`（open，2026-02-23）— 配套追踪 issue。
> - **oven-sh/bun#11905**：`node:module.register does not exist`（open 于 2024-06-16，2026-08-26 仍在更新）— register/registerHooks 缺失的源头 issue。
> - **oven-sh/bun#41168**（MonshinYu，2026-09-02 开，closed as dup of #11905）：`node:module.register / Node-internal ESM loader hooks are not implemented in Bun, breaking frameworks like Cordis` — **bun 官方承认未实现 loader hooks 会破坏 Cordis 类框架**（profile-boot 的 loader 失效检查永不 invalidation → 无限重启循环/高 CPU/OOM）；作者即 compat-patch 作者，与 [gh-patch] 同源互证。
> - **oven-sh/bun#34174/#34171**：registerHooks 具名导出相关（**created 2026-07-14 / closed 2026-08-13**，导出面已补，为 #35690 铺路；#34171 closed as duplicate）。
> - **oven-sh/bun#11732**（open，2024-06-09，terrablue）：`bun build --compile`: include non-statically analyzable dynamic imports with a flag — **bun compile 无法打包非静态可分析动态 import 是已知未决项**（建议 `--include` 旗标，同 Deno 方案）；对 VRCX-K = M0 必测「compile 产物动态 import 外置插件目录」的上游依据。
> - **MonshinYu/dsh-bun-compat-patch**（2 stars，2026-08-18 建，2026-09-02 推送）：DSH on Bun 实证——`stripTypeScriptTypes` 用 `Bun.Transpiler` 重实现；**Cordis 服务端 HMR 以 env-gated guard（`DSH_BUN_COMPAT_DISABLE_HMR`）禁用**，理由正是「Bun 缺 Node-internal ESM loader hooks」。⚠ **cautionary evidence（反向证据）**：证明 bun 可跑 Cordis 系宿主但**需兼容补丁 + 必须禁 HMR**——支持 t1「核心可跑/HMR 不可用」实证，不作可行性背书。
> - **cordiverse/cordis#87**（closed completed 2026-08-20）：`hmr: replace --expose-internals dependency with public loader hooks` — 官方立项方向；被 PR #85 取代（fix/hmr-internal-contract，closed **未合并** 2026-09-05）。→ cordis 官方已意识到 internal 依赖是技术债，但**迁移尚未落地**。
> - **cordiverse/cordis#105**（closed 2026-09-03）：loader v1/v2 形状误判修复 — Node 24 loader 形状仍在演进。

| # | 监控项 | 负责人 | 触发条件 | 动作 |
|---|---|---|---|---|
| TODO-1 | **bun#35690（registerHooks）合并状态** | 架构负责人 | ① 合并进 bun 主线 → ② 发版（bun ≥ X.Y）→ ③ M0 回归 | 合并后：M0 PoC 升级 bun 版本，验证 cordis loader 能否经 registerHooks 拿到等价 internal 能力；能 → L2 从「窗口期」转「可用」，接生态 plugin-hmr 或自研薄层 |
| TODO-2 | **cordis 改用公开 loader hooks（#87/#85 后续）** | 架构负责人 | cordis/loader 发版声明支持 registerHooks 或公开 hooks | 升级 cordis/loader 版本 → M0 回归；与 TODO-1 互为充分条件（bun 提供 API + cordis 消费 API 才闭环） |
| TODO-3 | **bun#27369 / #11905 / #41168 状态** | 架构负责人 | 状态变更（close/标记 wontfix/长期停滞） | 每里程碑复核一次；若 #35690 停滞而 #27369/#41168 活跃 → 评估社区 fork/补丁路线；#41168 是「bun 官方承认破坏 Cordis」的权威标记（[gh-41168]） |
| TODO-4 | **窗口期 L2 降级机制落地（dev 插件级重启）** | 宿主工程师 | bun 主线启动即做（不等上游） | §2.4 L2 窗口期降级：watcher → 模块 URL→Entry 映射 → dispose → 重 import → restart；UI 明示「已重启插件 X」（粒度=插件级）；C 类插件走子进程滚动替换 |
| TODO-5 | **dsh-bun-compat-patch 模式评估**（⚠ cautionary：其 in-place patch + kill -9 脏状态风险已在正文提示——评估前先认定这是「有代价的补丁层」而非干净方案） | 架构负责人 | bun 窗口期超过一个里程碑（M2 后仍无 #35690） | 评估借鉴其「preload 补丁层」（stripTypeScriptTypes 重实现 + HMR env-gated 禁用）自建 VRCX-K 兼容垫片；注意 in-place patch 在 kill -9/断电下残留脏状态的运维成本 |
| TODO-6 | **bun compile 分发动态性复核（#11732 追踪）** | 宿主工程师 | M0 PoC（R1 必测） | compile 产物动态 import 外置插件目录（bun#11732 open，已知未决）→ 决定分发形态（全包 / 骨架 compile + 插件外置）；#11732 若合入（--include 旗标）则 M0 重测 |
| TODO-7 | **窗口关闭判定（切 Node 备降）** | 架构负责人（上报队长） | TODO-1 停滞 ≥2 里程碑 且 TODO-2 无进展 且 社区作者对 dev 热替换有硬需求 | 执行 §3.3 备降：Node 24 ≥24.12 + pkg 分发 + plugin-hmr；双宿主代码兼容，切换成本≈CI 矩阵 + 启动脚本 |

**降级方案与追踪的关系**：TODO-4 是 bun 主线在 L2 窗口期的**默认 dev 体验**（不是临时补丁），其存在使 TODO-1/2 不再阻塞主线推进——即使上游永远不合，VRCX-K 仍以「插件级重启 + 明确 UI 提示」交付可用 dev 循环（对照 koishi 社区对「配置热重载粒度变成插件级」的真实反馈，[t2 §3.5]：插件级重载是可接受的 UX）。TODO-7 是保险丝：窗口长期关闭才切 Node，避免沉没成本。

### 4.6 ⚑ v4 团队技能策略（React 不熟 + AI 主力写码的应对）

背景事实：团队对 React/Vue 均无存量熟练度；本项目（绝对重写）将重度依赖 **AI 编程 + 联网检索**作为主力生产方式。

| 风险 | 应对 |
|---|---|
| 团队 React 不熟，裸手写 React 慢/易错 | **默认 AI 生成 + 人工 review**：AI 的 React 训练语料 11x Vue（§4.4），生成质量/成功率显著更高；团队只负责架构决策、契约定义、code review、验收——不裸手从零写 UI |
| AI 生成代码需「抄作业」参照 | 选 React = 可参照生态最成熟：shadcn/ui（组件）、TanStack Query（服务端状态，天然契合 kkrpc/ws RPC）、electron-vite-react / Tauri + React 模板；Vue 生态同类参照少一个量级 |
| 团队补基础成本 | **分层补齐**：UI 层（React 基础：组件/hooks/状态）由成员按需学（AI 辅助下学习曲线可接受）；架构/契约层（kkrpc 服务边界、插件 slot 契约）由架构师定义、AI 实现——团队不依赖「精通框架」才能推进 |
| 质量保障 | code review 纪律 + AI 生成代码必须过类型检查/lint/测试（bun test / vitest）；关键路径（IPC 契约、插件加载）由架构师写契约测试 |
| 防「AI 幻觉架构」 | 所有接口契约先文档化（kkrpc API 类型、entry/slot schema），AI 按契约实现——契约即真相（contract-first），不是让 AI 自由发挥 |

**结论**：选 React 的核心动因是**保住 AI 生产效率**（团队两框架都不熟时，AI 语料多寡成为决定性变量）；团队技能策略 = 「React 基础 + AI 主力写码 + contract-first + review 纪律」，不要求团队先精通 React 再开工。

### 4.7 ⚑ v4 产品功能范围分层初稿（VRCX 核心功能 × M0-M5 映射）

VRCX 核心功能分层（按交付顺序与归属），映射里程碑（§4.1）：

| 档 | 功能范围 | 说明 | 映射 |
|---|---|---|---|
| **首版（v1.0 必须）** | 登录（VRChat 账号）、好友列表/状态、世界/实例信息、日志查看（本地 VRCX 日志）、基础 UI（React 外壳 + 三栏布局）、插件宿主跑通（装/卸/启停/配置）、市场最小闭环 | 核心体验 + 插件机制地基；对应「可重启级 + 启停配置即时」 | M0-M3 产出 |
| **后续（v1.x）** | 收藏/历史、通知推送（系统通知经双手）、照片/文件管理、Overlay（进阶）、更多平台 API 集成（group/avatar 等）、UI 插件生态完善（slot 契约定型）、市场正式化（签名/审核） | 高频功能补齐 + 生态工具链完善 | M4-M5 产出 |
| **交社区（插件市场开放后）** | 各垂直插件：VR 工具、聊天增强、数据看板、主题/皮肤、第三方服务桥（discord/直播间等）；**重原生能力插件（dll/Overlay）** 由社区按 T2 沙箱规范提交 | 社区插件生态目标兑现；官方只维护宿主 + 平台 + 核心插件 | M4 市场开放后持续 |

**分层原则**：
- 首版 = 平台地基（宿主 + 插件机制 + 最小功能闭环），先让「插件能跑」再谈「插件丰富」。
- 后续 = 官方把 VRCX 桌面主功能补到可用，同时把插件开发体验（SDK/文档/脚手架）做顺。
- 交社区 = 官方让出垂直功能给社区插件，自身聚焦宿主稳定、市场治理、安全审核（对应 §1.4 信任分级与 R3 缓解）。
- 与分级热更新的关系：首版功能以「可重启级 + 配置即时」为主；后续随 UI 插件契约成熟逐步启用「前端刷新级」；后台服务类（Overlay/长连）自 M4 起按 T2 沙箱 + 子进程滚动重启交付。

### 4.8 ⚑ v4 多客户端可能性备注（当前不实现）

- **架构预留**：业务主通道选 **kkrpc/ws**（非 Tauri 私有 IPC）使「大脑 = Cordis 宿主」天然是**本地服务**形态——同一 API 面未来可被其他客户端复用。
- **可能方向**（仅记录，不排期）：① **Web 客户端**（浏览器连本机宿主 ws，需暴露端口 + 更强鉴权/CSRF 防护）；② **移动客户端**（手机连桌面宿主，需局域网 + TLS + 配对）；③ **第二桌面窗口/多窗口**（同机多 WebView 连同一宿主）。
- **当前决策：不实现**。首版只服务 Tauri 内嵌 React（脸）；kkrpc/ws 仅监听 127.0.0.1 + 会话 token（§1.3）。多客户端是选 ws 而非纯 Tauri IPC 的**期权价值**，不在首版范围内付出额外工程（不抽象通用网关、不做外部鉴权体系）。
- 风险提示：若未来真要 Web/移动客户端，需补「外部访问鉴权 + 端口暴露安全模型」，属独立立项（记录于 R9 同类「预留但当期不做」）。
- ⚑ **2026-09-11 补充**：该缺口现由 [`host-sessions.md`](host-sessions.md) 承接（**需求记录，未排期、未立项**）——记录宿主侧缺什么、集成在哪个 choke point、以及"持久凭据必须独立于每次启动的 token"这条推论；移动端整体方向见 [`mobile-feasibility.md`](mobile-feasibility.md)（**移动端 = 第三端，脑留在桌面**）。本节「当前决策：不实现」**不变**。

---

## 5. 证据索引（结论 → t1/t2/gh 依据）

> 证据标签: [t1] runtime-research.md · [t2] ecosystem-research.md · [gh-*] = t5/t7/t9 阶段 gh API 实证（2026-09-06），均见 §4.5 事实基线 / 附录 A。gh 实证明细: [gh-35690] oven-sh/bun#35690（registerHooks，DRAFT open）、[gh-27369] bun#27369（open）、[gh-11905] bun#11905（open）、[gh-41168] bun#41168（closed dup of #11905，官方承认破坏 Cordis）、[gh-34174/34171] bun#34174/#34171（closed，created 2026-07-14 / closed 2026-08-13）、[gh-11732] bun#11732（open，compile 非静态动态 import 未决）、[gh-patch] MonshinYu/dsh-bun-compat-patch（**cautionary evidence**：bun 可跑但需补丁+禁 HMR）、[gh-c87] cordis#87（closed completed，superseded by #85）、[gh-c85] cordis#85（closed unmerged）、[gh-c105] cordis#105（closed）、[gh-kkrpc] kunkunsh/kkrpc（174 stars，ws+stdio 双 transport + interop/rust + examples/tauri-demo，详见附录 A）。

| 本方案结论 | 位置 | 证据 |
|---|---|---|
| 架构方向成立、有生产先例 | §0.2 | [t1 §8] DSH Desktop 先例 |
| ⚑ bun 全链可行（L0/L1/L3 + L2 窗口期降级）+ 核心/loader 实测 | §3.1/§3.2/§2.3 | [t1 §3/§5.2/§5.3]（正向实证） |
| ⚑ L2 缺口 = bun 上游窗口期（#35690/#27369/#11905/#41168/cordis#87） | §2.3/§3.1/§4.5 | [gh-35690]；[gh-27369]；[gh-11905]；[gh-41168]；[gh-c87/gh-c85] |
| ⚑ compat-patch = **cautionary evidence**（bun 可跑 Cordis 系宿主但需兼容补丁 + 必须禁 HMR；in-place patch 有 kill -9 脏状态风险） | §3.1/§3.2/§4.5 TODO-5 | [gh-patch]（反向证据，与 [t1 §2.4/§3.3] 同向） |
| ⚑ bun compile 动态 import 缺口 = 已知未决项（#11732 open）→ M0 必测 | §3.1/§3.4/§4.1 M0/§4.2 R1/§4.5 TODO-6 | [gh-11732] |
| ⚑ Node 备降路径（原 v1 推荐保留为备降） | §3.3/§3.4 | [t1 §4.1/§4.2/§3.6/§7.2] |
| loader v1/v2 版本坑 → Node 备降锁 ≥24.12 | §3.4 | [t1 §4.3]；[gh-c105] |
| bun 结构性缺 Node ESM 内部机制（现期无 internal） | §2.3/§3.1 | [t1 §2.4/§3.3/§5.2]；[t2 §2.4/§3.2] |
| 「bun 打包 Node 运行」不成立 | §3.1 案 C | [t1 §7.1] |
| 装卸/升级=重启、启停/配置=进程内热（koishi 事实） | §2.1/§2.2 | [t2 §1.2/§1.3/§1.4/§2.2/§2.3] |
| Fiber/effect 可逆副作用纪律 | §2.4 | [t2 §2.5] |
| dev 源码 HMR = plugin-hmr 三段式（Node 备降可用；bun 窗口期=L2 降级机制插件级重启） | §2.3/§2.4/§4.5 | [t1 §2.4/§5.2/§5.3]；[t2 §3.2/§3.3]；[gh-35690] |
| 前端扩展 = entry/data 广播 + Vite HMR；koishi 是 Vue3 无 React 等价 | §2.2/§4.4 | [t2 §3.4/§5.3-14] |
| tauri-plugin-js 成熟度不足；替代=官方 sidecar + bun compile/pkg | §0.5、§3.2 | [t1 §6.2/§6.3] |
| 无 JS 沙箱生态默认；VRCX-K 须自建权限/隔离/签名 | §1.4、§4.2 R3 | [t2 §4.4/§5.2-9/§5.3-12/§5.3-13] |
| 桌面无 npm → 内置包解析/原子替换；市场后端自建 | §2.2、§4.1 M4 | [t2 §5.2-8/§5.3-12] |
| 升级带重启提示 UX；authority 4 门槛等价物 | §1.5、§4.2 R3 | [t2 §4.5/§1.2/§4.4] |
| 后台服务自热/0dt 局部借鉴 | §2.2 类别三 | [t2 §5.3-15]；[t1 §5.3] |
| HMR 边界风险（官方 issue、论坛实证） | §4.2 R4 | [t2 §3.5/§3.6] |
| 宿主可执行（compile/pkg）动态性风险 → M0 必测（bun 侧 #11732 open） | §3.4、§4.1 M0、§4.2 R1 | [t1 §7.3/§4.4/§7.1]；[gh-11732] |
| ⚑ v4/v4.1 通信 = kkrpc 三通道（脸⇄脑 ws / 脑⇄手 stdio **双向桥** / 脸⇄手 Tauri IPC）+ 大脑-双手-脸 | §1.1-§1.3、附录 A | [gh-kkrpc]；[t1 §6.3]（tauri-plugin-js 教训 → 系统代理不解析业务）；v4.1 双向修正见 §1.1 读图要点 |
| ⚑ v4 UI = React（AI 语料 11x + 抄作业 + 团队同起点） | §4.4、D-5 | React 生态自身（npm 周下载 react ≈1.72 亿 vs vue ≈1560 万 ≈11x，reviewer 独立核验 2026-09；shadcn/TanStack/electron-vite-react 等成熟参照）；⚠ 官方 kkrpc tauri-demo 为 Svelte 5 前端非 React（附录 A 明示，其 stdio 接入方式可参照但 React 化契约无官方 demo）；[t2 §5.3-14]（契约自研项不变） |
| ⚑ v4 团队技能策略（AI 主力 + contract-first + review） | §4.6 | 本轮定稿（AI 编程现实） |
| ⚑ v4 功能分层（首版/后续/交社区 × M0-M5） | §4.7 | 本轮定稿（VRCX 产品范围） |
| ⚑ v4 多客户端预留（kkrpc/ws = 期权，当前不实现） | §4.8 | 本轮定稿 |

---

## 附录 A：kkrpc 采用记录（⚑ v4）

> 作者: architect（t9）
> 日期: 2026-09-06
> 状态: 采用（v4 定稿）

### A.1 决策

VRCX-K 三通道通信协议统一采用 **kkrpc**（`kunkunsh/kkrpc`，[gh-kkrpc]）：
- 脸 React ⇄ 脑 Cordis：kkrpc/ws（WebSocket transport）
- 脑 Cordis ⇄ 手 Rust：kkrpc/stdio（stdio transport + Rust interop）——⚑ v4.1：**双向通道**，两端 RPCChannel 均可 expose + call（Cordis 调 Rust 要系统能力；Rust 反向调 Cordis 要业务信息/命令宿主/请求插件启停），非单向代理
- 脸 React ⇄ 手 Rust：Tauri IPC（不走 kkrpc——Tauri 原生 command/event 已足够且是 UI↔系统 的标准路径）

### A.2 事实基线（gh API 实证 2026-09-06）

| 项 | 值 |
|---|---|
| 仓库 | kunkunsh/kkrpc（174 stars，created 2024-11-17，pushed 2026-08-13，活跃维护） |
| 定位 | 「TypeScript-first RPC for runtimes, processes, windows, workers, desktop IPC, and message buses」——两端点经类型安全代理对象互调（远程函数/嵌套方法/属性/构造器/回调参数） |
| transport 面 | iframe / web worker / **stdio（Node/Deno/Bun）** / **WebSocket** / HTTP / Electron / **Tauri** / chrome extension / 消息总线（Kafka/RabbitMQ/Redis/NATS） |
| Tauri 支持 | `src/entries/tauri.ts` + `src/transports/tauri.ts`；官方 **`examples/tauri-demo`**（src-tauri + **Svelte 5 前端** + 多运行时 backend：`TauriShellStdio` + `@tauri-apps/plugin-shell` spawn；⚠ 前端是 Svelte 非 React——其 stdio 接入模式可参照，React 化 UI 无官方 demo 可抄，[t1 §6.3] 的 tauri-plugin-js 用的是同一 kkrpc 生态） |
| Rust interop | **`interop/rust`**（src/lib.rs + tests/stdio.rs + tests/ws.rs）——Rust 侧实现 kkrpc，stdio + ws 双 transport 可用。⚑ 双向实证（t11 reviewer gh API 源码核验）：lib.rs 提供**对称的 Client（call/get/set）与 Server（register_method/handle）**，同一 StdioTransport 上两端都能发起调用、都有回调支持——**协议无「主动方」限制**，印证 §1.3 双向桥语义 |
| 多语言 | interop/go、interop/python、interop/swift、interop/node |
| 测试 | packages/kkrpc/__tests__/stdio.test.ts、websocket.test.ts、electron-tauri.test.ts 等 |

### A.3 为什么替代 v1-v3 的「自研薄层 / Rust 字节中继」

- v1-v3 的 IPC 设计（§1.3 旧版）是「Rust 字节中继 JSON-RPC + WebSocket 数据面」——Rust 只透传不解析（[t1 §6.3] tauri-plugin-js 教训的正确部分），但**协议仍要自研**（帧格式、路由、类型化、重连）。
- v4 发现 kkrpc 已成熟覆盖该需求且**有官方 Tauri demo + Rust interop**：直接采用 = 不造轮子，类型安全、双向调用、回调参数、middleware 全免费；Rust 侧 interop 已实现（无需自研 Rust 协议解析）。⚑ v4.1：kkrpc/stdio 的**全双工本质**（两端 RPCChannel 对称 expose+call，interop/rust 的 server/client 对称实现）正是「Rust 主动向 Cordis 汇报/请求」这一需求的协议基础——这也是 v4 早期误记为「单向 Cordis→Rust 代理」后经用户追问修正的原因。
- ws + stdio 双 transport 同库：脸⇄脑（ws）与脑⇄手（stdio）用同一 kkrpc API 抽象，学习/维护成本低；React 前端可复用 kkrpc/browser 入口。
- 多客户端期权（§4.8）：ws transport 使大脑成为本地服务，未来 Web/移动客户端可复用同一协议面。

### A.4 采用风险与缓解

| 风险 | 缓解 |
|---|---|
| kkrpc 单库依赖（174 stars 仍属小众） | 协议层薄封装（自有 transport adapter 模块），若 kkrpc 失维护可换（协议简单：类型代理 + JSON-RPC over ws/stdio）；M0 PoC 先验证三通道端到端 |
| Rust interop 成熟度 | M0 PoC 必测项：interop/rust 的 stdio 通道与 tauri-plugin-shell 管道对接 |
| ws 安全（本地服务形态） | 仅 127.0.0.1 + 动态端口 + 会话 token（§1.3）；不做外部暴露 |
| tauri-plugin-js 混淆 | 注意区分：tauri-plugin-js（HuakunShen，20 stars，不采用）是「Rust 壳 spawn JS 进程」插件；kkrpc（kunkunsh，174 stars，采用）是「协议库」。VRCX-K 用官方 sidecar spawn + kkrpc 做协议，不依赖 tauri-plugin-js 本体（[t1 §6.2/§6.3]） |

### A.5 参照物

- 官方 tauri-demo：https://github.com/kunkunsh/kkrpc/tree/main/examples/tauri-demo
- 官方文档：https://docs.kkrpc.kunkun.sh/（examples/tauri.md、stdio.md、ws.md）
- Kunkun（作者同生态的 Tauri 应用启动器）：kkrpc 在真实 Tauri 桌面产品中服役的证据
