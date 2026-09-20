# 旧工程（`old/main`）数据库层勘察

> **这是什么**：对本仓库 `origin/old/main` 分支（前身工程）数据库层的**只读经验勘察**，产出于 2026-09。
> **为什么在这里**：`.temp/` 是"随时可整目录删除"的区域，而这份成果**曾是唯一副本**。转正以保留结论。

---

## ⛔ 读之前必看：两条红线

### 1. 这些文件**不是**可直接复制的代码

本目录**只含结论与经验**，**不含任何旧代码**（旧代码副本与模型文件**有意未入库**）。

**血统事实**：`old/main` 的根提交是 `2019-08-16 pypy "Initial commit"` —— 它是 **VRCX 官方（MIT）的 fork 链**（VRCX → VRCX-Luo → VRCX-jirai → 本 org），**大部分代码不是本 org 写的**。

⇒ **任何复制行为都必须先确认对应文件完全由本 org 作者编写**。见 `05-provenance.md` / `08-repo-wide-provenance.md`。

### 2. `old/main` 与当前 `rewrite` **无共同祖先**

```
git merge-base --all origin/old/main origin/rewrite   → 退出码 1，无输出
```

⇒ `rewrite` 是**全新起点的重写**，与旧工程**历史不相连**。
⇒ `git cherry-pick` / `git merge` **不会自然而然地搬运任何东西** —— 取用**必然是显式复制文件内容**（**可审计、无法意外发生**）。

---

## 材料索引

| 文件 | 内容 |
|---|---|
| **`00-SUMMARY.md`** | **总纲**：经验点总表 + 交叉印证 9 节 + 血统摘要 + **14 条待决问题**。**先读这份** |
| `01-interface-contract.md` | 接口契约：47 抽象方法、`onTableChange` 表级变更订阅、引擎注册表、演进纪律 |
| `02-sqlite-implementation.md` | SQLite 实践：PRAGMA 取值、重试与退避参数、事务语义、并发写测试 |
| `03-migration.md` | 迁移系统：`.map` 声明式格式、幂等、**金样等价性测试方法论** |
| `04-data-model.md` | 42 张表按 10 领域、命名约定（`_pri_`/`_pub_`）、⚠ ERD 可用性警告 |
| `05-provenance.md` | 逐文件作者台账（`src/services/database/`） |
| `06-captain-verification-sqlite-concurrency.md` | **队长实测**：单连接并发事务撞车 + `busy_timeout` 锁升级绕过 |
| `07-dotnet-org-authored.md` | **本 org 原创**：`MySQL.cs`/`PostgreSQL.cs`（66 commits）、C# 侧事务、测试策略 |
| `08-repo-wide-provenance.md` | **全仓**：~~91~~ **75** 个 org 从零创建 / 1335 共同历史（⚠ 2026-09 修正：原 91 含 `docs/` 12 个 rename/copy 误判） |
| `09-pg-transaction-breakage.md` | **PG 静默失效的完整故事** + 7 条可推广判据 |

---

## 血统分类（务必按此判断）

判定方法：**上游各 ref 是否存在该路径**（比"谁提交过"更强）。

| 类 | 含义 | 数量 |
|---|---|---|
| **A** | **上游四 refs 均无此路径** ⇒ **本 org 从零创建** | **~~91~~ 75**（其中 `src/services/database/` **34**、`Dotnet/` **17**、`docs/architecture/` **~~31~~ 19**）<br>⚠ 2026-09 修正：`docs/` 的 31 实为 **19 纯净 A + 12 rename/copy 自上游**（`d10b0cc0` 搬运），见 `08` §3.3 |
| **C** | 上游也有 ⇒ **共同历史** | 1335 |
| **B** | 上游有路径但该文件作者全 org | 0（方法学结果：上游覆盖绝大部分树） |

**上游 refs**：`VRCX/master` · `VRCX-Luo/master` · `VRCX-jirai/master` · `VRCX-onkel/main`（均已验证可解析）。

### ⚠ A 类的边界（`08` §5 已如实标注）

**"路径是 org 建的"不证明"内容无上游血统"**。已知两个 rename/inline 例外：

- `configRepository.js` —— 路径 A 类，但 `--follow` 溯源到 **2020-11-02 pypy**
- `SQLiteAdapter.js` —— inline 自曾含 pa/copilot/yixijun 提交的 `sqlite.js`

