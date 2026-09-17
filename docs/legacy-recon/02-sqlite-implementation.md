# 02 SQLite 实现勘察：SQLiteAdapter 与事务设计

> 勘察对象：`origin/old/main`（HEAD `e4ec5611` 2026-08-24，4526 commits；血统根 = VRCX 官方 MIT fork 链）。
> 只读勘察，未改动任何 tracked 文件。原始材料临时导出在 `.temp/recon-t2/`（随 .temp 可整体删除，本 md 为唯一副本）。
> 涉及文件：`src/services/database/adapter/SQLiteAdapter.js`（1250 行）、`src/services/database/adapter/index.js`（393 行）、`src/services/database/adapter/EngineAdapter.js`（1307 行，事务栈在此）、`docs/architecture/TRANSACTION_DESIGN.md`（230 行）、`Dotnet/SQLite.cs`（1413 行，C# 桥侧）、两个测试。
> 架构语境：JS（Vue/Electron/CefSharp）经桥调用 C# `System.Data.SQLite`（ADO.NET）；推/拉引擎可对**外部 .db 文件**（`connectionString` 模式）操作。事务栈/串行队列等 JS 层机制为三引擎（SQLite/PgSQL/MySQL）共享，写在 `EngineAdapter` 基类。
> 提示正文说 SQLiteAdapter.js 53KB、index.js 16KB，实际 53.1KB / 16.7KB，与表一致。

---

## 0. 总览：复杂度分层（对应任务要求逐条区分）

下面每一项都标注归属，用三个标签：

- **[PG 池化断裂衍生]** — 为 PostgreSQL 的"每次 ExecuteNonQuery 借新连接导致 BEGIN/INSERT/COMMIT 落不同连接"问题发明，SQLite 单连接时代**本不需要**，但池化改造后 SQLite 同样暴露（连接打散）。
- **[SQLite 真实需要]** — SQLite 引擎自身（文件锁、单写者、busy）要求，或池化后的真实并发场景要求。
- **[防御性代码]** — 作者明说触发条件极苛刻/为将来误用兜底；不实现不炸，但后果不可诊断。

争议最大的几个结论先给（论证见各自小节）：

| 机制 | 归属 | 一句话理由 |
|---|---|---|
| `_txStack` + connId 路由 | **[PG 衍生，但 SQLite 池化后也需要]** | 单连接 SQLite 时代没有此问题；池化后事务必须 pin 到同一连接，栈是让 JS 业务代码免于手动传递 connId 的便利层 |
| `_txTail` 串行队列 + `_txInFn` 嵌套检测 | **[SQLite 真实需要 + 防御性兜底混合]** | 主价值是 C# 单连接模式下防"两事务并存打到同一连接损坏连接"（内存测试即可复现）；超时兜底明确为防御 |
| 60s sliding Timer + `keepAlive()` | **[SQLite 真实需要]** | 单连接 SQLite 模式下事务期间非事务查询混入当前事务是真实隐患（文档背景明说），忘 commit 泄漏连接也是真实风险；Timer 只是量化手段 |
| InFlight/TimedOut 竞态防御 | **[防御性代码]** | 作者自述触发条件极苛刻（文档 L52-53），但后果是 ObjectDisposedException/不可诊断 |
| `busy_timeout=5000` + WAL + locking_mode=NORMAL | **[SQLite 真实需要]** | 池化后多连接并发写同一文件的直接应对；PRAGMA 是文件级、与驱动无关 |
| BUSY/LOCKED 指数退避重试 | **[SQLite 真实需要，且与 busy_timeout 分层]** | 两线防御：busy_timeout 放大内核等待窗口，重试兜内核超时后的剩余竞争 |
| `PRAGMA data_version` 观察连接 | **[SQLite 真实需要（写漏斗时延场景）]** | data_version 是"他写者视角"，本连接读不到自己提交的递增 |

---

## 1. SQLite 适配器实现骨架

### 经验点 1：适配器集中方言差异 — "业务层永不拼 SQL，换引擎只换适配器"

- **解决什么问题**：三引擎（SQLite/PgSQL/MySQL）共享业务逻辑，方言差异（`@param` vs `$N` vs `?`、INSERT OR IGNORE vs ON CONFLICT vs ON DUPLICATE KEY、LIMIT/ORDER BY 位置、datetime 表达式）不该泄漏到 feed.js/gameLog.js 等调用方。
- **方案**：`SQLiteAdapter` 把 SQLite 方言集中在三类方法里：
  1. 参数归一化 `_normalizeArgs` — 把调用方的 `{key: val}` 统一成 `@key` 命名参数（SQLiteAdapter.js:48-57）；
  2. CRUD 构建器 — `insert/bulkInsert/update/updateWhere/delete/select/selectWhere/selectJoin/selectWhereIn/selectUnion/selectGroupBy/upsertPartial/increment` 等 22 个方法，调用方传结构化参数（SQLiteAdapter.js:270-926）；
  3. SQL 表达式函数 — `daysAgoISO/sqlToUnixMs/sqlExtractWorldId/sqlHasInstanceId/sqlDate/sqlEnterTime`（:800-878），把 SQLite 方言表达式（strftime/INSTR/SUBSTR）封成方法。
