# 09 · 深挖：PG 池化导致的事务断裂——失败模式、发现、修复与可推广教训

> 勘察对象：`origin/old/main`（VRCX 官方 MIT fork 链）的 `Dotnet/PostgreSQL.cs` 连接池事务断裂故事。
> 全部内容来自 `git show origin/old/main:<path>`，只读提取。
> **一句话结论**：这不是「PG 引擎的错」，是 C# 包装层把「每次语句借新池连接」的模式照搬进了事务 API——BEGIN/INSERT/COMMIT 落在三条物理连接上，事务被 Npgsql 的还池自动 reset 而**静默变成 no-op**。修复 = C# 侧 `_pinned` 持连接映射 + connId 路由，JS 侧 `_txStack` 栈式上下文；随后这条线又暴露并修复了滑窗超时竞态、并发串行化、防死锁等 6+ 个二级问题。**这个故事真正的可推广教训不是「要 pin 连接」，而是「静默失效比报错危险、事务语义必须由运行时保证而不是靠调用者记着」**。

---

### 经验点 1：失败模式的精确描述——「BEGIN 在连接 A、INSERT 在 B、COMMIT 在 C」
- **解决什么问题**：建模「连接池 + 每次语句借新连接」这件事为什么会让事务失效。
- **方案（失败模式的精确机制）**：
  - 修复提交 `74fda9b1`（2026-07-25）的提交消息原文是**对失败模式最权威的描述**：
    > 「PostgreSQL.cs 之前每次 `ExecuteNonQuery` 都 `_dataSource.OpenConnection()` 借新连接 + `using` 还池，导致 **BEGIN 在连接 A、INSERT 在连接 B、COMMIT 在连接 C——事务语义断裂（连接 A 的事务随还池被 Npgsql 自动 reset）**。」
  - 修复前的 `ExecuteNonQuery`（`74fda9b1~1`）就是这个模式的直白代码：`using var connection = _dataSource.OpenConnection(); using var command = CreateCommand(connection, sql, args); return command.ExecuteNonQuery();`。
  - 失败链：`BeginTransaction()`（旧版 JS 适配器 `begin()` = `executeNonQuery('BEGIN')`）→ 借连接 A → 发 `BEGIN` → `using` 还池（**Npgsql 检测到连接上有未提交事务，自动 ROLLBACK 重置**）→ 下一次 `INSERT` 借**另一条**池连接 B（无事务上下文）→ 自动提交（PG 每条语句默认 autocommit）→ `COMMIT` 借连接 C（无事务，**静默 no-op 或报 "no transaction"**，取决于驱动）。连接 A 上的事务被 reset 丢弃。
- **证据**：`74fda9b1`（2026-07-25，`git show 74fda9b1 --format=%B -s` 提交消息原句）、修复前 `Dotnet/PostgreSQL.cs` 的 `ExecuteNonQuery` 方法体、`src/services/database/pushEngine.js` 的 HIGH-2 注释（见经验点 4）。
- **与我们的差异**：我们（bun:sqlite 单连接）没有「多条物理连接」，这个具体断裂不存在；但它揭示的「**事务状态绑定在物理连接上**」这一事实对所有引擎都成立——单连接只是让三条语句必然落在同一条连接上，从而掩盖了它。

---

### 经验点 2：症状分析——**最关键的是「静默 no-op」而不是报错**
- **解决什么问题**：评价一个事务 bug 的危险等级，症状决定一切。
- **方案（对症状的精确分类，文档与代码里都有实证）**：
  1. **静默丢事务（最危险）**：`pushEngine.js` 修复前的 HIGH-2 注释白纸黑字写着后果——「**transaction would silently no-op**（事务会静默 no-op）」「every bulkInsert batch autocommits, costing **5-10× throughput**（每批自动提交，吞吐损失 5-10×）」。「静默 no-op」意味着：**BEGIN/COMMIT 全部返回成功，没有任何报错，但原子性保证没了**——批量搬迁中途崩溃会留下半拷贝数据，且没有任何异常提示。这正是「比报错的 bug 危险得多」的样板：**调用方以为有原子性，实际没有**。
  2. **无声的数据语义改变**：非事务路径下每条 INSERT 自动提交，行为与「写了但没提交」在单条语句层面看起来一样，只有崩溃/回滚场景才暴露差异。
  3. **偶发报错（次生）**：视 Npgsql 版本与时机，`COMMIT` 可能抛「no transaction in progress」类错误；但**在最常见的路径上根本不报错**，所以这个 bug 很难被用户报告——它是「看起来一切正常」的潜伏缺陷。
