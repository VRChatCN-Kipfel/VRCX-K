# VRCX-K 项目开发约定

> 本文件对 VRCX-K 仓库生效。架构方案全文见 [`docs/architecture-proposal.md`](docs/architecture-proposal.md)（v4.2，评审通过）。
>
> **本文件只放"每次开工都必须知道的"约定与架构规则。** 实测结论、变更日志、任务进度一律不放这里——它们各有唯一副本（见 [§资料地图](#资料地图唯一副本原则)）。改本文件前先读该节的"唯一副本"规则。

# ⛔ 第 0 步：新会话启动立刻同步 GitHub issue（先于一切）

**这是注入到每个新会话的第一条命令：不论用户问了什么、看起来多简单、多像与路线图无关，都必须先执行它——在你回复任何内容、读任何仓库文件、跑任何命令之前。**

## 0.1 先过闸：`gh auth status`（必须先做，不许跳过）

**在拉取任何 issue 之前，先跑 `gh auth status` 并检查退出码**（`exit 0` = 就绪，继续 §0.2；任何非 0 都是环境问题，**停止** → §0.3）。别用 `gh issue view` 去试——未登录时它只笼统报 `To get started with GitHub CLI, please run: gh auth login`（exit 4），白烧一轮。

> ⚠ **不要用 `gh status` 代替**：那是"我的面板"（跨所有仓库的 assigned issues / PR / mentions / 动态），**不是认证检查**。它既会灌进大量无关上下文，退出码也不通用（未登录时它给 4，对着 §0.3 的分类会误判成"未安装"）。认证只看 `gh auth status`。

> 常见误判：`gh issue view` / `gh issue list` 在**无网络**时的报错看着像"仓库配置错误"（如 `none of the git remotes ... correspond to GH_HOST`），**别据此改 remote**——先 `gh auth status` 定性。

> `gh auth status` 非 0 时可能**同时打印另一个 `Active account: false` 的可用账号**（即输出里能看到 `✓ Logged in`）——**别只认退出码，也别只看有没有 ✓**。

> 需要按报错细分（未装 / 未登录 / token 失效 / 网络不可达）时，看 §0.3 的分类与对应处理。

## 0.2 过闸后：拉取 issue（三件事）

1. `gh issue view 1` —— 读「开发路线图」总览与其中「协作方式」。
2. 读与本次任务相关的 M/F 总览 issue：用 `gh issue list --repo VRChatCN-Kipfel/VRCX-K --state all` 查全量
3. 按当前任务下钻到具体 subissue（任何被阶段性subissue继续派生指定的subissue）取**验收标准 / 依赖 / 决策 / 经验以及可能的继续派生的subissue**。

**原因**：项目所有决策点、踩坑、经验不只存在于 `docs/`，也存在于 GitHub 上 #1 及其逐级派生的 subissue 里，且issue内的内容绝对不容许忽略。

**权威顺序**：GitHub issue（#1 及其全部派生）＝ **一等公民，优先级高于本仓库 `docs/` 与本文件**。两边冲突时**以 issue 为准**，并顺手把 `docs/` 改齐，不留第二份不一致的说法。

## 0.3 闸门不通过：立刻停止并汇报（不得开工）

**在拿到 issue 内容之前，不得开始任何工作。凭本地旧状态贸然开工会导致共识不同步，这比停下来更糟。**

汇报必须包含三样：

1. **卡在哪一步**——粘贴 `gh auth status` 的原始输出，不要只说"gh 用不了"。
2. **判定属于哪一类**——未装 / 未登录 / 令牌失效 / 网络不可达（判据：未装＝`CommandNotFoundException`；未登录＝`You are not logged into any GitHub hosts`；令牌失效＝`Failed to log in … using token` / `The token in GH_TOKEN is invalid.`；网络不可达＝连接超时/DNS 失败/`none of the git remotes … GH_HOST`）。
3. **给用户可执行的手动指引**，按类别给出：
   - 未装：给出安装方式（winget/scoop/apt 或 https://cli.github.com），如果条件允许，可以代替用户安装好ghcli，并说明装完要重开会话/重载环境变量。
   - 未登录 / 令牌失效：`gh auth login`，或 `gh auth refresh -s repo`，并提醒需要 `repo` scope。
   - 网络不可达：请用户检查代理/VPN；或请用户**粘贴 #1 及相关 issue 正文**作为替代输入。

> **替代输入可用时也要说清楚**：改用用户粘贴的内容后，要在工作记录里注明"本轮同步来源＝用户手工粘贴，非 gh 实拉"，便于事后核对是否漏读了派生 issue。

---
## 项目结构（三层：大脑-双手-脸）

```
VRCX-K/
├── src-tauri/     ← 双手 · Tauri 2 / Rust 壳（系统代理：托盘/通知/快捷键/对话框）
│   ├── Cargo.toml        Rust 依赖（cargo workspace 成员）
│   └── tauri.conf.json   窗口/打包配置
├── src/           ← 脸 · React UI (Vite 19)
├── host/          ← 大脑 · Cordis (bun) 宿主（业务/插件/服务）
├── Cargo.toml     ← cargo workspace 根（成员 src-tauri）
├── package.json   ← bun workspace 根（含 host）
└── docs/          ← 设计/实测/进度文档（清单见 §资料地图）
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

> `cargo tauri dev/build` 会自动调 `bun run build`（前端），是"壳+前端"的一条指令入口。宿主（Cordis）由壳作为 sidecar 拉起，见 `src-tauri/src/host.rs`。

### JS / Bun 侧

| 命令 | 作用 |
|---|---|
| `bun install` | 装全部依赖（前端 + host） |
| `bun run dev` | 只起前端 vite dev server |
| `bun run build` | 只编前端 → dist/ |
| `bun run dev:host` | 起 Cordis 宿主（host/） |
| `bun run build:host` | 编译 host |
| `bun run typecheck` | 前端 + app + host 三套类型检查 |
| `bun run test` | 前端与 host 测试 |
| **`bun run verify`** | **= typecheck + test + build，提交前必跑** |

### 环境要求

- Rust: stable-x86_64-pc-windows-msvc（rustc 1.97+）
- WebView2（Windows 自带，Tauri 依赖）
- bun 1.4+
- cargo tauri-cli（已装：cargo tauri 2.11.4 / @tauri-apps/cli ^2）
- **GitHub CLI（`gh`）——开发环境必须安装并 `gh auth login`**：**开工前同步决策内容（见文件头）**、上游状态取证（`gh api` 实测标签 `[gh-*]`，见 `docs/architecture-proposal.md` §4.5 / §A.2）、issue/PR 检索与创建都依赖它。
  - 常用拉取：`gh issue view 1`（路线总览）、`gh issue list --repo VRChatCN-Kipfel/VRCX-K --state all`（全量清单；**必须带 `--repo`**，否则报 "No default remote repository has been set"，用 `gh repo set-default` 可一次性修掉）、`gh api graphql` 查原生 subissue 层级。
  - ⚠ **issue 编号会被 PR 占用**：**不能**由 `max(issues)` 推断下一个编号（本轮预算 #14，实际 M2 拿到 **#16**，因 #14/#15 是同日新 PR）。建 issue 前先查 `state=all` 的完整列表。

### 交付前自检

- `bun run verify` 全绿；Rust 侧 `cargo fmt --check` + `cargo clippy -- -D warnings` + `cargo test` 全绿。
- 新增行为**必须有测试钉住**（回归测试优先于断言强度：宁可多写一条会失败的用例，也别把断言放宽）。
- 纯格式化/漂移修复**单独提交**，不与功能 diff 混在一起。

## Git 约定

- **条件 `commit.gpgsign=true`**：在有条件的情况下尽量对所有提交进行GPG签名，如果当前环境不存在GPG签名应当先询问并指引签名方式（签名错误例外）。
- `.gitignore` 只放通用忽略（node_modules/dist//target/ 等）。

## 临时工作区（agent 专用）

- `.temp/`（已 gitignore，**不提交**）是 agent 的临时工作区：探针脚本、临时构建产物、中间实验都放这里，做完即弃，可随时整目录删除。仓库内任何**不打算进 git** 的实验性文件优先放 `.temp/`，别散落在根目录。
- 区分：`.temp/` 是仓库内临时区（随仓库存在但 gitignore）；`.agent-teams/` 等是每机工具状态（`.git/info/exclude`，各机器私有）。
- **要保留**的产物（报告/正式代码/文档）放正常位置（docs/、host/、src/…），不要留在 `.temp/` 里"假装提交"——临时区的东西一旦需要转正，就移出 `.temp/` 再提交。
- **转正触发点**：一旦某产物**被别人引用**——被 GitHub issue 引用、被 `docs/` 引用、或成为后续实现的依据——就**必须立刻移出 `.temp/`**。判断标准是"**是否有第二份副本**"：**`.temp/` 里的东西随时可能整目录删除，不能成为唯一副本**。探针若承担回归基线角色，应转正到 `docs/probes/` 或搬成 `host/tests/` 单测。

## 许可证红线（抄代码禁令）

- **严禁抄 `vrcx-0`（Map1en 系）的任何代码/结构/文件**——它是 **GPL** 协议，复制/改写/照搬其文件会污染本仓库。仅可观察其"产品方向可行性"（界面长什么样、功能有哪些），且须在文档记录为独立设计。我们与它同为"VRCX 能力 + Tauri 重写"是需求同源，架构是独立决策（见 docs/ROADMAP.md §参照）。
- 可安全借鉴（MIT/Apache）：**VRCX 官方**（MIT，功能复刻主参照，能力清单/数据模型思路）、**koishi/cordis**（MIT）、**kkrpc**（Apache-2.0）。
- 任何**GPL/AGPL 项目**的代码/文件一律不得进入本仓库（含引用/复制/改写其结构文件）；只允许行为/能力层面观察参照。
- **进程注入/读游戏内存/Unity 内 UI** 类能力是禁区（官方不背书，ToS 风险），agent 不得实现或建议实现。
- 本仓库自身许可证**待定**（倾向 MIT），决定后补 LICENSE；决定前按宽松许可方向管理借鉴边界。
- 详表见 `docs/ROADMAP.md` §参照与许可证卫生。

## 架构规则（违反 = 隐性坏掉，不报错）

> 下面三条**不是风格偏好**，是"写错了不会立刻炸、但语义已经错"的硬约束。全部有实测依据（见 [§资料地图](#资料地图唯一副本原则) → Cordis 运行时）。

- **能力服务必须 `extends Service`**：`ctx.provide(name, 普通对象)` 提供的方法**完全没有调用者归因**（两个插件调用的结果无法区分），护栏/审计/`access` 声明全都失去落点。**方法一律写成类方法**——写成箭头函数属性会**静默**丢失归因（`caller: null`），命名空间的每个子对象也必须是 `Service` 实例，普通对象字面量同样丢。
- **服务必须"先 provide、后 attach"**：`inject` 是**就绪门不是访问门**——未 inject 的插件照样能读服务，但注入尚未提供的服务的插件会卡在 `PENDING`，provide 后才 `ACTIVE`。（`host/src/index.ts` 的 tray/shortcut 即此模式。）
- **持久性来自 `COMMIT`，不是来自 `ctx.effect()` 的 disposer**：已提交的行即使被**硬杀**也存活；只写在 disposer 里的数据被硬杀时**全丢**。⇒ 数据落盘走**写入路径**；`ctx.effect()` 里只放**非持久性清理**（句柄、临时文件、WS 关闭）。
  配套两条硬事实：① 写在**根 `ctx`** 上的 effect 不进 `registry`、**不报错、disposer 永不执行**（只有插件 fiber 内的会被回收）；② **Windows 上 `SIGTERM`/`SIGINT` 根本不投递**（`kill()` 是硬 TerminateProcess，处理器不触发），那两个处理器在 Windows 是**死代码**。详见 [`docs/shutdown-strategy-review.md`](docs/shutdown-strategy-review.md)。

## 资料地图（唯一副本原则）

> **规则：同一批事实只允许有一个"主副本"。** 发现两份说法不一致时，以主副本为准并删掉另一边——**不要把本文件当第二副本维护**。
>
> **与 GitHub 的关系**：本表管的是 `docs/` 内部的唯一性；**跨源冲突时以 GitHub issue 为准**（理由与同步步骤见文件头）。issue 上做出新决定后，本表指向的 `docs/` 主副本**必须跟着更新**，不能只改 issue。

| 要查什么 | 去哪里（主副本） |
|---|---|
| 架构方案全文（v4.2） | [`docs/architecture-proposal.md`](docs/architecture-proposal.md) |
| **写插件 / 写服务 / 碰 Cordis 前必读** | [`docs/cordis-runtime-findings.md`](docs/cordis-runtime-findings.md) **§0 结论速查**（14 条实测，逐条给探针） |
| 优雅停机与落盘（退出路径、`ctx.effect` 归属、`bun:sqlite`） | [`docs/shutdown-and-persistence-findings.md`](docs/shutdown-and-persistence-findings.md)（probe21–23） |
| **持久化策略与信号处理（含独立审查结论）** | [`docs/shutdown-strategy-review.md`](docs/shutdown-strategy-review.md)（持久性来自 `COMMIT`、Windows 信号不投递、exit code 契约） |
| 插件源 / 索引 / manifest / tag 版本方案 | [`docs/plugin-source-and-index-design.md`](docs/plugin-source-and-index-design.md)（probe14–20 已入档）；目录布局见 [`docs/adr-plugin-layout.md`](docs/adr-plugin-layout.md) |
| kkrpc Rust↔npm 协议互通（M1-4 依据） | [`docs/kkrpc-interop-findings.md`](docs/kkrpc-interop-findings.md) |
| **任务进度 / 里程碑状态 / 决策记录** | GitHub **#1 及其派生 issue**（见文件头；**最高权威**）；`docs/ROADMAP.md` 只是同步过来的概览镜像，冲突以 issue 为准 |
| 可复跑探针（实测证据） | [`docs/probes/`](docs/probes/)（`bun run docs/probes/probeN.ts`）；写/跑探针自身的坑见其 [README](docs/probes/README.md) |

**实测结论的写法**：不要只把结论写进文档——把**探针留在 `docs/probes/`**，并在生产代码注释里引用它（本仓库既有惯例：`host/src/capability.ts` 引 probe8、`host/src/stdio.ts` 引 probe9、`host/tests/plugin-manifest-contract.test.ts` 引 probe20/11）。这样改到那段代码的 agent 会顺着注释找到证据，比"某文档第 N 条"可靠。