- **代价 / 陷阱**：
  - `selectUnion` 处理了 SQLite compound-select 的硬限制：分支内不允许 ORDER BY/LIMIT、不支持分支括号语法 → 每个分支包成 `SELECT * FROM (branch)` 派生表（SQLiteAdapter.js:546-598）。这是踩出来的坑形知识。
  - `upsertPartial`：SQLite/PgSQL 用 `ON CONFLICT(col) DO UPDATE SET`，MySQL 用 `ON DUPLICATE KEY UPDATE` — 同一方法名在三个子类各一份实现。
  - 表结构 DDL 是另一极端：`initUserSchema`/`initGlobalSchema` 直接堆 50 张表原始 DDL 在适配器里（:950-1110），作者注释明说"换引擎时重写整个方法"（:944-947）。**方言抹平不是全层一致**：查询构建器抹平，DDL 不抹平。
  - 有一个值得抄的细节：`cookies`/`configs` 表用 `LONGTEXT` 列类型，SQLite 无此类型但接受任意类型名按 TEXT 亲和处理，三引擎 DDL 语义统一为 LONGTEXT（:1099-1109 长注释）。这是"跨引擎 DDL 语义统一"的活例子。
- **证据**：SQLiteAdapter.js:1-12（类头注释），:48-57，:916-926（upsert），:546-598（UNION 的坑），:944-947（DDL 不抹平的自觉）。
- **与我们的差异**：旧实现单一 `SQLiteAdapter` 子类构造 + 每方法一个回调式 `execute`；我们用 bun:sqlite 直连（已实测 compile 态可用），无桥、无 C# 层、无多引擎需求。但"业务层结构化参数、方言表达式函数化、UNION 分支派生表"这些形状可平移。

### 经验点 2：连接管理 — ADO.NET 池化（Pooling=True, Max Pool Size=16）

- **解决什么问题**：旧单连接 + ReaderWriterLockSlim 模式被 PR #13 池化改造取代（测试文件头述），目标：**事务期间其他查询走独立连接，不被事务阻塞**（SQLite.cs:68-71 明说池化主要收益）。
- **方案**：连接字符串 `Pooling=True;Max Pool Size=16`（SQLite.cs:245-246），每次 `new SQLiteConnection(connStr) + Open()` 借池中连接，`Dispose()` 还池。C# 池无 idle timeout — 连接创建后常驻到进程退出；作者接受此代价：桌面单用户，<5 活跃连接，每连接约 2MB page cache + 2-3 文件句柄（:209-226 长注释，含"PG/MySQL 都设 MinPoolSize=1 保活，SQLite 池天然等价于更强保活"的分析）。
- **代价 / 陷阱**：
  - System.Data.SQLite 池无统计 API → `GetPoolStats` 用 `_peakBorrowed`（自上次 ClearAllPools 以来并发借出峰值）近似 totalOpen/idleInPool，注释明说"非估算也非真值"，空闲连接是弱引用、被 GC 回收不可见（SQLite.cs:1366-1377）。
  - 池化后**多连接并发写同一 .db** → 需要 PRAGMA 三件套（见经验点 4）+ 重试（见经验点 5）。
  - C# 桥的坑：CefSharp 同名重载解析问题迫使 `BeginTransactionOnConnection` 改名（提交 `9b4228ee`）、connId 类型 long? → object? 修复 CefSharp Int32→Nullable<Int64> 转换（提交 `2f49474c`）。这些是 CefSharp 绑定特有的，与我们无关，但"桥参数类型会被宿主框架悄悄截断"是通用教训。
- **证据**：SQLite.cs:209-254；PR #13（测试文件头5-10行）；提交 9b4228ee / 2f49474c。
- **与我们的差异**：我们用 bun:sqlite 单 Database 实例直连，**没有多连接池**；文件锁竞争路径完全不同（bun:sqlite 编译态是单连接 + 外部队列，而非 ADO.NET 多连接互抢文件锁）。所以旧实现的池统计近似、ClearAllPools 等机制无对应物；但"事务期间非事务查询不应混入同一事务"的目标我们仍要达成（见经验点 8 的 SQLite 单连接隐患）。

### 经验点 3：连接串构建与外部文件操作 — URI → ADO.NET 连接串的手工解析

- **解决什么问题**：push/pull 引擎要对外部 .db 文件操作（`createAdapter(config)` + `sqlite:///` URI 模式，index.js:343-391）。URI 不是 URL：文件路径含空格/非 ASCII/`#`/`?` 会被 `new URL()` 百分号编码或截断 — 作者明确弃用 URL 解析（SQLiteAdapter.js:120-124 注释）。
- **方案**：手写前缀剥离器，支持 Windows 盘符路径 / Linux 绝对路径 / UNC 路径（`\\host\share`），引号转义 `"`→`""`（SQLiteAdapter.js:130-165）。连接级 PRAGMA 拼进连接字符串，每个池化连接 Open 时执行（SQLite.cs:248-253，值经 `SanitizePragmaValue` 过滤，见经验点 4）。
- **代价 / 陷阱**：外部连接串操作还带**连接缓存** — `ExecuteJsonOnConnection/ExecuteNonQueryOnConnection` 按 connectionString 复用一个进程级常驻连接（`ConnectionCache`），因为迁移期间同一文件被开关数千次（SQLite.cs:85-94）；作者注释"CEF 消息泵串行化 JS 调用，无需额外加锁"。
- **证据**：SQLiteAdapter.js:119-165；SQLite.cs:85-94；index.js:343-391。
- **与我们的差异**：我们不需要 ADO.NET 连接串（无驱动语法），但"外部文件事务写要走同一连接以保证原子性"（pull 目标文件）的需求若采用多库实例，旧实现的 `connectionString` 模式 + `BeginTransactionOnConnection` + 漏斗事件按 conn 路由实例（index.js:126-155, 357-360）是现成参考。

### 经验点 4：错误分类与重试 — busy_timeout 延迟内核错误，重试兜剩余竞争

