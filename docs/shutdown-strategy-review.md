# 审查结论复核：方案 D 与持久化策略（我的独立验证）

> 本文是**对独立审查报告**（`.temp/review-signals/REVIEW-plan-d.md`，由隔离子会话产出）的**复核记录**。
> 我逐条验证了它的关键断言——**三条源码级断言全部为真**，**一条性能论据为假**。
> 日期：2026-09-17

---

## 0. 结论速览

| 审查断言 | 我的复核 | 判定 |
|---|---|---|
| `index.ts:306-313` 信号处理器在 Windows 是死代码 | ✅ 源码注释自己写着 "SIGTERM is Unix-only" | **为真** |
| `classify_watch` 只认 51，其余一律 `Crashed` | ✅ `host.rs:871-872` 逐字确认 | **为真** |
| `exit(1)` 会烧 storm 计数导致宿主瘫痪 | ✅ `MAX_SPAWN_FAILURES=8` + `note_exit(false)` 走 Crashed 分支 | **为真** |
| 爆炸半径因 `AppExit` latch 而收窄 | ✅ `host.rs:412 latch_app_exit` → `latch_desired(AppExit)`，classify 只在未 latch 路径跑 | **为真** |
| **commit-per-write @ FULL ≈ <2.5s / 5000 行** | ❌ **实测 8 271 ms**（差 3.3 倍） | **为假** |

---

## 1. ✅ 审查推翻了我的方案论证（我接受）

**我的论证**：信号绕过 dispose → dispose 是落盘处 → 让信号走 dispose → 数据安全。

**审查的实测反驳**：

| 用例 | 结果 |
|---|---|
| 已提交 + **硬 TerminateProcess** | **5/5 行存活** |
| 已提交 + 裸 `process.exit(0)` | **5/5 行存活** |
| 在**打开的事务中**被杀 | **0 行，`integrity_check: ok`**（干净回滚） |
| **只在 disposer 里写** + 硬杀 | **0 行（丢失）** |

⇒ **持久性来自 `COMMIT`，不是来自 dispose。**

**这直接推翻我的核心论证**：`W2` 证明**现有 SIGTERM 路径对"已提交"的写入不丢任何东西**。而 disposer 落盘**不增加**持久性——它把"提交即持久"变成"**拆解完成才持久**"，**把边界往错的方向挪了**。

**验收原文是"数据已落盘"（already persisted）**——这是**写入路径**的属性，不是**拆解路径**的属性。我从一开始就搞错了归属。

---

## 2. ✅ Windows 平台事实：我的 probe22 有误读

审查指出（并实测）：

> `child.kill("SIGTERM")` / `("SIGINT")` 在 Windows 上 = **硬 TerminateProcess**，`handlerFired: false`。
> 143/130/137 这些退出码是**合成**的（`128+signum`）——**SIGKILL 行为完全相同，证明是同一机制**。
> **probe22 的 `delivered: true` 是误读**：它只证明 `kill()` 没抛异常。

**我承认这个误读。** 我的 probe22 把"kill 调用成功"当成了"信号送达"。这个错误**导致我误判了方案 A 的可行性**——真正的结论比我以为的更彻底：**Windows 上两个信号处理器根本不执行**。

审查还确认：**壳在 Windows 上从不向宿主发信号**（`process_tree.rs` 走 `TerminateJobObject` → `taskkill /T /F`）。

---

## 3. ✅ "第二次信号"必要 —— 且实现比我想的更险

审查用实测回答了这个问题（R3 trace）：

```
SIGBREAK handler-enter #1
  first: before await            ← 异步清理开始
handler#1 sync part returned (did not block)
SIGBREAK handler-enter #2        ← 在 #1 的 await 期间触发
handler#2 -> process.exit(1)
EXIT-event code=1
```

`first: AFTER await` **从未打印**。

⇒ **信号处理器之间不做串行化**——**latch 是必需的**，而朴素实现会在 `COMMIT` 中途 `process.exit(1)`。
并且 **latch 必须独立于 `ctx.signal.begin()`**（强制路径必须能越过那道门）。

**这条我原本只是"觉得需要幂等状态机"，审查把它变成了有实测支撑的硬要求。**

---

## 4. ⚠ 性能论据为假（我的独立复核）

审查推荐"commit per unit + WAL + `synchronous=FULL`"，并引用 D3 数据称 "~5000 单行事务 <2.5s"。
**但审查自己把 D3 标为 inconclusive**，所以我重测（`.temp/verify-durability-perf.ts`）：

```
N = 5000 rows

synchronous = FULL:
  commit per write                     8271 ms       604 writes/s
  commit per 100                        122 ms     41010 writes/s

synchronous = NORMAL:
  commit per write                      197 ms     25392 writes/s
```