- **代价 / 陷阱**：静默失效的 bug 没有「用户报错」这个发现渠道，只能靠**主动的等价性/原子性测试**或**代码审查读注释**发现（本案例正是后者——见经验点 3）。
- **证据**：`pushEngine.js` HIGH-2 注释（`74fda9b1~1` 版本）原文「the transaction would silently no-op」「every bulkInsert batch autocommits, costing 5-10× throughput vs. a single wrapped transaction (PG fsync per batch)」；`74fda9b1` 提交消息。
- **与我们的差异**：设计验收时「我们要不要事务/回滚」的判据应该加上「**如果没有事务，会怎样静默变坏**」这一问——本案例证明破坏原子性的代价是数据半拷贝且不报错。

---

### 经验点 3：为什么 PG 上致命、SQLite/MySQL 上不致命——「池化借用 + 忘写持连接 API」是 C# 包装层疏漏，不是引擎限制
- **解决什么问题**：核实文档论断「C# 包装层疏漏（照搬 Npgsql 现代池化示例，未补"持连接事务 API"），不是 PG/Npgsql 引擎限制」。
- **方案（核实结论：论断【成立】，但机制要拆开看）**：
  - **引擎层面**：PG 的事务语义（BEGIN/COMMIT、autocommit、连接级事务状态）与 SQLite/MySQL **完全同构**——三引擎的 `BEGIN`/`COMMIT`/`ROLLBACK` 都是连接上的命令（`PGSQL_DESIGN.md` §4.1.14 明说「`BEGIN` 在 PgSQL 合法，同构」）。**引擎不区别对待事务**。
  - **真正的差异在连接管理模式**（修复前）：
    - **SQLite.cs / MySQL.cs（修复前）= 单连接 + `lock(m_ConnectionLock)`**：`m_Connection` 是类字段，`Execute`/`ExecuteNonQuery` 全部 `lock` 串行走**同一条连接**。`BEGIN`/`INSERT`/`COMMIT` 必然落在同一条连接上 ⇒ **事务天然成立**（代价：长查询阻塞健康检查、事务期间的非事务查询隐式混入当前事务——文档点名的两个隐患）。且修复前这两类**根本没有事务方法**，JS 层迁移运行器发的 `BEGIN`/`COMMIT` 字符串走的就是锁内单连接。
    - **PostgreSQL.cs（修复前）= 每次 `_dataSource.OpenConnection()` 借池连接 + `using` 还池**：`89c98f13`（2026-07-19，PG 池化诞生）「移除单 `_connection` 字段改为**每次借池连接**（NpgsqlDataSource 自带池化 max=100, using 自动归还）」。当初移除锁/单连接的决定对普通查询是现代化改进，但**事务语义没有跟着改**——`BEGIN` 也是以 `executeNonQuery('BEGIN')` 的形式借新连接。池化「每次借新连接」= 每条语句一条物理连接 = 事务必然断裂。
  - **倒过来看**：**不是单连接保住了 SQLite/MySQL，而是「单连接」这一偶然结构救了事务**；PG 的池化只是把同一个「忘写持连接事务 API」的疏漏**暴露**了出来。文档「不是引擎限制」的论断成立：如果 SQLite/MySQL 也池化（修复后确实统一池化了），不修一样断。
- **代价 / 陷阱**：「单连接保平安」是**偶然正确**，不是设计保证——本项目后来的 SQLite/MySQL 也池化了（`1c645955` 方案 B 全员现代化），说明当初的"安全"完全依赖实现细节。
- **证据**：`1c645955~1:Dotnet/MySQL.cs`（`lock (m_ConnectionLock)` + 单 `m_Connection` 类字段 + `using var command = new MySqlCommand(sql, m_Connection)`）、`74fda9b1~1:Dotnet/PostgreSQL.cs`（`using var connection = _dataSource.OpenConnection()`）、`89c98f13`（池化诞生提交，消息原句「移除单 `_connection` 字段改为每次 `_dataSource.OpenConnection()` 借池连接」）、`TRANSACTION_DESIGN.md:7`（「这是 C# 包装层的疏漏……不是 PG/Npgsql 引擎限制」）、`TRANSACTION_DESIGN.md:9`（单连接隐患）。
- **与我们的差异**：我们选 bun:sqlite 单连接，恰好落在「单连接保事务」这一侧；但必须意识到这是**与旧 SQLite 相同的偶然结构**，一旦将来多连接/多引擎，历史会重演——这正是要在契约里留防线的理由（见经验点 8）。

---