- **解决什么问题**：池化后多连接并发写同一文件 → `database is locked`（SQLITE_BUSY）。SQLite 只支持一个并发写事务。
- **方案**：两道防线 + 一层错误分类：
  - **第一道：PRAGMA `busy_timeout=5000`** — 内核在锁竞争时阻塞等待 5s 而非立即报 BUSY（SQLite.cs:118, 232-236）。5s 足够桌面场景（写事务 ms 级）；仍超时说明死锁/长事务，应快速失败而非让 UI 卡 60s。文档明确**不对称到 PG/MySQL 的 15/30s** — 那些是网络层建连/SQL 超时，SQLite 是本地文件锁等待，概念层次不同（TRANSACTION_DESIGN.md:218）。
  - **第二道：指数退避重试** — `ExecuteWithRetry`：`MaxRetryAttempts=5`、`RetryBaseDelayMs=50`、`RetryMaxDelayMs=2000`、±25% jitter（SQLite.cs:80-83, 838-858, 964-977：`baseDelay = 50 * 2^(attempt-1)`，封顶 2000 + jitter）。**只重试 Busy/Locked** 两个 ResultCode（:828-833）。所有四条执行路径（pool / fresh / pinned-Execute / pinned-NonQuery）都包了它。
  - **错误分类**：`handleSQLiteError` 把 malformed / disk full / locked / I/O 四类错误弹 UI 提示（修复指引链接到 vrcx-team wiki），再 rethrow（SQLiteAdapter.js:59-117）。VrOverlay 环境（watch 模式）跳过 UI。
- **代价 / 陷阱**：
  - busy_timeout 与重试**不是同一层**：前者让内核等待（吞掉大部分短竞争），后者是内核超时后的第二道保险。文档风险评估：桌面单进程写来源主要是 updateLoop + 日志 + L3 轮询，每秒几个写，"5s busy_timeout 是兜底保险，正常操作几乎不会触发"（TRANSACTION_DESIGN.md:222）。
  - busy_timeout 是**逐连接**的（连接字符串级 PRAGMA），不是数据库级，所以必须放进池连接串。
  - 还有 `optimize=0x10002` 这个 PRAGMA 常驻连接串（SQLite.cs:121）— 数值模式位（等价 `PRAGMA optimize(0x10002)`），让 SQLite 空闲时自动跑 analyze 提示。
- **证据**：SQLite.cs:77-83, 116-122, 828-858, 964-977；SQLiteAdapter.js:59-117。
- **与我们的差异**：我们用 bun:sqlite 直连，可在 open 后对**单连接**设 busy_timeout/WAL（编译态实测已可用）；多连接互抢场景由我们自己的串行化策略决定，重试逻辑可照搬数值（50ms 起步、2 倍、2s 封顶、±25% jitter、仅 Busy/Locked）。

### 经验点 5：连接串安全 — PRAGMA 注入防御

- **解决什么问题**：用户可通过 `VRCX_Database.options.*` 配置任意 PRAGMA，若拼进连接字符串可能被注入（如 `key` 加密系列 PRAGMA 可给数据库重新上锁 — 灾难级；`;` 可分裂连接串）。
- **方案**：三层校验（SQLite.cs:124-157, 435-466）：
  1. key 白名单正则 `^[A-Za-z0-9_]+$`（防 `foo;PRAGMA rekey` 这种经 key 注入，需先于黑名单执行）；
  2. 黑名单 `key/rekey/hexkey/hexrekey/textkey/textrekey/hexdbkey/hexrekey_md5/hexkey_md5`（SEE 加密系，禁设）；
  3. 值禁止字符 `; ' " \n \r \0`（引号改解析、换行行注入、\0 截断 P/Invoke 边界）。
- **代价 / 陷阱**：文件路径侧同样有完整校验：null 字节拒绝 → 解析 → 规范化 → 边界检查（防 `../../evil.db` 穿越）→ 扩展名白名单 `.db/.db3/.sqlite3` → Windows 保留设备名（CON/PRN/NUL/COM1…）拒绝（SQLite.cs:295-351, 163-179）。还有一个**教科书级细节**：用 `Path.IsPathRooted(resolved)` 检查原始输入、而不是检查 `GetFullPath` 之后的规范化结果 — 因为 GetFullPath 会把任何相对路径变成绝对路径，检查后者恒真无意义（:336-340）。
- **证据**：SQLite.cs:124-157, 295-351, 435-466。
- **与我们的差异**：我们无连接字符串语法（bun:sqlite 的 config 对象没有 `;` 解析），注入面小得多；但"反序列化配置进入 SQL 执行路径前必须过白名单"的结构（key 白名单先于黑名单）与路径穿越校验可平移。

### 经验点 6：维护与健康探针

- **解决什么问题**：Storage 层需要 VACUUM / optimize / 健康检查 / 池监控。
- **方案**：`vacuum()` = `VACUUM`；`optimize()` = `PRAGMA optimize`（SQLite 特有，注释说换引擎用 ANALYZE，EngineAdapter.js:802-822）；`isConnected()` = C# `SQLite.Ping()`（`SELECT 1`）；`getHealth()` = `GetHealth()`；`getPoolStats()`/`clearIdleConnections()` 透传 C#；`getPoolStats` 有 6 字段契约（active/pinnedIdle/availableCapacity/max/totalOpen/idleInPool）。
- **代价 / 陷阱**：无。
- **证据**：SQLiteAdapter.js:1161-1210。
- **与我们的差异**：bun:sqlite 可以 `PRAGMA optimize`/`VACUUM` 直发；池监控无对应物。

---

