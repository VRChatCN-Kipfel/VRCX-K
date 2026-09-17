# 优雅停机与落盘：宿主的两条退出路径（F1.1 前置勘察）

> 状态：**已实测**（`docs/probes/probe21`–`probe23`，可复跑）。
> 目的：为 [#27 F1.1 数据引擎](https://github.com/VRChatCN-Kipfel/VRCX-K/issues/27) 的验收项「优雅退出时数据已落盘」提供**事实依据**，并指出现状里**会丢数据的路径**。
> 日期：2026-09

---

## 0. 一句话结论

**壳用的停机路径是安全的（disposer 会执行）；但 `SIGTERM` 路径会绕过 dispose，直接退 0 —— 在这条路径上落盘的数据会丢。**

---

## 1. `bun:sqlite` 在 compile 态可用 ✅（probe21）

分发形态是 `bun build --compile`，所以"源态能跑"**不足以**证明数据层可行。

| 能力 | 源态 | **compile 态** |
|---|---|---|
| `:memory:` 建表/读写 | ✅ | ✅ |
| **磁盘持久化**（关闭后重开读回） | ✅ | ✅ |
| **WAL**（`PRAGMA journal_mode = WAL`） | ✅ | ✅ |
| **事务**（`db.transaction()`） | ✅ | ✅ |

实测产物：`bun build --compile docs/probes/probe21.ts` → **82.1 MB**，运行输出与源态一致，`isCompiledExecutable: true`。

⇒ **F1.1 的"选定 SQLite 接入方式"（#27 任务 1）可以定为 `bun:sqlite`**，零依赖、零原生模块、compile 安全。

---

## 2. ⚠ 落盘逻辑**必须写在插件 fiber 内**（probe23）

`gracefulStop`（`host/src/lifecycle.ts:84-98`）遍历 `ctx.registry` → `runtime.fibers` → `fiber.dispose()`。所以**只有挂在 fiber 上的 effect 才会被回收**：

| 注册位置 | 进 registry？ | disposer 会执行？ |
|---|---|---|
| `ctx.effect()` **直接注册在根 ctx** | ❌ `registrySize: 0` | ❌ **静默不执行** |
| **插件 fiber 内**的 `ctx.effect()` | ✅ `registrySize: 3` | ✅ **执行** |

⇒ **数据引擎的落盘必须写在插件的 `ctx.effect` 里**，不能写在宿主根 ctx 上——写在根 ctx 上**不报错、不执行**，症状是"数据偶尔少一截"。

**这也再次确认 `gracefulStop` 本身是对的**（不是 bug）：真实插件都跑在 fiber 里。

---

## 3. ⚠⚠ `SIGTERM` 绕过 dispose，直接退 0（probe22）

宿主有**两条**退出路径，行为**不等价**：

| 触发 | 路径 | disposer | 退出码 |
|---|---|---|---|
| **stdin 断开 / stdio `stop` RPC** | `stopOnStdinLoss` → `gracefulStopWithTimeout` → `ctx.signal.begin()` | ✅ **执行** | 0 |
| **`SIGTERM`** | `process.exit(0)`（`host/src/index.ts:310`） | ❌ **不执行** | 143（128+15，被信号杀） |
| **`SIGINT`** | `process.exit(0)`（`index.ts:313`） | ❌ 同上 | — |

实测（probe22，子进程 + 真 SIGTERM）：

```json
{ "gracefulStop": { "log": ["disposer-registered","DISPOSER-RAN"], "disposerRan": true },
  "sigterm":      { "delivered": true, "exitCode": 143, "childSawDisposer": false } }
```

**现状评估**：

- **壳走 stdin 路径** ⇒ 桌面端正常退出**不受影响**
- ⚠ 但 **Unix 下 supervisor 停子进程的标准手段就是 SIGTERM**，而 `AGENTS.md`/ADR 里 "51 重启协议" 之外的停机语义在 Unix 侧尚未明确
- ⚠ `SIGINT`（Ctrl-C）在 **dev 态**是常用的停法 ⇒ **开发时改数据可能丢**

**⇒ 这是 #27 落地前必须决定的一件事**（见 §4）。

---

## 4. 待决：`SIGTERM`/`SIGINT` 是否应走优雅停机

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（建议）** | 信号处理改为调用 `stopOnStdinLoss(ctx, …)`（同一条优雅路径），并保留一个**硬超时**兜底 | 停机变慢（受 `ctx.signal` 的 deadline 约束，已有机制）；需要确认壳不会因超时而重复拉起 |
| **B** | 保持直接 `process.exit(0)`，**数据引擎改为不依赖 disposer 落盘**（如每次写事务即落盘 / 定期 checkpoint） | 数据层变复杂；"退出时落盘"的验收项**名不副实** |
| **C** | 只让 `SIGINT` 走优雅（dev 便利），`SIGTERM` 保持立即退出 | 折中；但 Unix supervisor 仍会丢数据 |

**建议 A**：机制**已经存在**（`gracefulStopWithTimeout` + `ctx.signal` 的协作 deadline），改动小、语义统一；且 #12 的验收项本来就是"**优雅**退出时落盘"。

---

## 5. 对 #27 的具体含义

| #27 任务 | 本勘察的输入 |
|---|---|
| 选定 SQLite 接入方式 | ✅ **`bun:sqlite`**，compile 态已实证（probe21） |
| schema v1 + 版本表 | 无影响 |
| 迁移机制 | 无影响 |
| 数据访问层 | 无影响 |
| **优雅退出时落盘** | ⚠ **落盘必须挂插件 fiber 的 `ctx.effect`**（probe23）；且需先定 §4 的信号语义（probe22） |
| 存储位置解析 | 无影响（`$VRCXK_USER_DIR`） |

**另注**：#27 未提及插件形态。数据引擎按 `packages/base-*` 形态落地（§5.1.1），并带自己的 `.vrcxk/manifest.json`——它是第一个真实的 base 包用户。

---

## 复跑

```
bun run docs/probes/probe21.ts                        # bun:sqlite 源态
bun build --compile docs/probes/probe21.ts --outfile .temp/probe21.exe && .temp/probe21.exe   # compile 态
bun run docs/probes/probe22.ts                        # 两条退出路径对照
bun run docs/probes/probe23.ts                        # effect 归属
```

> ⚠ `docs/probes/` 解析不到 `host/node_modules`，故探针**显式**引用 `../../host/node_modules/...`（本仓库既有约定，见 probe11）。