### 经验点 4：发现过程——不是测试或用户报告，是一段「被接受为已知限制」的注释，搁置了三周
- **解决什么问题**：回答「这种静默 bug 怎么被发现的」，并揭示一个反直觉事实：**团队早就知道，只是当时接受了代价**。
- **方案（有完整提交时间线佐证）**：
  - **Phase 9（2026-07 中旬）已经知道**：`pushEngine.js` 在 `74fda9b1~1`（即修复前）就有一大段 HIGH-2 注释，完整描述了「BEGIN 在连接 A、INSERT 在 B」的机制与「5-10× 吞吐损失」的代价，并明说「**Fixing this requires a C# transaction API that holds a single connection across multiple ExecuteNonQuery calls; that work is deferred beyond Phase 9**」——**修复被显式推迟**，作为「accepted known limitation for Phase 9 minimal scope」。
  - **发现渠道 = 代码审查过程中的注释阅读，而非新测试失败**：没有实证表明有自动化测试当时抓到这个 bug（事务保护测试 `7a6022cb` 是 2026-07-18 写的，跑在 SQLite 内存适配器上——SQLite 单连接语义让它永远抓不到 PG 断裂；PG/MySQL 引擎级事务语义**至今**被文档标注为「测试覆盖空白，待 follow-up 补集成测试」）。
  - **修复时机 = 2026-07-25，PG 池化诞生（07-19）6 天后**：`74fda9b1`（C# 持连接事务 API）+ `26ee17fa`（JS 栈式上下文）＋ `1c645955`（SQLite/MySQL 统一池化事务）在同一天连续落地，配套 TRANSACTION_DESIGN.md。**为什么 6 天后才动手**：Phase 9 只是把 PG 立起来（能查询），事务型消费者（迁移运行器、push 分组事务）真正上 PG 时才感到痛——`fbd5c7bb`（08-08 池上限 100→16）说明 PG 在持续被用。
- **时间线重建**（见文末 `## 失败模式时间线`）：09-18 池化设计时没写持连接 API → 07-19 池化上线、pushEngine 把「静默 no-op」写成已知限制 → 07-25 事务 API 落地（发现**不是**靠测试，而是实现迁移/搬迁事务化时的必然暴露）→ 07-26 起 6+ 个二级竞态修复。
- **代价 / 陷阱**：**「已知限制 + 注释」不等于「被跟踪」**——如果没有后续把事务真正接上 PG 的工作，这个注释会一直是「已接受的 no-op」，而 push 搬迁的原子性永远没实现（8e525df8 后迁移运行器在 PG 上跑 while 事务 no-op，checkpoint 记录依然"成功"）。
- **证据**：`74fda9b1~1:src/services/database/pushEngine.js` HIGH-2 注释全文（含「transaction would silently no-op」「deferred beyond Phase 9」「accepted known limitation」）；`7a6022cb`（事务保护测试，2026-07-18，早于 PG 修复但跑在 SQLite 语义上）；`TRANSACTION_DESIGN.md:200-208`（「PG/MySQL 引擎级事务语义目前仅由…MemorySQLiteAdapter 做引擎无关的栈契约验证…待 follow-up 补集成测试」）。
- **与我们的差异**：我们没有任何旧代码仓促上线带来的「已知限制注释」压力；但「注释不如测试」「引擎无关的 unit 测试会给假安全感」这两条教训直接适用——**引擎相关的语义契约必须有至少一个真实引擎的集成测试钉住**（即使只是 bun:sqlite + 内存库）。

---

### 经验点 5：修复方案——C# `_pinned` 持连接映射 + connId 路由 + JS `_txStack` 栈式上下文
- **解决什么问题**：让「BEGIN → N 条语句 → COMMIT」的每一步都命中**同一条物理连接**，同时不炸掉 22 个业务数据方法的调用签名。
- **方案**（三层，`74fda9b1` + `26ee17fa` + `1c645955`）：
  - **C# 层**：
    - `_pinned`：`ConcurrentDictionary<long, TxHolder>`，`TxHolder` 持有 `Conn`（借来的池连接）+ `Tx`（NpgsqlTransaction/ADO 事务）+ `Timer`（sliding idle 计时器）+ `InFlight`/`TimedOut`（竞态防御标识，见经验点 6）。
    - `BeginTransaction()`：**借一条池连接 → BEGIN → 存入 `_pinned[connId]` → 启动 sliding Timer → 返回递增 connId**。`BeginTransactionOnConnection(connectionString)` 是对外接数据库（pullEngine dst）的变体，经 `DataSourceCache` 解析独立 DataSource。
    - `CommitTransaction(connId)` / `RollbackTransaction(connId)`：按 connId 从 `_pinned` 取出**那一条连接**执行 COMMIT/ROLLBACK，还池 + 清 Timer。ROLLBACK 对已超时/不存在的 connId **静默 no-op**（让 JS 的 catch 可无条件调 rollback）；COMMIT 对缺失 connId **抛错**（调用方 bug 要响）。
    - `Execute(…, object? connId = null)` / `ExecuteNonQuery(…, connId)` / `ExecuteJson(…, connId)` 加**可选尾参**：有值 → `ExecutePinned` 查 `_pinned` 走那条连接 + 重置 Timer；无值 → 走默认池，行为与改造前一致（文档原话「**零回归**」）。
  - **JS 层**（EngineAdapter 基类，`26ee17fa`）：
    - `_txStack`（connId 栈，实例独立——srcAdapter/dstAdapter 天然隔离）；`execute`/`executeNonQuery` 内部读 `_txStack.at(-1)` 自动带上 connId ⇒ **22 个数据方法签名不变，业务代码零感知**。
    - `withTransaction(fn)`：begin → fn → commit；抛错 → rollback → 重抛；`_txStack` push/pop 在 try/finally 保证抛错也恢复。`beginTransaction`/`commit`/`rollback` 标 `@private`，生产只准用 `withTransaction`。
    - 子类只实现 4 个 `@protected` 钩子 `_doBegin/_doCommit/_doRollback/_doKeepAlive`：PG 返回真实 connId 并 pin；SQLite/MySQL 发 `BEGIN` 返回 0（单连接无需路由——即使已池化，`_doBegin` 还是发 SQL，因为 `_pinned` 的 `BeginTransaction` 在 SQLite.cs 里也实现了，但 `_doBegin` 用 `BEGIN` 让 connId=0 走单连接路径）。
  - **Sliding 超时（防泄漏安全网）**：`TX_IDLE_MS = 60000`，Timer 在 `BeginTransaction` 启动；**每次 SQL 执行前 `Timer.Change(Infinite,-1)` 暂停，执行完 finally 恢复**——防慢查询（异地高延迟）执行中被误杀；真卡死（JS await 悬挂、UI 阻塞）60s 后自动回滚 + 还池，防 JS 忘 commit 泄漏连接。