## 2. 事务设计（文档逐条区分）

### 经验点 7：事务上下文栈 `_txStack` + connId 路由 — [PG 衍生，但池化后的 SQLite 同样需要]

- **解决什么问题**：PG 时代每次 ExecuteNonQuery 借新连接 + using 还池 → BEGIN 在连接 A、INSERT 在连接 B、COMMIT 在连接 C，事务语义断裂（Npgsql 自动 reset）。文档明说这是 **C# 包装层疏漏，不是 PG/Npgsql 引擎限制**（TRANSACTION_DESIGN.md:7）。SQLite 单连接 + lock 时代没有此问题；**但池化改造后 SQLite 也打了同样的结** — 事务必须 pin 到同一连接。
- **方案**：JS 基类维护 `_txStack`（实例属性，每 adapter 实例独立）；`execute/executeNonQuery` 读栈顶 `this._txStack.at(-1)` 把 connId 传给 C#，C# 走 pinned 连接（EngineAdapter.js:53-61；SQLiteAdapter.js:170, 227；TRANSACTION_DESIGN.md:74-77）。23 个数据方法签名不变 — **栈顶在 execute 内部读**，业务代码完全无感（EngineAdapter.js:20-21）。
- **代价 / 陷阱**：栈管理必须 try/finally pop（commit/rollback 的 finally 必 pop，抛错也恢复，EngineAdapter.js:627-652）；connId null/0 走默认池，事务外零行为变化。
- **证据**：EngineAdapter.js:595-652；TRANSACTION_DESIGN.md:5-9, 74-77。
- **与我们的差异**：我们用 bun:sqlite 单连接，没有"多个物理连接间路由"的需要；但"业务代码持有某个事务态、所有后续调用自动归属该事务"这一**句法**（隐式上下文）若实现为 begin/commit 包对象，仍是可借鉴的 API 形状。单连接下 SQLite 的 BEGIN 就是 BEGIN，无需 pin。

### 经验点 8：`withTransaction(fn)` — 栈式语义、抛错回滚、嵌套拒绝 [SQLite 真实需要 + 防御兜底混合]

- **解决什么问题**：把"begin/try/finally-commit/catch-rollback"样板收进一个方法，保证原子性 + 栈清洁。
- **方案与语义**（EngineAdapter.js:727-798）：
  - 成功 → `commit(connId)` + 返回 fn 返回值（透传，transaction.test.js:331-346 验证）；
  - fn 抛错 → `rollback(connId)`（容忍 no transaction / 已超时连接，静默 no-op）+ 重抛；rollback 自身失败只 console.error 不掩盖原错误（:781-793）；
  - **同步调用栈嵌套**（在另一个事务 fn 的同步段内再次调用）→ 立即抛错。实现手法：`_txInFn` 标记只覆盖 fn 的同步前缀 — 异步函数同步执行到首个 await 前 — `fn()` 返回 Promise 后立即复位（:765-777）。这是"异步函数是同步前缀 + 挂起"模型的精妙应用；
  - 事务内 `execute/executeNonQuery/insert/bulkInsert` 自动走 pinned 连接；
  - 事务内读未 commit 的写（同一连接）是**关键正确性保证**，单测专门验证（transaction.test.js:295-328）。
- **代价 / 陷阱**：三个低级方法 `beginTransaction/commit/rollback` 标 @private（IDE 高亮但不触发 lint — eslint 未开 check-access），生产代码 0 处直接调用（TRANSACTION_DESIGN.md:132-146）。**语义边界**：并发交错（await 让出事件循环后另一个流进来）不算嵌套，去排队（见经验点 9）。
- **证据**：EngineAdapter.js:727-798；transaction.test.js:46-231。
- **与我们的差异**：bun:sqlite 有同步/异步事务 API 可直接包；"嵌套拒绝 + 并发排队"的区分方式（同步段 vs 时间交错）是我们若实现 withTransaction 时最值得抄的判定逻辑。

### 经验点 9：并发串行队列 `_txTail` — 防"两个事务并存打到同一连接" [SQLite 真实需要]

- **解决什么问题**：文档自认的原始设计缺陷："JS 单线程：无并发打断，栈操作原子"假设在异步下不成立 — `await fn()` 把控制权交还事件循环，两个独立异步流（WS feed 写入、用户对话框刷新）时间交错；后到者若见栈非空误判嵌套而抛错；若放行则两个事务同时存在，**SQL 全部打到同一个 pinned 连接，C# 侧连接损坏**（TRANSACTION_DESIGN.md:81-85）。对 SQLite 来说这是**真实问题**：单连接模式下两事务并存 = 第二条 BEGIN 直接把第一条踢掉或报错。
- **方案**：`_txTail` 串行队列 — `withTransaction` 把本次执行 append 到 Promise 链尾，前一个 commit/rollback 后才执行下一个；`release()` 在任意路径（正常/抛错/超时）都被 finally 调用推进队列尾（EngineAdapter.js:63-77, 733-797）。同一实例同时只有一个事务 → 原子性与并发安全兼得。
- **代价 / 陷阱**：
  - 队列无超时 → await 后嵌套会排队等死（内层等外层释放、外层等内层返回，永久挂起）。超时兜底把挂起转成可 catch 的异常（见经验点 10）。
  - 该队列意味**同一 adapter 实例上的事务串行化** — 长事务会阻塞后续事务排队（但只是等待，不误杀，文档:98）。
  - 修复提交 `b5486313`（#27）加串行化，`1566485e` 加超时，`f00fb9a2` 把超时路径纳入 try/finally（防止队列毒化 — 旧版超时 reject 发生在 try/finally 之外，release 不执行，之后每次 withTransaction 都等满超时才抛错，单测钉死此回归：transaction.test.js:190-231）。