⇒ **A 类只表示"这个文件路径由我们创建"，不表示"整个文件都是我们写的"。** 逐文件裁定仍需人工。

⚠ **补充（2026-09，PV-5a）**：`--follow` 判据**只跟 rename 链，对 inline 合流是盲的** —— `SQLiteAdapter.js` 的 `--follow` 实测「全部 org」，却仍被上表列为例外。⇒ **"follow 干净"只能证明"没有 rename 继承"，不能证明"内容无上游血统"。**

---

## 两个未合并分支：browse（单写多读）模式 —— **归档，不适用**

`old/main` 上有两个**从未合并**的功能分支，实现同一件事：

| 分支 | commits | 内容 |
|---|---|---|
| `origin/old/feat/browse-mode` | 9 | 设计文档 M1/M2、启动流接线、C# SQLite 只读连接、**`readOnlyGate` Proxy 写入门禁** |
| `1zyao/browse-mode-lease` | 15 | M2/M3：`NodeMode.cs`、`BrowseModeBanner.vue`、UI 置灰、login guard |

**性质：它是被迫的补偿手段。** 起因是**多个进程要打开同一个 SQLite 文件**，所以要拦下除一个以外的所有写者。

**⇒ 对本项目不适用，理由是架构前提不成立**：

- 我们的**宿主即数据枢纽**，**写入口天然唯一**（就在脑里）
- 客户端（脸）**不开库**，因此不存在"第二个写者"可拦
- `ROADMAP §4.1`「脑留在桌面机、手机=脸+手」**保证只有一个脑** ⇒ 这正是**我们不需要 browse 模式的原因**

**⇒ 不纳入 #13（多设备），也不进 roadmap。** 把"如何在多写者架构下打补丁"的经验导入"从设计上就单写者"的架构，只会诱导出一个**不需要的 gate**（且撞 P3 单一真源）。

> 残余价值仅一句：**若将来脑真的可以有多份，才会遇到同类问题** —— 那是**架构级变更**，不属于插件功能范围。

---

## 未入库的（有意排除）

| 内容 | 原因 |
|---|---|
| `_raw/`（17 个旧代码与模型文件） | **旧代码副本**；且模型文档（ERD/DDL/MCD）**四份互相漂移、Mocodo 生成物全是 `VARCHAR(42)` 占位符，不可用** |
| `provenance-inventory.tsv`（194 KB）等原始素材 | 可由脚本重新生成，非结论 |
| `08-*.ps1` 分类脚本 | 工具，非结论 |

**需要重新生成时**：脚本逻辑见 `08-repo-wide-provenance.md` 的方法说明。

---

## ✅ 一处**已调和**的冲突（2026-09 定案，勿再当未决项）

`02` 说单连接并发会「**损坏连接**」；`06` 的实测表现是「**连接留在打开的事务里，可回滚恢复**」。

**两者都对 —— 因为它们不在同一层**：

| 说法 | 层次 | 机制 |
|---|---|---|
| `06`「可回滚恢复」 | **SQLite 引擎层**（bun 单连接） | B 的 `BEGIN` 抛错 → A 永不 `COMMIT` → 连接留在打开的事务里，**可 rollback 恢复，文件不损坏** |
| `02` / `TRANSACTION_DESIGN`「损坏」 | **C# 桥层** | pinned 连接被两事务交错 + 超时回收 / `Dispose` 竞态 → `ObjectDisposedException`，**不可诊断**（原文即写"C# 侧"） |

**对策一致**：**两事务并存是禁止态**，解法都是**串行化**。

> **⇒ 对 `rewrite` 的结论（比"可恢复"本身更重要）**：单连接"可恢复"**但业务语义已经错了**；而我们是**事件驱动的异步宿主**，并发是常态 ⇒ **必须串行化，或使用同步事务 API，不能指望"可恢复"**。

进一步定论所需的实验（桥层复现 / 残留态稳定性 / 锁升级异步复测 / `integrity_check`）**均未执行**，清单在勘察产出里 —— 但**上面的分层解释不依赖它们**：它由两份原文各自的措辞（"C# 侧" vs `bun:sqlite`）直接得出。