- **代价 / 陷阱**：
  - **基类被撑胖**：EngineAdapter 从冻结时 42 抽象 + 3 可选 → 现行 47 抽象 + 5 可选；其中 `_doBegin/_doCommit/_doRollback/_doKeepAlive` 4 个事务钩子 + `_txStack`/`_txTail`/`_txInFn` 全套是**为 PG 池化而生**（t1 判定「**没有 PG，事务面会小一半**」）——SQLite/MySQL 单连接根本不需要 pin 与串行队列（文档自己也承认：「对单连接引擎，`_txStack` 恒为单元素，串行队列纯属额外调度」）。
  - **connId 的类型 / CefSharp 桥的次生 bug**：connId 作为 `long?` 过 CefSharp 桥有 3 个修复提交（`2f49474c` Int64→object? 转换、`9669198b` object[]?→object?、`5c30bc63` 重载歧义）——**新增 API 的桥接层本身会带来一堆边缘 bug**。
  - **`BeginTransaction` 的失败路径**（`6f12a1d6`，#30）：借连接失败时若 `_totalBorrowed` 已自增而不归还，池监控报告 `availableCapacity = 16 - 24 = -8` 的**假阴性**——修复后所有失败路径 `conn.Dispose()` + 计数器递减。
- **证据**：`74fda9b1`（C# 持连接事务 API + sliding 30s→60s，+169 行）、`26ee17fa`（JS 栈式上下文，提交消息「22 个数据方法签名不变(栈顶在 execute/executeNonQuery 内部读)」）、`1c645955`（SQLite/MySQL 统一），`TRANSACTION_DESIGN.md:13-28`（三引擎对称表）、`ADAPTER_API.md §7`（事务 API 表）、PostgreSQL.cs:898-1201（ExecutePinned/OnTxTimeout/CleanupTx 实现）、`6f12a1d6` 提交消息。
- **与我们的差异**：bun:sqlite 无连接池，`_pinned` 映射不需要；但「**栈式上下文 + withTransaction 单一入口 + 低层方法 @private**」的 API 分层可以直接借鉴，且「业务数据方法不改签名、事务上下文在数据方法内部自动读」是降低事务 bug 面的关键手法。

---