- **证据**：TRANSACTION_DESIGN.md:79-107；EngineAdapter.js:727-798；transaction.test.js:116-188（并发排队不抛错、排队后栈恢复 0、失败事务不影响后续）。
- **与我们的差异**：bun:sqlite 编译态单连接 — 若我们也想让"两事务并存"彻底不可能，串行队列是把竞态从"运行时损坏"变成"排队等待"的现成思路；若我们 per-事务开新 Database 连接则不需要（但 WAL 下会有文件级竞争，回到经验点 4 的 PRAGMA）。

### 经验点 10：`_txWaitTimeoutMs = 60000` 队列等待超时 — 防御性兜底

- **解决什么问题**：await 后嵌套 → 永久挂起（死锁盲区，PR #28 review 指出，文档:103-107）。
- **方案**：`await prev` 用 `Promise.race` + setTimeout 超时，默认 **60000ms**，**刻意对齐 C# 侧 `TX_IDLE_MS = 60000`**：前序事务可经 keepAlive 合法存活至 60s，等待超时必须 ≥ 该上限，否则排队调用会被误判为死锁（EngineAdapter.js:92-107 注释明说）。超时抛"疑似嵌套事务死锁"，业务可 catch 降级。
- **代价 / 陷阱**：注释明说"当前生产代码 10 处 withTransaction 调用点均无嵌套（事务体内只做纯 DB 操作），死锁为将来误用场景的防御性兜底"（文档:106-107）→ **防御性代码**。但有两个真实子问题被它兜住：误用导致的挂起、以及队列毒化。
- **证据**：EngineAdapter.js:92-107, 744-762；TRANSACTION_DESIGN.md:103-107。
- **与我们的差异**：若我们不引入串行队列，这层超时不存在；若引入，60s 对齐上限的设计（等待超时 ≥ 事务合法最大存活）值得照抄。**注意默认值经历 `b5486313`（30s）→ `005791d3`（改成 60s 对齐）的历史** — 做过一次修正。

### 经验点 11：60s sliding idle Timer + `keepAlive()` — SQLite 真实的防泄漏/防悬挂机制 [SQLite 真实需要]

- **解决什么问题**：事务泄漏。JS 忘 commit → 连接不还池；事务期间 await 用户对话框 → 长事务持有事务锁阻塞其他写。文档背景还点名 SQLite/MySQL 单连接 + lock 时代另一个隐患：**事务期间的非事务查询隐式混入当前事务**（TRANSACTION_DESIGN.md:9，改造前问题清单）。
- **方案**：
  - C# `TX_IDLE_MS = 60000`：`BeginTransaction` 启动 `new Timer(OnTxTimeout, TX_IDLE_MS, -1)`（SQLite.cs:75, 1180）；每次 pinned SQL 执行前 `Timer.Change(Timeout.Infinite, -1)` 暂停、执行完 finally 恢复 `Change(TX_IDLE_MS, -1)` — **防止慢查询执行中误触发超时**（:1064, 1105, 1122, 1147）；真卡死（JS await 悬挂、UI 阻塞事件循环）60 秒后回收。
  - `KeepAliveTransaction(connId)` 只重置 Timer 不执行 SQL（SQLite.cs:1308-1319）；JS `keepAlive()` 读栈顶 connId 委托过去，返回 `Promise<boolean>`：true=续命成功，false=已超时回滚/不在事务/桥异常（EngineAdapter.js:654-694）。推荐用法是**提前续命**而非"卡着 60s 的点回来打卡" — 临近超时才发 SQL 会进 Timer 与 SQL 的竞态窗口（虽有 InFlight 防御不崩，但事务仍被判定超时回滚）（TRANSACTION_DESIGN.md:55-58, 1157-1160）。
- **代价 / 陷阱**：`keepAlive` 是逃生舱，不是鼓励事务内长交互 — 注释反复警告"事务应尽可能短，能拆到事务外确认的优先拆出去（乐观锁模式）"，并给了两种正反代码样板（EngineAdapter.js:707-720）。已超时回滚的 connId 上再做 SQL → "connId 已超时回滚或不存在"（SQLite.cs:1060）。
- **证据**：SQLite.cs:75, 1153-1195, 1308-1341；EngineAdapter.js:654-694；TRANSACTION_DESIGN.md:30-35, 109-130；transaction.test.js:348-370（事务内 true / 事务外 false / 多次 true）。
- **与我们的差异**：bun:sqlite 无 sliding timer 概念；但"长事务 + 用户交互"的对抗模式（心跳续命 vs 拆分事务）与"60s 不动自动回滚"的量化取舍可直接作为我们事务粒度的参考（文档自己的价值观：事务要短、交互拆出去）。

### 经验点 12：Timer 排队竞态防御（InFlight + TimedOut）— 防御性代码