| | 审查报告 | **我的实测** |
|---|---|---|
| commit-per-write @ FULL | <2 500 ms | **8 271 ms** |
| 倍差 | — | **3.3×** |

**含义**：

- **审查推荐的策略依然可行**（604 writes/s 对用户规模的数据引擎够用）
- **但代价被低估了 3.3 倍**——如果将来要写批量数据（如日志导入），**commit-per-write 会成为瓶颈**
- **`NORMAL` 快 42 倍**，代价是**不抗掉电**（但抗进程死亡）⇒ **这给了第三条路**：`NORMAL` + 关键写入显式 `FULL`

---

## 5. 综合判断（我的结论）

**接受审查的核心结论，但对推荐方案的参数做修正。**

### 5.1 持久化策略：改用写入路径，而非拆解路径 ✅ 接受

- **主策略**：写即提交（`COMMIT` 即持久）+ WAL
- **disposer 仍要用**，但**只用于非持久性清理**（句柄、临时文件、WS 服务关闭）——那是它擅长的事
- **验收口径要改**：#27 的"优雅退出时数据已落盘"应重新表述为**"数据在写入时即已落盘"**——否则这条验收在测**它测不到的东西**

### 5.2 `synchronous` 的取值：建议 **NORMAL**，而非 FULL

审查推荐 FULL。我实测差异 **42 倍**，而这个项目的实际权衡是：

| 模式 | 抗进程死亡 | 抗掉电 | 5000 行耗时 |
|---|---|---|---|
| `FULL` | ✅ | ✅ | 8 271 ms |
| **`NORMAL`** | ✅ | ❌ | **197 ms** |

⇒ **建议 `NORMAL` 为默认**（WAL 模式下它抗进程崩溃/被杀），**关键写入**（如 schema 版本、凭证）**单独提升为 FULL**。
理由：本项目的主要丢失风险是**进程被杀**（壳强杀、崩溃），不是**掉电**；用 42 倍的代价去买很少发生的场景不划算。

### 5.3 信号改动：降级为 **POSIX-only 纵深防御** ✅ 接受

- **Windows 上不做任何信号相关工作**（处理器是死代码，写了也没用）
- POSIX 上保留优雅停机，**用独立的 exit code**（**不能用 1**）
- **`exit(1)` 必须避免**——`classify_watch` 会当成崩溃，**累计 8 次宿主永久停在 `Failed`**

### 5.4 需要新定的：**强制退出的 exit code**

审查指出 `exit(1)` 会被 `Crashed` 分支吃掉。⇒ 需要一个**被壳识别的专用码**（类似 51 但语义是"未完成优雅停机"）。
**这是新契约**，需要壳与宿主两侧同时改。

---

## 6. 采纳与不采纳

| 审查建议 | 我的裁定 |
|---|---|
| 用 `COMMIT` 而非 disposer 保证持久性 | ✅ **采纳**（实测支撑） |
| 保留 disposer 做非持久性清理 | ✅ 采纳 |
| 信号改动降级为 POSIX-only | ✅ 采纳 |
| 用独立 exit code 而非 1 | ✅ 采纳 |
| 要求**短事务**（不只是事务） | ✅ 采纳——审查指出"事务"是必要非充分 |
| `synchronous=FULL` | ⚠ **修正为 NORMAL + 关键写入 FULL**（42 倍代价） |
| "commit-per-write 很快（<2.5s）" | ❌ **不采纳该论据**（实测 8.3s） |

---

## 7. 仍未解的（审查也标为 unknown，我认同）

- Windows 控制台事件（Ctrl-C）的投递可靠性（审查探针结果不一致：C1/C4 触发，C3 4/4 与 R2 未触发）
- 真实 POSIX SIGTERM（本机是 win32，无法测）
- 掉电场景下的 `synchronous=NORMAL`（本机无法测）
- 30s 看门狗在实践中是否真会到达

---

## 8. 方法论收获（值得记档）

**这次审查之所以有效，是因为隔离了会话记忆**——审查者**没有继承我的结论**，因此它去测了"持久性到底来自哪里"这个我**默认成立、从未验证**的前提。

⇒ **教训**：我的 probe22 把 `kill()` 不抛异常读成"信号送达"，**这个误读直接导致我建议了一个在 Windows 上不成立的方案**。
**探针报出的字段名（`delivered`）不能被当成事实**——要问"这个字段到底证明了什么"。

---

## 关联

- 审查报告：`.temp/review-signals/REVIEW-plan-d.md`（9 个探针 + 原始日志）
- 我的性能复核：`.temp/verify-durability-perf.ts`
- 原始勘察：`docs/shutdown-and-persistence-findings.md`（probe21–23）
- 受影响 issue：**#27**（数据引擎，策略变更）· **#12 / #2**（验收口径需重新表述）