### 经验点 6：修复引入的二级问题链——sliding 超时竞态、并发串行化、防死锁，共 6+ 个 follow-up 提交
- **解决什么问题**：pin 事务机制本身（Timer + 并发 + 桥）引入了新竞态；**一个修复带来的复杂度要用一整条修复链买单**。
- **方案（逐条，全部有提交实证）**：
  1. **Timer 排队竞态（`5ba6ebb6` 初防 → `28ceda93` TOCTOU 修复 → `57d366d2` 完全闭环）**：`Timer.Change(Infinite,-1)` **不会取消已排队的回调**——若回调恰在暂停 Timer 瞬间已入线程池，仍可能拿到 `_txLock` Dispose 连接，SQL 随后 `ObjectDisposedException` 且计数器泄漏。28ceda93 修 TOCTOU（`TryGetValue` 移入 lock 内），57d366d2 把 `InFlight` 读写全部纳入 `_txLock`（锁提供 happens-before，字段语义从 Interlocked 原子计数改为锁内普通 int）。
  2. **keepAlive 键入（`830c3e58` + `35ab7f51`）**：事务内 await 长交互 → 60s 静默回滚。react：`KeepAliveTransaction(connId)` 重置 Timer（不执行 SQL）；review 又要求返回值 `void → bool`——**静默吞错被否定**，`false` = 事务已死，调用方 `if (!await keepAlive()) return;` 提前干净退出。
  3. **「JS 单线程 ⇒ 事务不重叠」假设失效（`b5486313`，#27）**：withTransaction 内部 `await fn()` 交还事件循环，两个独立异步流交错——后到者被误判「嵌套」抛错（**同时两个事务若放行，SQL 全打到同一 pinned 连接 = C# 连接损坏**）。修复：`_txTail` 串行 Promise 队列（并发调用按到达顺序排队，同一实例同时只有一个事务）+ `_txInFn` 同步前缀嵌套检测（真调用栈嵌套立即抛错）。
  4. **await 后嵌套死锁（`1566485e`，PR #28 review）**：事务 fn 内 await 之后再次调 withTransaction，内层等外层释放、外层等内层返回 → **永久挂起**。修复：`await prev` 加 `Promise.race` + `_txWaitTimeoutMs` 超时（30s→`005791d3` 对齐 C# 60s idle 上限），挂起转为可 catch 异常。
  5. **超时路径毒化事务队列（`f00fb9a2`，PR #28 第二轮）**：超时 reject 发生在 try/finally 外 → `release()` 永不调用 → 该实例每次 withTransaction 先等满超时再抛错，**队列被永久毒化**。修复：整个等待 + 执行包进同一个 try/finally，任意路径 release。
  6. **悬空 timer（`005791d3`）**：超时路径残留 `waitTimer` 不 clearTimeout。修复：save 引用 + finally clearTimeout。
  7. **池借失败计数器泄漏（`6f12a1d6`，#30，2026-08-24）**：见经验点 5。
- **代价 / 陷阱**：
  - **这些二级 bug 全部「触发条件极苛刻但后果不可诊断」**（文档原话「触发条件极苛刻…但后果不可诊断，故加防御」）——Timer 竞态窗口是「idle 接近 60s + 回调已排队 + 恰好发 SQL + SQL 跨过回调瞬间」。
  - **新增的每个安全网又需要自己的回归测试**：并发串行化测试、超时兜底测试、失败重试测试、keepAlive bool 测试……复杂度是**级联**的。
  - **务必注意「等待超时 ≥ C# idle 超时」必须对齐**（30s 等待 vs 60s idle 会把合法长事务误判死锁；`005791d3` 对齐到 60000）。
- **证据**：`5ba6ebb6`/`28ceda93`/`57d366d2`/`830c3e58`/`35ab7f51`/`b5486313`/`1566485e`/`f00fb9a2`/`005791d3`/`6f12a1d6` 提交消息（逐一核实过原文）+ `TRANSACTION_DESIGN.md:37-58`（Timer 竞态防御）+ `TRANSACTION_DESIGN.md:79-107`（并发安全，含 PR #28 死锁盲区说明）。
- **与我们的差异**：bun:sqlite 同步事务 + 单连接没有 Timer/池化竞态，这 6 个 follow-up 大部分不需要；但「**并发是异步运行时常态**」（#27 的教训）与「**新增机制要配套队列释放/超时对齐的纪律**」适用于我们的宿主，且队长实测已证实单连接 + 并发异步同样会撞车（见经验点 8）。

---

### 经验点 7：⭐ 可推广判据——「连接池 + 事务」什么时候会出事、怎么架构上避免
- **解决什么问题**：把本案例提炼成不依赖 PG/本项目语境的**通用判据**，回答「我们怎么知道自己会不会踩」。
- **方案（判据清单）**：
  1. **判据 A（池化事务断裂的充要条件）**：事务的 `BEGIN`/`COMMIT` 与其中的语句**经由同一种「每语句借新连接」的执行路径**，且中间没有任何机制把后续语句固定到 BEGIN 所在连接 ⇒ 断裂。**判定问题**：「我的 `execute(SQL)` 内部是不是每次 `pool.GetConnection()` + `using` 还池？」——是，则事务必然断裂（无论引擎）。
  2. **判据 B（静默 vs 报错）**：断裂的可见性取决于驱动/引擎行为——Npgsql 还池 auto-reset 使 BEGIN 侧静默、COMMIT 侧偶发报错；但**常见路径是静默**。**判定问题**：「事务失效时有没有测试会在 CI 里红？」——没有 = 静默区。
  3. **判据 C（单连接 ≠ 安全，只是隐式串行）**：单连接让三条语句必然同连接，事务「碰巧」成立；代价是**没有任何并发写能力**——一旦两个异步流同时开事务，第二个 BEGIN 抛错、第一个可能永不 COMMIT（队长实测，见经验点 8）。**判定问题**：「我的数据库访问真的严格串行吗？还是只是『目前没撞』？」
  4. **判据 D（这类 bug 为什么容易漏）**：① 它**不报错**；② 它藏在「查询路径全部正常」的表象下（读/写都成功，只差原子性）；③ 引擎无关的 unit 测试（内存 SQLite 适配器）**给假安全感**——栈契约对了不代表引擎语义对；④ 它一旦写成「已知限制注释 + deferred」，就没有任何机制推动它被修复。
  5. **架构上避免（不靠人记得）**：
     - **运行时强制事务上下文，而不是让调用者手动 BEGIN/COMMIT**：`withTransaction(fn)` 单一入口；数据方法内部自动路由到当前事务连接（栈顶 connId）。调用者不可能写出「BEGIN 后忘了用同一连接」的代码——因为连接路由根本不在调用者手里。
     - **低层事务方法 @private / 能力提示**：`beginTransaction`/`commit`/`rollback` 不暴露给生产代码，IDE 高亮引导用 withTransaction。
     - **并发串行化是运行时保证**：`_txTail` 队列让「同一时刻只有一个事务」成为机制而非纪律。
     - **每个引擎至少一个真实集成测试**：文档明确认怂「PG/MySQL 引擎级事务语义需要真实后端 + C# 桥，无法纯 JS 覆盖，TODO」——这条空白本身就是教训。
     - **超时/等待参数一致性**：任何一个「排队等待 X」的机制，X 必须 ≥ 资源持有的合法上限（60s idle），否则误杀合法操作。