- **解决什么问题**：`Timer.Change(Timeout.Infinite, -1)` 不会取消已排队、即将执行的回调。如果 Timer 回调恰好在 `ExecutePinned` 暂停 Timer 的瞬间已被线程池排队，回调仍可能在 SQL 执行期间拿到锁并 Dispose 连接 → `ObjectDisposedException`。
- **方案**：`TxHolder.InFlight`（int 计数）+ `TimedOut`（bool）。`ExecutePinned` 执行 SQL 前 `InFlight++`，finally `InFlight--`；`OnTxTimeout` 见 `InFlight > 0` 时不立即回滚，设 `TimedOut = true` 返回，让 SQL 执行完的 finally 检测标记自行 `TryRemove + Timer.Dispose + CleanupTx`（SQLite.cs:96-114, 1061-1107, 1321-1341）。TryGetValue 与 InFlight++/Timer.Change 在**同一把 `_txLock`** 内 — 锁提供 happens-before，注释明说不需 Interlocked/volatile（:96-106, 1051）。
- **代价 / 陷阱**：文档自述"触发条件极苛刻（事务 idle 接近 60s + Timer 已排队 + 恰好此时发 SQL + SQL 执行跨过回调瞬间），但后果不可诊断，故加防御"（TRANSACTION_DESIGN.md:52-53）→ **[防御性代码]**。纯功能上可不实现；实现成本是每个 pinned SQL 路径多两级锁区 + 标记检查。
- **证据**：SQLite.cs:96-114, 1061-1107, 1321-1341；TRANSACTION_DESIGN.md:37-58。
- **与我们的差异**：bun:sqlite 同步 API 无 Timer 回调竞态；除非我们自建空闲超时器，否则无对应物。

### 经验点 13：`srcAdapter/dstAdapter` 实例隔离 + `withPrefix` 正交 [SQLite 真实需要]

- **解决什么问题**：push/pull 引擎同一进程里同时操作源库与目标库（外部文件），事务上下文不能交叉。
- **方案**：`_txStack`/`_txTail` 是实例属性，每个 adapter 实例独立，srcAdapter/dstAdapter 天然不交叉（EngineAdapter.js:57-58 注释；transaction.test.js:263-293 验证两实例独立 commit/rollback）。`withPrefix` 用另一独立实例字段 `_prefixOverride`（保存/恢复式），与事务栈正交（transaction.test.js 七类路径第 7 项）。事务隔离同时覆盖了外部 connectionString 实例（`_changeInstances` 按 conn 路由漏斗事件，index.js:126-155）。
- **代价 / 陷阱**：无 — 这是"实例级状态而非模块级全局"纪律的直接收益。
- **证据**：EngineAdapter.js:167-175（withPrefix），:43-90；TRANSACTION_DESIGN.md:148-156；transaction.test.js:263-293。
- **与我们的差异**：我们若多库操作（每库一个 Database），同纪律适用。

---

## 3. 并发写：测试在测什么

### 经验点 14：SQLiteConcurrentWrite.test.js 测的是"WAL + busy_timeout 让竞争写等待而非抛 BUSY"

- **解决什么问题**：PR #13 池化改造（SQLite.cs 删除单连接 + ReaderWriterLockSlim，改用 ADO.NET 池化）后，多个连接可能同时写同一 .db — SQLite 只支持一个并发写事务，竞争时其他连接阻塞等锁。需要理论安全基础验证。
- **方案**：用 **node:sqlite 的 `DatabaseSync` + worker_threads**（非 C# System.Data.SQLite — 文件头 TODO 明说 C# 池化并发写需独立测试项目）验证 SQLite WAL 并发写理论本身。每种 Worker 打开同一文件后设 `PRAGMA busy_timeout=5000; journal_mode=WAL; locking_mode=NORMAL`，用 `BEGIN IMMEDIATE → INSERT → COMMIT` 循环写，统计 ok/busy/errors：
  - 4 Worker × 50 = 200 行全成功 0 BUSY；
  - 2 Worker × 100 = 200 行全成功；
  - 8 Worker × 25 = 200 行全成功；
  - 最后开独立连接 `SELECT COUNT(*)` 验证无丢失（test:109-195）。
- **代价 / 陷阱**：明确的自述局限：测试验证驱动无关的**文件级 PRAGMA 理论**（WAL/busy_timeout/locking_mode 与驱动无关，两路径共享同一 SQLite 引擎），**不覆盖 C# ADO.NET 池化的连接管理/超时/重试路径**，TODO 列了三项需 C# 端 xUnit/NUnit 覆盖的场景（池化多连接竞争、push/pull 事务期间 updateLoop 非事务写竞争文件锁、Max Pool Size=100 极端排队，test:198-215）。
- **证据**：SQLiteConcurrentWrite.test.js:1-26（意图+局限），:50-106（worker 脚本），:108-196（三个 case），:198-215（TODO）。
- **与我们的差异**：bun:sqlite 直连与 node:sqlite 同源（同为官方 SQLite），旧测试的理论结论（WAL+busy_timeout 下 8 worker 并发写 200 事务 0 BUSY）对我们也成立；但我们单连接 + 串行队列后基本不会出现多写者竞争，"BEGIN IMMEDIATE 短事务"仍是可复用的压测模板。

### 经验点 15：真实并发问题的清单（SQLite 单连接 + lock 模式 → 池化后）

