# 数据引擎的五个故障病历：F1.1 设计输入

> 状态：**知识提取**（来源为 `old/main` 的 `docs/architecture/TRANSACTION_DESIGN.md` 与本 org 的修复链提交）。
> 目的：为 [#27 F1.1 数据引擎](https://github.com/VRChatCN-Kipfel/VRCX-K/issues/27) 提供**"不读到就会重蹈覆辙"**的设计输入。
> 日期：2026-09 · 来源勘察：`.temp/recon-legacy/db-layer-knowledge.md` §2
> **血统**：`TRANSACTION_DESIGN.md` 与修复链提交**全部为本 org**（详见 §5）。本文件**只提取知识，不含旧代码**。

---

## 0. 为什么要有这份文档

这五条**不是设计偏好，是已经付过代价的故障**。它们的共同特征：**症状与根因之间隔着一层，凭直觉写一定会错**。

| # | 故障 | 一句话 | 若不读会怎样 |
|---|---|---|---|
| 1 | PG 事务断裂 | 池化后 BEGIN/INSERT/COMMIT 落在三条连接 | 写出**整体不原子但每条语句都成功**的事务 |
| 2 | Timer 排队竞态 | `Timer.Change(Infinite)` 不取消已排队回调 | 偶发 `ObjectDisposedException`，**不可诊断** |
| 3 | `busy_timeout` 不对称 | SQLite 5000ms vs PG/MySQL 15/30s | "对齐三引擎" → 故障暴露慢 6 倍 |
| 4 | JS 单线程假设失效 | `await` 交还事件循环 → 两事务并存 | 并发下**误判嵌套**或**损坏连接** |
| 5 | 串行队列自身死锁 | 内层等外层、外层等内层 | 永久挂起 |

---

## 1. 病历 1：PG 事务断裂（BEGIN/INSERT/COMMIT 落在三条连接）

**症状**：事务内多语句各自成功，但整体不原子；`commit` 后数据可能没写进去。

**根因**：C# 包装层每次 `ExecuteNonQuery` 都 `_dataSource.OpenConnection()` 借新连接 + `using` 还池 ⇒ BEGIN、INSERT、COMMIT 三次调用借到**三条不同物理连接**，连接 A 的事务随还池被 Npgsql 自动 reset。

⚠ **关键**：文档原文明确写了这是**"照搬 Npgsql 现代池化示例、没补『持连接事务 API』"** —— **不是 PG/Npgsql 的引擎限制**。

**修法**：三引擎统一 `_pinned`（`ConcurrentDictionary<long, TxHolder>`）+ `BeginTransaction()` 借连接并 pin + `connId` 尾参路由；SQLite/MySQL 用 `_pinnedConnId` 单槽（单连接无需多槽）。

**为何这么修**：池化的收益（事务期间其他查询走独立连接不被阻塞）要保留，就必须把"事务内的 SQL"显式 pin 到同一物理连接。

> **⇒ 可推广的判据**：**连接池化把"会话状态"从"连接隐式携带"变成"必须显式绑定的数据"。** 任何引入池化的层，都要审计一遍"哪些状态原本靠连接对象隐式传递"。

---

## 2. 病历 2：Timer 排队竞态 → `ObjectDisposedException`

**症状**：事务 idle 接近超时上限时偶发 `ObjectDisposedException`，事务不可诊断地失败。

**根因**：**`Timer.Change(Timeout.Infinite, -1)` 不会取消已排队、即将执行的回调。** 若 Timer 回调恰好在 SQL 执行期间已被线程池排队，回调仍会在 SQL 执行时拿 `_txLock` 并 `Dispose` 连接。

**修法**：`TxHolder.InFlight`（int 引用计数）＋ `TimedOut`（bool）。执行 SQL 前 `Interlocked.Increment`、finally `Decrement`；超时回调见 `InFlight > 0` 不立即回滚、置 `TimedOut = true` 返回；SQL 的 finally 自查 `TimedOut` 后自行 `TryRemove + Timer.Dispose + CleanupTx`。

**为何这么修**：触发条件极苛刻（idle 近上限 + Timer 已排队 + 恰好发 SQL + SQL 跨过回调瞬间），**但后果不可诊断** ⇒ 防御值得。

> **⇒ 最佳实践**：事务内长时间非 DB `await` 前应调 `keepAlive()` **提前续命**，而非"卡着超时点回来打卡"（临近超时才发 SQL 会进竞态窗口）。
> **⇒ 可推广的判据**：**"取消"类 API 往往只保证"不再新触发"，不保证"已排队的不会跑"。** 凡有"取消 + 资源释放"组合，都要问一句"已排队的回调还持有资源引用吗"。

---

## 3. 病历 3：`busy_timeout` 三引擎不对称（并解释**为何不该对齐**）

**症状**：若把三引擎的超时对齐，SQLite 场景会出问题。

**根因（概念分层，不是数值差异）**：

| 引擎 | 值 | **等待的是什么** |
|---|---|---|
| SQLite | `busy_timeout = 5000` ms | **本地文件锁**（写事务 ms 级；5s 足够。仍超时 = 死锁/长事务，应快速失败而非卡 UI 60s） |
| PostgreSQL | `Timeout=15` / `CommandTimeout=30` | **网络建连 / SQL 执行** |
| MySQL | `ConnectionTimeout=15` / `DefaultCommandTimeout=30` | 同上 |

**修法**：**刻意不对称**。PG 与 MySQL 之间对称（注释逐条互指），且 `MinimumPoolSize=1` 保活（异地 200ms+ 延迟不重建连接）。

**为何这么修**：**对称是"同一概念层级内"的对称；跨层级对齐（让 SQLite 也等 30s）会让故障暴露慢 6 倍。**

> **⇒ 可推广的判据**：**数值相似 ≠ 概念同层。** 看到两个超时值不同，先问"它们等的是不是同一种资源"，再决定要不要统一。

---

## 4. 病历 4：JS 单线程假设在异步下不成立 → 两事务并存（#27）

**症状**：两个独立异步流（WS feed 写入、用户对话框刷新）并发调 `withTransaction`；后到者见栈非空被**误判"嵌套"抛错**，或放行后**两个事务同时存在**。

**根因**：**`await fn()` 把控制权交还事件循环 ⇒ 时间交错。** "JS 单线程 = 无并发打断 = 栈操作原子"这个假设**在 async 下不成立**。

**修法**：`_txTail` **串行 Promise 队列** —— `withTransaction` append 到链尾，前一个 commit/rollback 后才执行下一个。**同步调用栈嵌套**（在另一个 `withTransaction` 的 fn **同步段**内再调）立即抛错（`_txInFn` 只覆盖同步前缀）。

**为何这么修**：把竞态从"运行时撞车/损坏"变成"排队等待" ⇒ **同一 adapter 实例同时只有一个事务**，原子性与并发安全兼得。

**修复链**（全部 org）：`b5486313`（#27 加串行化）→ `1566485e`（加超时）→ `f00fb9a2`（超时纳入 try/finally 防队列毒化）。

> **⇒ 对 rewrite 的直接含义**：**我们是事件驱动的异步宿主，并发是常态**（比旧工程更甚）。F1.1 要么**串行化**，要么**用同步事务 API**——`bun:sqlite` 的 `db.transaction()` 自带 savepoint 重入语义，是比手写队列更省的选择。

---

## 5. 病历 5：串行队列自身死锁（内层等外层、外层等内层）

**症状**：事务 fn 内 `await` **之后**再调 `withTransaction` → **永久挂起**。

**根因**：内层入队等待外层释放；外层要等内层返回才释放队列 ⇒ 互相等待，`prev` 永不 resolve。

**修法**：`await prev` 用 `Promise.race` + `_txWaitTimeoutMs`。**默认 60000ms，刻意对齐 C# `TX_IDLE_MS = 60000`** —— 前序事务可经 `keepAlive` **合法**存活至 60s，**等待超时必须 ≥ 该上限，否则排队者被误判为死锁**。默认值历史：`b5486313` 30s → `005791d3` 改 60s。

**为何这么修**：当前生产 10 处 `withTransaction` 调用点均无嵌套，死锁是**将来误用的防御性兜底**；但超时把"永久挂起"转成"可 catch 异常"，并防队列毒化。

> **⇒ 可推广的判据**：**队列的等待超时必须 ≥ 上游资源的合法最大持有时长**，否则"合法的慢"会被误判成"死锁"。这两个常量是**耦合的**，改一个要审另一个。

---

## 6. 附加病历：借用计数泄漏（#30）

**症状**：`GetPoolStats` 计数永久泄漏（借用计数与借出不在同一临界区，TOCTOU）；借出失败时计数未释放。

**修法**："实际入册才计数"的最终核对：`BeginTransaction` 的 finally 里 `if (!_pinned.ContainsKey(connId)) Decrement`（`6f12a1d6`）。

> **⇒ 可推广的判据**：**计数/登记必须原子，失败路径要回滚计数。** 适用于任何资源池——**包括 rewrite 将来可能做的连接复用缓存**。

---

## 7. 跨引擎契约：两个必须钉住的例外

来源：`test/contract/adapter-contract.js`（org 原创，t7 判定可复制）。**六组 describe 覆盖跨引擎不变语义，但最有价值的一条没被测住。**

### 7.1 ⚠ DDL 回滚在 MySQL 上不成立（**只活在注释里，零断言**）

原文（`transaction semantics` 组一条测试的注释）：

> DML rollback is cross-engine invariant (**unlike DDL rollback, which MySQL/MariaDB implicitly commits**)

**⇒ 实测确认：这句话在整份文件里只出现两次，都是注释，没有任何测试断言 DDL 回滚行为。**

**对 F1.1 的含义**：写三引擎抽象时，**契约必须是"DML 可回滚"**；若误把 DDL 也纳入回滚承诺，会在 **SQLite 上通过、在 MySQL 上静默错误**。

**⇒ 本文件的存在就是补这个洞**：F1.1 实现时应**为这条补一条真测试**，而不是继续依赖注释。

### 7.2 其余跨引擎不对称

**7.2a 契约文件钉住的**（来源：`test/contract/adapter-contract.js`）：

| 不对称 | 内容 |
|---|---|
| `@` 前缀双写 | 命名参数**带 `@` 与不带 `@` 都要能绑**（同一张表分别用 `{id:1}` 与 `{'@id':2}` 各插一行，两行都要在） |
| `executeNonQuery` 返回值 | DDL 返回 **0**，DML 返回 **affected rows** |
| `insert` 的 `'ignore'` | 重复主键返回 **0**，且**原行不变** |
| `getTableColumns` 形状 | 位置数组 `[cid, name, type, notnull, dflt, pk, hidden]` |
| `upsertPartial` | 首次 insert、二次 update on conflict |
| 事务 DML 回滚 | 见 §7.1（**跨引擎不变量**，DDL 例外） |

**7.2b 引擎实现层的不对称**（来源：`adapter/MySQLAdapter.js` 等，**不在契约文件里**）：

| 不对称 | 内容 |
|---|---|
| `TEXT` 不能作 MySQL PK | 需长度前缀或改用 `VARCHAR(n)` |
| `cookies` / `configs` 的 `value` 列 | 三引擎统一为 **`LONGTEXT`**（旧库列过小会报 `Data too long`，需幂等升级） |

> ⚠ **7.2b 这类不对称最容易漏**：它们不在契约测试里，只体现在具体引擎实现中。F1.1 若只照契约文件写抽象，**会在 MySQL 上撞到列类型问题**。

---

## 8. 血统与出处

| 内容 | 出处 | 血统 |
|---|---|---|
| 五个故障的机制与修法 | `old/main:docs/architecture/TRANSACTION_DESIGN.md` | **A 类**（org 自写；`d10b0cc0` 载入，见 `08` 修正） |
| 契约六组 | `old/main:test/contract/adapter-contract.js` | **A 类**，`RainyN0077` 2026-07-18 原创（t7 判定见 `docs/legacy-recon/ledger`） |
| `EngineAdapter` 基类 | `old/main:src/services/database/adapter/EngineAdapter.js` | **A 类**，`XChen446` 主导（38 提交，全 org） |
| `busy_timeout` 实测 | `docs/legacy-recon/06`（队长实测）+ `02` | 已勘察 |
| 借用计数泄漏 | 修复提交 `6f12a1d6` | **A 类**，`1zyao` |

> ⚠ **本文件不含旧代码**。以上均为**知识提取**；若将来要真正取用旧代码，需先按 `docs/legacy-recon/` 的血统台账逐文件裁定。**注意 PV-5a**：清单准则 ④（`--follow` 干净）**对 inline 合流是盲的**。