- **代价 / 陷阱**：判据 C 的「单连接安全」是**临时的**；判据 D 的假安全感（内存适配器）最隐蔽——**测试跑绿 ≠ 引擎语义对**。
- **证据**：`74fda9b1` 提交消息（断裂机制原文）、pushEngine HIGH-2 注释（静默 + 5-10×）、`b5486313`（并发假设失效）、`TRANSACTION_DESIGN.md:200-208`（PG/MySQL 测试覆盖空白）、`.temp/legacy-recon/01-interface-contract.md:103-106`（PG 专用撑胖分析）。
- **与我们的差异**：下列判据可直接用于我们的设计评审：**判据 A** 我们单连接天然不触发，但将来加多连接时必须自查「每条语句是否借新连接」；**判据 D** 的「内存适配器假安全感」我们已经有现成风险（bun:sqlite 内存库做 unit 测试不难，但要标记哪些断言只对单连接语义成立）。

---

### 经验点 8：与我们设计的关联——bun:sqlite 单连接的失败模式、队长实测、契约里该留什么
- **解决什么问题**：把旧系统的教训映射到我们的技术栈（bun 宿主 + bun:sqlite 单连接 + 事件驱动异步），并给出「将来接 PG 后端」的契约预留建议。
- **方案（映射结论）**：
  1. **「BEGIN 在 A、INSERT 在 B」对我们不成立**：单连接没有多条物理连接，`BEGIN`/`INSERT`/`COMMIT` 必落同一连接 ⇒ **池化断裂这个具体模式不存在**。
  2. **但「单连接 + 并发异步事务」是真问题，队长已实测**（`.temp/legacy-recon/06-captain-verification-sqlite-concurrency.md`）：
     - 实测：A `BEGIN` + insert，`await` 期间 B `BEGIN` → **第二个 BEGIN 抛错**「cannot start a transaction within a transaction」→ `Promise.all` 整体失败 → **A 永远走不到 COMMIT**，连接被留在打开的事务里，只留下 A-1 行。
     - 即旧系统「单连接保事务」的偶然正确在**我们的异步宿主上不成立**——事件驱动下「并发是常态」，两个事务可以在时间上交错。
     - bun `db.transaction()` 是**同步**的且自动用 savepoint 处理重入——正常用它安全；**危险区 = 手动 `BEGIN`/`COMMIT` 且中间有 `await`**。
     - 队长另实测：先读后写（SHARED→写锁升级）会**绕过 busy_timeout 立即失败**（2241ms vs 1ms）；候选对策是 `BEGIN IMMEDIATE` / 事务内不先读 / 应用层串行化。
  3. **我们现在该在契约里留什么（给将来 PG 后端的预留）**：
     - **事务 API 分层现在就定型**：`withTransaction(fn)` 作为唯一事务入口 + 内部化管理连接路由。即使单连接现在不需要路由，**接口形状要能容纳「connId 路由」**（PG 落地时，`_txStack` 栈顶就是 connId，而不是像旧系统那样要破例改冻结接口）。
     - **低层 begin/commit/rollback 标 @private**（旧系统 2026-07-25 的教训：先有自由调用再标 @private 的成本）。
     - **并发串行化机制（_txTail 类）或明确的「写事务不同时开」保证**：队长实测表明这不是将来 PG 的问题，是**现在 bun:sqlite 就有**的问题。
     - **引擎相关语义的集成测试**：即使现在只有 SQLite，也至少有一个「真库」集成测试钉住事务回滚/原子性；将来加 PG 时，为 PG 后端补真实集成测试而不是只靠内存适配器的栈契约测试（旧系统的空白教训）。
     - **等待超时 ≥ 事务持有上限的命名参数**（60s 对齐教训）若将来引入超时机制。
  4. **认真对待「变量名/API 语义」的沉淀**：旧系统把「连接路由」藏在数据方法内部（22 个方法签名不变）——这是「事务上下文属于运行时而非调用者」的范本；我们设计 service 层时同样应把事务上下文藏在存储层内部。