- **问题 1（单连接时代）**：长查询阻塞健康检查；事务期间的非事务查询隐式混入当前事务（TRANSACTION_DESIGN.md:9, 229）。→ 池化 + 事务内 SQL 路由到 pinned 连接解决。
- **问题 2（池化后）**：多连接并发写同一文件 → BUSY/锁竞争（PRAGMA 三件套 + 重试，经验点 4）。
- **问题 3（任何模式）**：两事务并存打到同一连接 → 连接损坏（串行队列，经验点 9）。
- **问题 4（任何模式）**：C# 桥 connId 类型转换（CefSharp Int32→Nullable<Int64> 截断，提交 2f49474c）与同名重载解析（提交 9b4228ee）— 桥绑定边界的问题，与引擎无关。
- **问题 5（前身血统）**：`d1d043d5 fix(SQLite): 修复 database is locked 及 connId 类型转换异常`、`28ceda93 fix(concurrency): 修复 ExecutePinned TOCTOU 致计数器永久泄漏(qa-review M3)`、`6f12a1d6 fix(database): release failed pool borrows (#30)` — 三个历史修复点分别是：locked 异常处理、**ExecutePinned 的 TOCTOU 导致借用计数永久泄漏**（计数与借出不在同一临界区）、**借出失败时借用计数未释放**。#30 的修复模式是 `BeginTransaction` 的 finally 里 `if (!_pinned.ContainsKey(connId)) Decrement`（SQLite.cs:1190-1194, 1239-1243）— 计数正确性用"实际入册才计数"的最终核对。
- **证据**：SQLite.cs:1190-1194；提交 d1d043d5 / 28ceda93 / 6f12a1d6 / 9b4228ee / 2f49474c。
- **与我们的差异**：bun 直连无桥、无池、无计数；但"计数/登记必须原子，失败路径要回滚计数"是任何资源池（含我们的连接复用缓存）的通用教训。

---

## 4. 性能相关（PRAGMA 取值清单）

### 经验点 16：PRAGMA 三件套 + optimize 的具体取值（最有价值部分）

| PRAGMA | 值 | 出处 | 作用 / 取舍 |
|---|---|---|---|
| `busy_timeout` | **5000** ms | SQLite.cs:119, 232-236 | 锁竞争时内核等待 5s 而非立即报 BUSY；5s 够桌面场景，超时应快速失败而非卡 UI |
| `journal_mode` | **WAL** | SQLite.cs:120, 237-239 | 读写并发、写写串行；读不被写阻塞，写事务持锁时间 = 单条 SQL 执行时间（几 ms） |
| `locking_mode` | **NORMAL** | SQLite.cs:118, 240-244 | 每条 SQL 执行完释放文件锁；`EXCLUSIVE` 独占文件到 Exit、阻塞外部工具（DB Browser）与其他进程，**明确不采用** |
| `optimize` | **0x10002** | SQLite.cs:121 | 数值模式位；空闲时自动跑分析提示 |
| （连接串） | `Pooling=True; Max Pool Size=16` | SQLite.cs:245-246 | ADO.NET 池；桌面 <5 活跃连接，每连接 ~2MB page cache + 2-3 句柄，常驻可接受 |

- **批量插入**：`bulkInsert` 单条 SQL 多值 `INSERT ... VALUES (...),(...),(...)`，命名参数 `@col_i` 展开（SQLiteAdapter.js:290-311）；空数组时直接 return 不发 SQL。边界：所有行必须共享相同 key 集合。
- **重试退避**：见经验点 4（5 次 / 50ms 起步 / 2 倍 / 2s 封顶 / ±25% jitter / 仅 Busy+Locked）。
- **fsync 提速数据点**：文档效果栏报告"fsync 次数从每批 1 次降到每组 1 次（5-10× 提速）" — 分组事务（push/pull 每 prefix 一组）减提交次数（TRANSACTION_DESIGN.md:226-227）。
- **事务粒度取舍**：push/pull 按"global 一组、per-prefix 一组、mirror 一组"分组事务，per-group try/catch — 组内失败回滚该组、其他组保留（TRANSACTION_DESIGN.md:190, 227-229）；错误隔离优先于整体原子性。
- **慢查询防误杀**：Timer 暂停/恢复包在 SQL 执行外层（见经验点 11）— 避免异地高延迟场景慢查询被执行中误触 60s 超时（TRANSACTION_DESIGN.md:34）。
- **证据**：SQLite.cs:116-122, 209-254；SQLiteAdapter.js:290-311；TRANSACTION_DESIGN.md:210-222, 226-229。
- **与我们的差异**：我们（已实测 compile 态可用）bun:sqlite 建议 WAL；旧实现的 **busy_timeout=5000** 与 **locking_mode=NORMAL** 取值是可直接对照的桌面实测值；WAL 下写事务持锁时间 ≈ 单条 SQL 的"写短事务"粒度原则（文档多次强调分组/短事务）是主线取舍。

### 经验点 17：`PRAGMA data_version` — 完备层变更计数器与"观察连接"

- **解决什么问题**：写漏斗事件（C# DatabaseChanged 回调）缺位时的完备层兜底 — 用 `PRAGMA data_version`（DB 级、提交级、无假阳性）轮询检测"他写者"提交。
- **方案**：data_version 是**他写者视角**计数器 — 本连接读不到自己提交的递增（单连接下恒为初始值），但能可靠追踪其他连接/外部进程的提交。因此主库配**专用观察连接**（永不用于写，惰性创建），保证 dv 快照与 JS 轮询视角一致（SQLite.cs:881-915；SQLiteAdapter.js:1212-1247）。写漏斗实时层（C# 表级写计数，事务内累积 COMMIT 后按表发射 — `RecordChange`/`Changes` 字典，SQLite.cs:956-962, 1270-1281）与计数器完备层双轨，事件在锁外发射防重入（:1273）。
- **代价 / 陷阱**：dv 快照必须读自非写者连接，否则基线去重滞后一版失效（SQLiteAdapter.js:1212-1222 注释，指向 ADAPTER_API.md §9）；`data_version` 按文件计数，VRCX 单文件运行时计数范围即业务范围。
- **证据**：SQLite.cs:886-915, 956-962, 1270-1281；SQLiteAdapter.js:1212-1247。
- **与我们的差异**：我们若需要"其他进程改库 → 界面刷新"的观测，bun:sqlite 同样支持 `PRAGMA data_version`，观察连接思路（写者连接读不到自己的递增）通用。

---

## 5. 补充事实（线程安全 / 提交历史佐证）