- **代价 / 陷阱**：
  - 单连接 + 串行化 = **写吞吐上限**（事务排队）；对 VRCX 类桌面单进程负载足够（旧系统风险评估「每秒几个写」），但设计文档要写明这是**有意的并发模型**而不是缺陷。
  - 「现在不需要 connId 路由」与「现在就留路由形状」之间存在过度设计风险——平衡点：**接口上只暴露 withTransaction，内部实现可后续演进**（bun:sqlite 无连接池 ⇒ 不必实现 _pinned，但 withTransaction 的签名与语义现在就定）。
- **证据**：`.temp/legacy-recon/06-captain-verification-sqlite-concurrency.md` 全文（实测输出 `{"log":["A:began"],"error":"cannot start a transaction within a transaction","rows":["A-1"]}`）；`TRANSACTION_DESIGN.md:79-107`（并发安全）；`ADAPTER_API.md §7`（withTransaction/keepAlive 契约现状）；`01-interface-contract.md:103-106, 207-216`（胖基类与并发演进史）。
- **与我们的差异**：我们不需要旧系统 C# 桥那层（bun:sqlite 原生同步），「keepAlive/sliding 超时/池监控」全部不需要；但 `withTransaction` 入口、@private 分层、串行化保证、真实集成测试这四样是**语言无关的教训**，直接进我们的宿主设计。

---

## 失败模式时间线（从提交历史重建）

| 日期 | 提交 | 事件 |
|---|---|---|
| 2026-07-10 | `f36e2e0c` | EngineAdapter 抽象基类诞生（此时 3 个适配器 begin/commit/rollback 都是「发 SQL 字符串」，SQLite 单连接语义下事务成立） |
| 2026-07-16 | `3afecfb7` | 接口冻结：42 抽象 + 3 可选 |
| 2026-07-18 | `7a6022cb` | 迁移事务保护测试（跑在内存 SQLite 适配器上——**引擎无关，永远抓不到 PG 断裂**） |
| 2026-07-19 | `89c98f13` | **PG 池化诞生**：PostgreSQL.cs 移除单连接与读写锁，改为每次 `_dataSource.OpenConnection()` 借池连接（max=100）。**事务方法根本没有**——BEGIN 也走借新连接路径，断裂静默生成 |
| 2026-07-19 | `902cf849` 等 | PG 持续接入（引擎探测、迁移兼容） |
| 2026-07-中旬（Phase 9） | pushEngine.js + HIGH-2 注释 | **团队已确认断裂机制与代价**：「transaction would silently no-op」「5-10× throughput loss」，「deferred beyond Phase 9」——**作为已知限制接受** |
| 2026-07-25 | `74fda9b1` | **修复**：`_pinned` ConcurrentDictionary + `BeginTransaction/CommitTransaction/RollbackTransaction` + Execute 系列可选 connId 尾参 + sliding 30s Timer（提交消息完整描述断裂） |
| 2026-07-25 | `26ee17fa` | JS 基类破例：`_txStack` + withTransaction + 4 个 `_do*` 钩子（22 数据方法签名不变） |
| 2026-07-25 | `1c645955` | SQLite/MySQL C# 层统一池化事务 API（方案 B 全员现代化——**此时 SQLite/MySQL 也走上池化**，原来「单连接保事务」的偶然安全被主动放弃） |
| 2026-07-25 | `830c3e58`/`35ab7f51` | keepAlive 心跳续命（含 bool 返回值 review 修正） |
| 2026-07-25 | `7a01f818` | 慢查询竞态修复（SQL 执行期间暂停 sliding Timer） |
| 2026-07-25 | `45f2979a` | TX_IDLE_MS 30s → 60s |
| 2026-07-26 | `5ba6ebb6` | Timer 排队竞态初防（InFlight 引用计数） |
| 2026-07-26 | `28ceda93` | **TOCTOU 修复**：TryGetValue + InFlight++ + Timer.Change 全部移入 `_txLock`（qa-review M3） |
| 2026-07-26 | `57d366d2` | Timer 竞态完全闭环（InFlight 读写全部锁内，字段改锁保护 int） |
| 2026-07-26 | `6bf9a0f1`/`9429cca8`/`8aa06768`/`2f8ff620` | 池三态监控（Issue #14/#15） |
| 2026-07-30 | `0c3cb1f5`/`2f49474c`/`9669198b`/`9351b097`/`5c30bc63` | connId 过 CefSharp 桥的 3+ 个次生修复（Int64/object?/重载歧义） |
| 2026-08-02 | `80f07292` | 数据库变更订阅（PG trigger+NOTIFY）——事务生态继续长大 |
| 2026-08-08 | `fbd5c7bb` | 池上限 100 → 16（与 SQLite 对称） |
| 2026-08-18/19 | `b5486313`/`1566485e`/`f00fb9a2`/`005791d3` | **#27 + PR #28 修复链**：并发串行化 `_txTail`、await 后嵌套死锁超时兜底、队列毒化修复、超时对齐 60s |
| 2026-08-24 | `6f12a1d6` | #30：失败池借计数器泄漏修复（availableCapacity 变负的假阴性） |