### 经验点 18：C# 侧 `_txLock` 全局串行化 + 计数纪律

- **解决什么问题**：pinned 事务的登记/注销/计时器/Timer 竞态在钩子（线程池 Timer 回调）与业务执行路径（JS 桥调用）间共享状态。
- **方案**：所有 TxHolder 状态变更在 `lock (_txLock)`（单一全局锁，SQLite.cs:72）；注释明说由于所有读写都在锁内，"锁提供 happens-before，无需 Interlocked/volatile"（:96-106）— 只有跨路径的借用计数 `_totalBorrowed`/`_activeCount`/`_pinnedActive` 用 Interlocked（因为它们在锁外也被读/写）。`UpdatePeak` 用 CAS 循环实现 Interlocked Max（:1349-1354）。
- **代价 / 陷阱**：全局锁会把不同连接的并发执行串行化 — 单文件 SQLite 场景本身写就是串行的，可接受；CEF 消息泵串行化 JS 调用也降低了锁争用。
- **证据**：SQLite.cs:64-75, 96-114, 1349-1354。
- **与我们的差异**：bun:sqlite 单连接同步 API 无边；若未来多连接 + 自建超时器，此锁纪律是模板。

### 提交历史速查（事务/并发相关，全部在 origin/old/main）

- `b5486313` fix(adapter): withTransaction 并发串行化，修复嵌套事务误报（#27）
- `1566485e` fix(adapter): withTransaction 队列加超时兜底，防 await 后嵌套死锁
- `f00fb9a2` fix(adapter): 超时路径纳入 try/finally，防止事务队列毒化
- `005791d3` fix(adapter): 事务等待超时对齐 60s + 清理悬空 timer
- `6f12a1d6` fix(database): release failed pool borrows（#30）
- `28ceda93` fix(concurrency): 修复 ExecutePinned TOCTOU 致计数器永久泄漏（qa-review M3）
- `d1d043d5` fix(SQLite): 修复 database is locked 及 connId 类型转换异常
- `9b4228ee` / `2f49474c`：CefSharp 桥重载/类型适配
- `d10b0cc0` refactor: 仓库转移收尾（VRCX-K 品牌；此为"整段历史从上游搬迁"的边界提交）

---

## 6. 与我们的差异（汇总，客观陈述）

| 维度 | 旧实现 | 我们（计划） |
|---|---|---|
| 连接 | C# System.Data.SQLite ADO.NET 池（Pooling=True, Max=16）经桥 | bun:sqlite 编译态直连（已实测可用） |
| 并发写形态 | 多物理连接互抢文件锁（池化代价） | 单连接（推测）+ 是否引入串行队列待定 |
| 事务上下文 | JS `_txStack` + connId 经桥路由 pinned 连接 + 60s sliding Timer | 未定；bun:sqlite 有原生 transaction API |
| PRAGMA | busy_timeout=5000 / WAL / locking_mode=NORMAL / optimize=0x10002 | WAL 已定；其余取值可对照 |
| 重试 | 5 次 / 50ms 起 / 2 倍 / 2s 顶 / ±25% jitter / 仅 Busy+Locked | 无对应层（单连接串行化后可省） |
| 变更观测 | C# 写漏斗 + data_version 观察连接 | 未定；data_version 思路通用 |
| 多库操作 | connectionString 实例 + `_changeInstances` 路由 | 未定 |

## 无法确定的事项

1. **`optimize=0x10002` 的确切语义**：数值模式位（等价 `PRAGMA optimize(0x10002)`）来自 SQLite 官方文档的 MASK 取值（0x02 = analyze 建议、0x10000 = 允许 seek 扫描抽样等），但 SQLite.cs 注释未逐位展开；具体在 System.Data.SQLite 拼入连接串时是否真的按预期执行 `PRAGMA optimize` 未验证。移植时建议在 bun:sqlite 上实测 `PRAGMA optimize` 的直接语义即可，不必复刻该数值。
2. **10 处 withTransaction 调用点清单**：文档称"生产代码 10 处调用均无嵌套"，但未列出具体位置；未逐一核对（超出本任务文件范围）。与我们关系不大，仅作"无嵌套使用现状"的置信度参考。
3. **`SQLite.cs` 的 `Execute`（读路径）是否也暂停 Timer**：pinned 路径的 Execute 与 ExecuteNonQuery 都包装了 InFlight/Timer 暂停-恢复（SQLite.cs:1061-1107, 1119-1147 对称），但读路径定时暂停的幅度与慢查询上界（几 ms → 异地高延迟几秒）没有数值记录，只有"防止慢查询执行中误触发"的意图。
4. **`PRAGMA optimize` 的 `0x10002` 有单测覆盖吗**：未在本次文件范围内找到针对该值的测试；它是连接串常驻项，行为只能靠引擎注释佐证。
5. **`Max Pool Size=16` 到 `100` 的差异**：测试 TODO 里写了 "Max Pool Size=100 下极端并发（>100 写请求）的排队行为"，但主连接串实际是 16 — TODO 文本与实现数值不一致，未考证哪个先写错。
6. **事务内非事务查询混入（SQLite/MySQL 单连接隐患）的真实触发案例**：文档背景声称存在（"事务期间的非事务查询隐式混入当前事务"），但未给出具体事故/issue 号；改造动机可能含推断成分。
7. **旧 VRCX 根血统中 `SQLite.cs`/适配器的历史起点**：本次只考证了 database-refactor（2026-07~08）以来的提交；更早的 VRCX 官方血统里"单连接 + ReaderWriterLockSlim"的引入提交未回溯。