> 注：`git log` 显示的提交顺序与日期一致；「当时看起来没问题、后来才发现」的准确表述是：**Phase 9 就知道（注释），但直到 07-25 才修；修完之后又用了整整一个月（07-25 → 08-24）处理二级问题**。没有发现「某次测试因为该 bug 失败」的记录——发现渠道是**实现推进中的必然暴露 + 代码审查**，不是测试。

---

## 可推广判据（面向我们自己设计的结论）

1. **池化断裂判据**：事务语句若经由「每语句 `pool.GetConnection()` + `using` 还池」的执行路径，事务必然断裂，与引擎无关。自查：你的事务内语句是不是每次都借新连接？
2. **静默区判据**：一个机制失效时，如果「没有任何 CI 测试会红」+「读写都返回成功」，它就在静默区——危险等级最高。自救：为每个「承诺了原子性/隔离性」的机制写一个**能在它失效时红掉的测试**（哪怕一次）。
3. **单连接判据**：单连接给的是「隐式串行」不是「并发安全」；在异步运行时里，「两个事务不会同时开」必须由代码保证（串行队列或同步 transaction API），不能靠假设。
4. **「已知限制注释」判据**：把已知缺陷写成注释 + defer，等于给缺陷上保险——它永远不会被测试发现，也不会被用户报告。要么立即修，要么建一个**有 owner 的跟踪项**。
5. **引擎无关 unit 测试的边界**：内存适配器能验证栈契约，不能验证引擎语义；每个引擎至少一条真实集成路径。
6. **复杂度级联判据**：每加一个「安全网」（Timer、队列、超时），都要预期它的竞态/泄漏需要自己的修复链（本案例 10 个 follow-up 提交）——**新增机制的测试与边界文档必须与机制本身同 PR**。
7. **事务上下文属运行时**：把「在事务里」编码成调用者手动的 BEGIN/COMMIT 是万恶之源；`withTransaction(fn)` 单入口 + 数据方法内部自动路由，让错误写法**写不出来**，比任何 review 都可靠。

---

## 无法确定的事项

1. **断裂的精确可见行为**：修复前若真有人拿 PG 跑迁移运行器（`migrations/index.js` 的 `adapter.begin()/commit()`），`COMMIT` 到底报「no transaction in progress」还是静默成功——取决于 Npgsql 版本与池连接复用时机；代码/文档只有 pushEngine 注释的「silently no-op」证据，没有实测日志。**未在旧分支找到针对此的失败复现测试**（PG 引擎级事务测试至今标注 TODO）。
2. **为什么拖到 07-25 才修**：Phase 9（07-19 池化上线）到修复（07-25）只隔 6 天，中间没有专门提交说明「正在修」；pushEngine 注释说「deferred beyond Phase 9」，但 6 天后就落地了——触发点可能是迁移运行器在 PG 上首次真实执行（v16 .map for PG 是 07-19 之后），也可能是评审推动。提交历史无直接证据。
3. **SQLite/MySQL 池化（1c645955）是否引入过真实的「锁升级/连接泄漏」事故**：文档给出了 busy_timeout/WAL/PRAGMA 缓解表与风险评估，但**没有对应的事故记录或用户报告**——不确定池化后的 SQLite 是否在真实使用中踩过 `database is locked`。
4. **`_pinned` 的 `TxHolder.InFlight/TimedOut` 竞态防御是否被真正触发过**：文档明说「触发条件极苛刻」，修复链（28ceda93/57d366d2）是被 qa-review/代码审查发现的理论窗口，未提线上事故。
5. **`BeginTransactionOnConnection`（pullEngine dst 桥）的事务语义是否同样覆盖**：文档流程只写了分组事务目标，未单独验证 dstAdapter 的 connId 路由在真实 pull 中的行为（同样落在「PG/MySQL 集成测试 TODO」空白里）。
6. **Npgsql 还池 auto-reset 的确切机制名**：文档用「随还池被 Npgsql 自动 reset」描述，未给出底层机制名（Npgsql 对池连接归还时扔掉未提交事务的 reset 语义）；对「为什么是静默而非报错」的解释是我基于驱动行为的推断，不是源码级证据。
7. **事务等待超时 `_txWaitTimeoutMs` 对齐 60s 后，长事务 >60s 是否必然被误杀**：keepAlive 能续命到 60s+，但 `Promise.race` 排队等待的调用方最多等 60s——如果前序事务合法存活 60s+（keepAlive 续命），等待方仍会超时抛错。文档未讨论这个极限组合。
