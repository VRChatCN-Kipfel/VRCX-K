# 07 Dotnet/ 目录勘察：本 org 原创的 MySQL/PG 支持与测试策略

> 勘察对象：`origin/old/main`（HEAD `e4ec5611`，2026-08-24）。只读勘察，未改 tracked 文件。
> 原始材料临时导出在 `.temp/recon-t7/`（gitignore，可随 .temp 删除；本 md 为勘察唯一正式副本）。
> 关联：t2 产出 `.temp/legacy-recon/02-sqlite-implementation.md`（JS 侧事务设计）；本文件从 C# 侧看同一设计，并聚焦 **MySQL.cs / PostgreSQL.cs / IAuthStore.cs / VRCX.Tests**。
> 血统结论（作者分布，`git log origin/old/main --format=%an -- <file>` 统计）：**MySQL.cs（38 commits）与 PostgreSQL.cs（28 commits）为 XChen446(33/25) + RainyN0077(3/2) + 1zyao(2/1) 全 org 作者提交；VRCX.Tests/* 13 个文件全部 org 提交；IAuthStore.cs 仅 XChen446 1 commit。** 上游 VRCX 官方无 MySQL/PG 后端 → 这是本 org 从零加的多引擎支持。

---

## 0. 总览：本 org 在 Dotnet/ 做了什么

按时间线（提交消息原文，见 §3 清单）重建的动机链：

1. **2026-07-18**：`d1bb45f7 feat(C#MySQL): 添加 MySQL 数据库初版前置集`、`2904d1c4 feat(C#PgSQL): 添加 PostgreSQL 数据库初版前置集` — 同一天起两条引擎线。动机（从提交消息与文件头 Phase 标注推断）：VRCX 桌面版数据要上服务器（多人共享/异地），或用户自建后端替代本地文件。
2. **2026-07-19~22**：`89c98f13 feat(C#PostgreSQL): Init 5 字段配置 + 池化 + 健康检查 + 4 处桥注册 (task 9.2 + 9.14)`、`b230041d feat(MySQLAdapter/8.9): MariaDB 兼容适配`、`905bead5 feat(MySQLAdapter/8.4): DDL 类型映射 + createIndex 幂等 + maintenance`、`0d839997 feat(C#MySQL/8.3): 添加连接字符串重载，支持外部数据库操作`、`631afe0b feat(database): MySQL 对齐 PgSQL 跨引擎迁移链路 + 全栈偏心点修正` — 三引擎对称性成为主线；外部数据库（迁移目标）支持出现。
3. **2026-07-25~26**：`1c645955 feat(Adapter): SQLite/MySQL C# 层 + JS 适配器统一池化事务 API`、`9b03dbb6 feat(C#SQL): SQLite/MySQL 真正池化,与 PG 对称`、`74fda9b1 feat(C#PgSQL): 持连接事务 API + sliding 超时`、`5ba6ebb6 fix(C#SQL): Timer 排队竞态防御`、`57d366d2 fix(C#SQL): Timer 竞态完全闭环`、`3a4fd2b8 perf(C#SQL): 三引擎对称 MinimumPoolSize=1 保活` — 事务 pin 机制由 PG 发明后回灌 SQLite/MySQL；池参数三引擎对称。
4. **2026-07-26~30**：`6bf9a0f1 feat(db): 三引擎连接池三态计数器 + GetPoolStats (Issue #14)`、`8aa06768 feat: 点击清空空闲连接池 + 确认框 (Issue #15)`、`2f8ff620 feat(GetPoolStats): 三引擎新增 idleInPool/totalOpen 扩展字段 (PG 反射真值)`、`9351b097 fix: cookies 持久化解耦至当前激活引擎 + 纳 GLOBAL_TABLES 统一迁移`、`1f8324e7 feat(Dotnet): DataSource cache for Execute*OnConnection`、`2f49474c fix(SQL*): connId 类型 long? → object? 修 CefSharp 转换`、`9669198b / e190298b fix(C#PgSQL): args 类型 object[]? → object? 修 CefSharp List<object>`、`0c3cb1f5 / e9b9101c feat(C#*): *BeginTransactionOnConnection`、`9b4228ee fix(SQLite): BeginTransactionOnConnection 改名` — 桥（CefSharp/Electron）边界反复修类型截断；写漏斗（变更订阅）与 pool stats 上线。
5. **2026-08**：`80f07292 feat: 数据库变更订阅 — 三端写漏斗实时层 + 计数器完备层 + PG 原生推送`、`387f0761 fix: MySQL migration interop & row-count verification`、`fbd5c7bb chore(C#SQL): MySQL/PG 连接池上限 100 降至 16,与 SQLite 对称`、`6f12a1d6 fix(database): release failed pool borrows (#30)` — 收尾：池上限回归 16 对称、失败借出计数泄漏修复。

**一句话**：本 org 花了 66 commits 造"三引擎对称的数据库后端 + 桥 + 事务 pin + 池监控 + 变更订阅"全栈，全部从零写（无上游参照），且自始至终被 **CefSharp/Electron 桥的类型截断**问题追着打。

---

## 1. 多引擎抽象在 C# 侧怎么做

### 经验点 1：公共面镜像（Mirror public surface of SQLite）—— 非接口继承，是"约定同构 + 小接口"

- **解决什么问题**：JS 适配器层要能无感换引擎，C# 桥三类的**调用形状**必须一致。
- **方案**：三个类（`SQLite` / `PostgreSQL` / `MySQL`）**不共享基类**，各自定义相同方法名/签名簇：
  - `Init()`（读 `VRCX_Database.*` 配置建连接串/DataSource）、`Exit()`；
  - `Execute(sql, args?, connId?)` / `ExecuteNonQuery` / `ExecuteJson` 三件套 + `*OnConnection`（外部连接）版本；
  - 事务五件套：`BeginTransaction()` / `BeginTransactionOnConnection(cs)` / `CommitTransaction(connId)` / `RollbackTransaction(connId)` / `KeepAliveTransaction(connId)`；
  - 健康四件套：`IsConnected()` / `Ping()` / `GetHealth()` / `GetPoolStats()` / `ClearIdleConnections()`；
  - 都实现 `IAuthStore`。
  - PostgreSQL.cs:14-25 注释明写 "Mirrors the public surface of SQLite so that the JS adapter layer can call the same patterns"；MySQL.cs:13-35 同。
- **代价 / 陷阱**：同构靠约定而非编译器强制 → **签名漂移风险高**，他们用测试钉住（见经验点 9：BridgeTestHelper 用反射 `GetMethodOrFail` 精确参数类型定位，签名漂移即 Fail）。这也是 org 自承的"桥回归测试"核心动机。
- **证据**：PostgreSQL.cs:14-25；MySQL.cs:13-35；`GetMethodOrFail` BridgeTestHelper.cs:54-71。
- **与我们的差异**：我们只有 bun:sqlite 单引擎，无跨引擎公共面需求；但"跨边界（进程/语言/桥）API 的形状一致性用测试钉死而非口头约定"是通用教训。

### 经验点 2：`IAuthStore` —— 引擎无关的凭证表契约（org 原创，全权作者）

- **解决什么问题**：主账号 cookie（`key="default"`）要持久化，且持久化目标必须是**当前激活的引擎**（SQLite/MySQL/PG 任一），不能有"双引擎并存"的 init 二象性。这是引擎切换的关键解耦点。
- **方案**：`internal interface IAuthStore`（仅 3 方法）：`EnsureCookiesTable()`（幂等建表，引擎原生 DDL）/ `LoadCookie(key)` / `SaveCookie(key, value)`。注释明确"cookies 表以引擎原生 DDL/SQL/参数风格在每个实现内创建与查询，隐藏驱动差异（命名 vs 位置参数、INSERT OR REPLACE vs ON DUPLICATE KEY vs ON CONFLICT、TEXT vs VARCHAR/LONGTEXT）"（IAuthStore.cs:3-17）。
- **三引擎实现对照**（方言差异的浓缩样本，全部 org 写）：
  | 引擎 | DDL | upsert | 引用 |
  |---|---|---|---|
  | SQLite | `\`key\` TEXT PRIMARY KEY, \`value\` TEXT`（SQLite.cs:984-988） | `INSERT OR REPLACE`（:1000-1005） | 反引号（沿用原 WebApi 风格） |
  | MySQL | `\`key\` VARCHAR(255) PRIMARY KEY, \`value\` LONGTEXT`（MySQL.cs:666-670） | `REPLACE INTO`（:682-687） | 反引号 + `@key` 命名参数 |
  | PG | `public.cookies (key TEXT PRIMARY KEY, value TEXT)`（PostgreSQL.cs:1257-1261） | `INSERT ... ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`（:1273-1279） | 位置参数 `$1/$2` |
  - PG 用 `public.` 模式前缀（:1253-1254 注释：与 PgSQLAdapter 全局表 `public.<tbl>` 命名约定一致）。
  - 列类型映射：MySQL 用 `VARCHAR(255)`+`LONGTEXT`，PG/SQLite 用 `TEXT` — 三处 DDL 语义统一为"能装序列化 CookieCollection"。
- **代价 / 陷阱**：契约刻意只盖"主账号 cookie"；副账号 cookie 在 JS `WebApi._secondaryClients` 内存 map，不落库（IAuthStore.cs:14-16）——**范围刻意收窄**。
- **证据**：IAuthStore.cs（全文 38 行）；SQLite.cs:979-1005；MySQL.cs:660-687；PostgreSQL.cs:1251-1279。
- **与我们的差异**：凭证（登录态 cookie）落库的"最小接口 + 引擎原生 DDL"模式，是我们若用 bun:sqlite 存凭证可直接对照的形态；且副账号只存内存、主账号才落库的取舍值得记录。

### 经验点 3：配置读入与连接串构建 —— 每引擎不同安全姿势

- **解决什么问题**：`VRCX_Database.{host,port,username,password,name}` 这 5 个引导字段（PG/MySQL）要被构造成驱动连接串；用户输入不可信 → 连接串注入防护。
- **方案**：
  - **PG**：`ValidateField`（host/username/name 各配白名单正则 `[A-Za-z0-9._-]` / `[A-Za-z0-9_]` + 禁 `;'"\0\n\r`）+ `ValidatePassword`（禁 `;'"\0`）+ `ValidatePort`（1..65535，默认 5432）（PostgreSQL.cs:433-456, 1205-1233）。**密码也走字符黑名单**（不拒绝特殊字符，只拦能拆连接串/引号注入的）。
  - **MySQL**：直接读字段 + `MySqlConnectionStringBuilder` 强类型设置（Server/Port/UserID/Password/Database/...）；port 解析失败默认 3306；**host/database 缺失时报错**（MySQL.cs:233-279）。`ApplyUserOptions` 把 `VRCX_Database.options.*` 用户选项白名单合并进 builder（仅 sslmode/allowuservariables/useaffectedrows/connectiontimeout/defaultcommandtimeout 5 键；`_` 前缀键当注释跳过；MySQL.cs:293-327）。
  - **SQLite**：t2 已详述（路径规范化/穿越防护/PRAGMA 键值白名单），此处不重复。
- **代价 / 陷阱**：PG 用"正则白名单 + 黑名单双闸"，MySQL 用"builder 强类型 + options 白名单" — 姿势不同但都达到"用户配置进 SQL 执行路径前必须过闸"。MySQL 侧 options 只覆盖 5 个连接参数，`VRCX_Database.options.*` 的其余键被静默忽略（不报错）。
- **证据**：PostgreSQL.cs:433-470, 1205-1233；MySQL.cs:228-327。
- **与我们的差异**：bun:sqlite 无连接串语法，注入面小；但"配置字段白名单 + options 键白名单"的分层是任何"用户可配置数据库参数"场景的模板（尤其 options 里 `_` 前缀注释键的约定很容易被忽略却有用）。

### 经验点 4：池化的 C# 侧形态 —— 三驱动三种池抽象，统一到"DataSource + 借还"

- **解决什么问题**：三引擎要暴露**同一套池语义**（借连接→用→还），但驱动池 API 不同。
- **方案**：统一抽象为"DataSource 持有池 + OpenConnection 借 + Dispose 还"：
  - PG：`NpgsqlDataSourceBuilder` → `_dataSource.Build()`；连接串 `Maximum Pool Size=16; Minimum Pool Size=1; Connection Idle Lifetime=300; Timeout=15; CommandTimeout=30`（PostgreSQL.cs:458-475）。**MinimumPoolSize=1** 预热保活：池在空闲剪枝时不剪到低于 1，挂机数小时后下一次查询不必重建 TCP+认证（异地 PG 可达 200ms+）；建连惰性 → PG 不可达时 `Init()` 不失败，失败推迟到首次 Open（:461-467 注释明写，与 MySQL 对称）。
  - MySQL：`MySqlConnectionStringBuilder`（`Pooling=true; MaximumPoolSize=16; MinimumPoolSize=1; ConnectionIdleTimeout=300; ConnectionTimeout=15; DefaultCommandTimeout=30; AllowUserVariables=false; UseAffectedRows=true; SslMode=Preferred`）→ `new MySqlDataSource(...)`（MySQL.cs:256-284）。`UseAffectedRows=true` 让 `ExecuteNonQuery` 返回 affected rows 与 SQLite/PG 一致（提交 daf28e39 Gito #7）。
  - SQLite：System.Data.SQLite `Pooling=True; Max Pool Size=16`（t2 已述）。
  - 演变证据：MySQL 初版是裸 `MySqlConnection(connStr)` 每次 new+Open（提交 20cb5c4c diff 显示 `_connectionString` → `_dataSource` 重构，提交消息 "refactor(MySQL): 引入 MySqlDataSource 对齐 PG 连接管理模式"）；即**PG 先确立 DataSource 模式，MySQL 后被拉齐**。
- **代价 / 陷阱**：
  - 池上限先 100 后降 16（`fbd5c7bb chore(C#SQL): MySQL/PG 连接池上限 100 降至 16,与 SQLite 对称`）—— 对称性优先级高于各驱动默认。
  - `Connection Idle Lifetime=300`（PG）与 `ConnectionIdleTimeout=300`（MySQL）刻意对称；`Timeout=15`/`CommandTimeout=30` 也是跨引擎对称值（PostgreSQL.cs:468-470 注释逐条标注"对称 MySQL ConnectionTimeout=15 / DefaultCommandTimeout=30"）。
- **证据**：PostgreSQL.cs:458-475；MySQL.cs:256-284；提交 20cb5c4c、fbd5c7bb、3a4fd2b8（perf(C#SQL): 三引擎对称 MinimumPoolSize=1）。
- **与我们的差异**：我们 bun:sqlite 单连接无池；但"最小保活 1 条 + 池上限对称 + 超时对称"的池参数纪律（尤其面对异地 200ms 延迟的预热动机）是写任何长期驻留 DB 层时的参考。

---

## 2. 事务 / pin 机制的 C# 侧实现（t2 的 JS 侧对应面）

### 经验点 5：`_pinned` ConcurrentDictionary + `TxHolder` — 事务与物理连接绑定的登记处

- **解决什么问题**：JS 层 `withTransaction` 需要"后续所有 SQL 打到同一物理连接"。C# 侧要为每个进行中的事务登记一条**被 pin 的连接**，并让它可被 JS 侧 connId 寻址。
- **方案**（三引擎同构，PostgreSQL.cs:267-303 为典型）：
  - `_pinned: ConcurrentDictionary<long, TxHolder>`；`_nextConnId`（Interlocked 递增）产生单调 connId。
  - `TxHolder` 字段：`Conn`（物理连接）、`Tx`（NpgsqlTransaction，仅 PG 有显式事务对象；SQLite/MySQL 用 `BEGIN` SQL）、`Timer`（sliding 超时）、`InFlight`（执行中 SQL 计数）、`TimedOut`（超时已标记）、`Changes`（事务内表级写计数）、`ConnLabel`（"default" 或外部 connectionString）。
  - `BeginTransaction()`：`Interlocked.Increment(_nextConnId)` → `_totalBorrowed++` → `OpenConnection()` 借连接 → 开事务 → `new Timer(OnTxTimeout, TX_IDLE_MS, -1)` → `_pinned[connId] = holder`；**finally 里 `if (!_pinned.ContainsKey(connId)) Decrement(_totalBorrowed)`** — 借出失败（Open/BEGIN 抛错）时回收借用计数（提交 6f12a1d6 "fix(database): release failed pool borrows (#30)"；PostgreSQL.cs:1013-1042, 1054-1082）。
  - `CommitTransaction(connId)`：`_pinned.TryRemove`（不在则抛 "connId 已超时回滚或不存在"）→ **锁外** COMMIT + dv 读 + Dispose 还池 → **锁外** EmitChange（避免事件编组重入锁；PostgreSQL.cs:1089-1140）。
  - `RollbackTransaction(connId)`：`TryRemove` 不在则静默 no-op（不抛错，JS catch 可无条件调用）；在则 Timer.Dispose + 计数归零 + CleanupTx（:1148-1157）。
  - `KeepAliveTransaction(connId)`：只 `Timer.Change(TX_IDLE_MS, -1)` 不执行 SQL；返回 bool（:1168-1179）。
- **代价 / 陷阱**：connId 出现的根本原因是**驱动池不提供"这次调用用哪条连接"的句柄**；connId 是 JS 世界与 C# 池之间的代金券。设计对齐在 t2 已述（栈 + 队列），此处不再重复。
- **证据**：PostgreSQL.cs:267-303, 898-1000, 1013-1179；MySQL.cs:89-117, 771-856, 869-1033；SQLite.cs:96-114（t2 已引）。
- **与我们的差异**：bun:sqlite 单连接下"pin"是恒真（所有 SQL 本来就同连接），无需 connId 代金券；但"借出计数必须以最终入册为准"（TryRemove/ContainsKey 核对）是通用资源池纪律。

### 经验点 6：sliding 超时的 C# 侧实现 — Timer 暂停/恢复 + InFlight/TimedOut（防御）

- **解决什么问题**：防事务泄漏（JS 忘 commit）与真卡死（await 悬挂）→ 60s 自动回滚。
- **方案**（PostgreSQL.cs 与 SQLite.cs 逐行同构）：
  - `TX_IDLE_MS = 60000`（PostgreSQL.cs:282；曾 30s → 60s，`45f2979a chore(C#SQL): TX_IDLE_MS 30s → 60s,给异地高延迟更多余量`）。
  - `BeginTransaction` 时 `new Timer(_ => OnTxTimeout(connId), null, TX_IDLE_MS, -1)`。
  - 每个 pinned SQL：锁内 `TryGetValue + InFlight++ + Timer.Change(Timeout.Infinite, -1)`（暂停），finally 锁内 `InFlight--` + 若 `TimedOut` 则自行清理（TryRemove + Timer.Dispose + 计数 + CleanupTx），否则 `Timer.Change(TX_IDLE_MS, -1)`（恢复）（PostgreSQL.cs:898-1000）。
  - `OnTxTimeout`：锁内 `TryGetValue`；`InFlight > 0` 时**不 Dispose**，置 `TimedOut=true` 让 SQL 执行完的 finally 收尾（防 ObjectDisposedException）；否则直接清理（:1181-1201）。
  - **关键正确性注释**（PostgreSQL.cs:900-906）：TryGetValue 与 InFlight++/Timer.Change **必须在同一 `_txLock` 内**，否则 OnTxTimeout 可能在两者之间排队看到 InFlight=0 立即清理，随后本方法拿到已 Dispose 的连接 → ObjectDisposedException，且 `_activeCount/_pinnedActive` 永久泄漏（finally 不执行）。这是 t2 里 28ceda93（TOCTOU 计数器泄漏）的 C# 侧完整表述。
- **代价 / 陷阱**：全部状态变更在单一 `_txLock` 内（锁提供 happens-before，注释明说无需 Interlocked/volatile）；只有跨锁路径的计数器（`_totalBorrowed/_activeCount/_pinnedActive`）用 Interlocked。
- **证据**：PostgreSQL.cs:278-303, 898-1000, 1181-1201；提交 28ceda93、5ba6ebb6、57d366d2、7a01f818（fix(C#SQL): 修复慢查询竞态 — SQL 执行期间暂停 sliding Timer）。
- **与我们的差异**：bun:sqlite 同步 API 无 Timer 竞态；若我们自建"空闲超时自动回滚"，"锁内登记/暂停、finally 恢复/收尾、超时回调只标脏"的三段式是经过 bug 打磨的模板。

### 经验点 7：`BeginTransactionOnConnection` — CefSharp 同名重载解析逼出来的改名

- **解决什么问题**：事务 pin 到**外部数据库文件/服务器**（push 源 / pull 目标）时，`BeginTransaction(connectionString)` 带参版本与无参版本构成**同名重载**；CefSharp 绑定同名重载时解析行为不可靠（会选错或抛歧义）。SQLite 侧提交 `9b4228ee fix(SQLite): BeginTransaction 重载改名 BeginTransactionOnConnection 规避 CefSharp 同名重载解析`；PG/MySQL 在加功能时直接用了新名（`0c3cb1f5 feat(C#PgSQL): PostgreSQL BeginTransactionOnConnection + Execute*OnConnection connId`、`e9b9101c` 同 MySQL）。
- **方案**：C# 方法直接改名，JS 桥同步改名（SQLiteAdapter.js `_doBegin` 等），globals.d.ts 三份类型声明同步（9b4228ee diff 可见）。`BeginTransactionOnConnection(connectionString)` 从 `DataSourceCache` 取/建外部 DataSource → 借连接 → BEGIN → TxHolder（ConnLabel=connectionString）→ 同一 `_pinned` Map 登记 → connId 与主池事务**共用一套** Commit/Rollback/KeepAlive/Timer/OnTxTimeout。
- **代价 / 陷阱**：这是"被桥的怪癖追着改 API 形状"的直接实例。同族修复：`2f49474c fix(SQL*): Execute*OnConnection connId 类型 long? → object? 修复 CefSharp Int32 → Nullable<Int64> 转换`、`9669198b fix(C#PgSQL): Execute*OnConnection args 类型 object[]? -> object? 修复 CefSharp List<object> -> object[]`、`5c30bc63 fix: 重命名 ExecuteJson/ExecuteNonQuery connectionString 重载避开 CefSharp 3 参重载歧义`。CefSharp 把 JS 值封送成 `Int32`/`List<object>`，反射无法直接 unbox 到 `long?`/`object[]` → 所有跨桥方法签名用 `object?` + 域内归一化（`NormalizeConnId` / `NormalizeArgs`）。
- **证据**：9b4228ee 完整 diff（改名 + JS 侧 4 文件 + globals.d.ts 三份）；PostgreSQL.cs:1013-1042；MySQL.cs:869-903；PostgreSQL.cs:1292-1328（NormalizeConnId/NormalizeArgs）。
- **与我们的差异**：我们无 C# 桥；但"宿主框架会在边界悄悄转换类型（Int32→long？会抛、数组变 List）"是任何跨语言桥的经验——**接口参数宁可宽（object）再域内断言，也别窄到会被宿主截断**。

### 经验点 8：`DataSourceCache` — 外部连接按连接串复用 DataSource（迁移性能）

- **解决什么问题**：push/pull 迁移期间同一外部 .db / 服务器要开合数千次；每次 `new DataSource` 浪费（建池/TCP/认证成本）。
- **方案**：`static ConcurrentDictionary<string, NpgsqlDataSource>`（PG）/ `MySqlDataSource`（MySQL）/ `SQLiteConnection`（SQLite，t2 已述），`GetOrAdd(connectionString, cs => ...)`（PostgreSQL.cs:280, 516, 637, 1015-1016；MySQL.cs:95, 871-872）。进程级存活不回收；CEF 消息泵串行化 JS 调用 → 无需加锁。
- **代价 / 陷阱**：进程级常驻不回收 — 外部库句柄长期存活；作者接受（迁移场景有限个连接串）。
- **证据**：PostgreSQL.cs:280, 507-526, 629-648, 1013-1042；提交 1f8324e7 feat(Dotnet): DataSource cache for ExecuteJsonOnConnection/ExecuteNonQueryOnConnection。
- **与我们的差异**：多库场景（若我们做迁移）"按连接串缓存连接实例"是直接的性能模板。

---

## 3. 变更订阅（写漏斗）的引擎分叉 —— 三引擎同一契约、三种检测机制

### 经验点 9：三引擎写漏斗 + 完备层计数器 — "检测机制允许引擎异构"

- **解决什么问题**：JS `onTableChange` 需要"库被改了"的实时通知（含**外部进程**写入）。三引擎检测能力差异巨大，但上层接口必须统一。
- **方案**（PostgreSQL.cs:30-239 最完整）：
  - **统一载荷**：`{ conn, table, count, ts, dv }` JSON；`conn="default"` 或 connectionString；dv 是 DB 级变更计数器。
  - **SQLite**：C# 漏斗（事务内 `RecordChange` 累积表级写计数，COMMIT 后按表发射）+ `PRAGMA data_version` 观察连接兜底（t2 已述）。**dv 读自专用观察连接**（写者连接读不到自己的递增）。
  - **MySQL**：漏斗同构 + dv 读 `performance_schema.table_io_waits_summary_by_table` 聚合（MySQL.cs:142-156）—— **无观察连接问题**（服务端计数任意连接视角一致，注释明写 "MySQL 无 SQLite 的写者连接滞后问题"）。
  - **PG**：漏斗同构 + **原生 `LISTEN/NOTIFY` + 触发器**（PG 专属）替代计数器轮询为主路径：`EnsureChangeFunction`（CREATE OR REPLACE FUNCTION plpgsql，payload=模式限定表名）、`CreateChangeTrigger`（AFTER INSERT/UPDATE/DELETE FOR EACH STATEMENT；先 DROP IF EXISTS 再 CREATE）、`ChangeListenerLoop`（后台任务 LISTEN + `conn.WaitAsync`，30s 重连；随门控启停，无消费者时监听连接不存在）、`ListChangeTriggers`（information_schema 查询）（PostgreSQL.cs:87-240）。
  - **去重**：漏斗与 NOTIFY 对自写双发 → 漏斗按表记录发射时间，监听侧 500ms 窗口内 NOTIFY 视为自写镜像丢弃（`IsSelfMirror` + `_lastFunnelEmitTicks`，2048 上限 + 窗口外清理）；窗口误杀的外部写由计数器兜底（≤5s）补上（PostgreSQL.cs:76-84, 169-174, 345-365）。
  - **门控**：`SetChangeEnabled(bool)` — JS 首个订阅时开启、最后退订时关闭；无消费者时 EmitChange 首行早退，写路径零开销（volatile，事件回调线程 ≠ JS 调用线程）。
  - **dv 语义**：PG `pg_stat_user_tables` 的 n_tup_ins/upd/del 聚合（只计真实行变更，只读事务不计入，避免兜底网被高频查询打满）（PostgreSQL.cs:330-343）。
- **代价 / 陷阱**：每张 watched 表一个 FOR EACH STATEMENT 触发器（消费方负责安装）；NOTIFY 负载仅表名（statement 级触发器无行数）→ 事件 `count=-1` 全量失效。表名白名单正则 `^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?$`（防 SQL 注入，与触发器 DDL 同一事实源）。
- **证据**：PostgreSQL.cs:30-240, 330-365；MySQL.cs:119-156；SQLite.cs:881-915（观察连接）。
- **与我们的差异**：我们单机单进程单文件，外部写入者场景"检测机制按引擎异构、接口统一、计数器兜底"是最可借鉴的结构——即使我们用 bun:sqlite，`data_version` 计数 + 事件门控（有消费者才发）的思路可直接采用。

---

## 4. 测试策略：给 C# 数据库适配器写单测的整套做法

### 经验点 10：`Link + stub` 测试方案 — 不 ProjectReference 生产工程，不碰静态单例

- **解决什么问题**：要给 `SQLite.cs`/`PostgreSQL.cs`/`MySQL.cs` 写单测，但直接引用生产工程会拖入 Cef 的 windows TFM + CefSharp + Silk.NET + System.Management 依赖；且静态单例（`SQLite.Instance`/`VRCXStorage.Instance`）跨测试并行会竞态。
- **方案**（VRCX.Tests.csproj 明写，是本 org 首创的工程决策）：
  - `<Compile Include="..\SQLite.cs" Link="SQLite.cs" />` — 生产文件**直接编译进测试 assembly**（同 assembly internal 可见 → 不需要 `[InternalsVisibleTo]`，不需改生产代码的访问修饰符）。
  - 测试工程自备 `Stubs/ProgramStub.cs`（`Program.AppDataDirectory` 可写字段 + `ConfigLocation` 可写属性，刻意省略其余成员）与 `Stubs/VRCXStorageStub.cs`（`Get`/`GetWithPrefix`/`Clear`/`Set`，误调时 fail-fast 返回 null/空）。生产 `Program.cs` 零改动。
  - TFM `net10.0`（无 -windows 后缀，Linux CI 可跑）+ xUnit 2.9.2 + FluentAssertions 6.12.2 + Coverlet 6.0.2（无 threshold）+ System.Data.SQLite 2.0.3（纯 managed，安全测试不调 Init()，不需要 native 运行时）+ Npgsql 10.0.3 + MySqlConnector 2.6.1（与生产 pin 一致）。
  - `[Collection("SQLiteStaticState")]` + `ICollectionFixture<SQLiteStaticStateFixture>`：xUnit 同 collection 串行、不同 collection 并行；fixture 保存/还原 Program 静态字段原值（SQLiteTestCollection.cs 全文 53 行）。触碰静态状态的测试入 collection，纯函数测试（如 PG/MySQL NormalizeConnId）**默认并行**（MySqlBridgeTests.cs 头部注释明写理由）。
  - `NoWarn` 长清单（CS8618/CS8603/CS8601/CS8625/CS8604/CS8605/CS8600）：Link 生产文件 + stub 故意可空 → 静态告警在测试构建抑制，生产构建不受影响。
- **代价 / 陷阱**：设计稿注释自曝该方案演变（原 ProjectReference 方案需改 Program.cs private set → internal set；后来换 Link+stub 避免改生产代码）。stub 与生产代码同命名空间（`namespace VRCX`）才能让 Link 的 SQLite.cs 编译通过。
- **证据**：VRCX.Tests.csproj 全文；SQLiteTestCollection.cs；Stubs/ProgramStub.cs；Stubs/VRCXStorageStub.cs。
- **与我们的差异**：我们用 bun:sqlite（无 C# 桥、无静态单例），不需要 Link+stub；但"把生产源文件直接编进测试工程以测 internal 方法、用 collection fixture 钉死静态状态串行"是给"难测的桥/静态单例层"补单测的成熟套路。

### 经验点 11：`SQLiteRetryTests` — 断言重试与退避的契约数值（而非实现细节）

- **解决什么问题**：给重试逻辑（`ExecuteWithRetry`/`CalculateRetryDelay`/`IsRetryableSqliteException`）与桥类型归一化（`NormalizeConnId`）钉住契约。
- **方案**（SQLiteRetryTests.cs 264 行，19 用例）：
  - `NormalizeConnId` 10 条（null/DBNull/Missing → null；int/long/整值 double → long；3.14/NaN/±Infinity/string → ArgumentException）。
  - `IsRetryableSqliteException` 3 条（Busy→true、Locked→true、Corrupt→false）。
  - `ExecuteWithRetry` 4 条（首次成功、第 2 次成功、**耗尽 6 次后抛**（1 初试 + 5 重试）— 断言 `callCount == 6`、非重试异常立即抛）。
  - `CalculateRetryDelay` 2 条（attempt=1 → [37,63]（50±25%）；attempt=5 → ≤2000 上限）。
  - **技巧**：`CreateSqliteException` 用 `RuntimeHelpers.GetUninitializedObject` + 反射设私有字段构造 SQLiteException —— 因为其公开构造会调 `GetErrorString()` 需要 native DLL；**纯 managed 环境构造驱动异常**（34-50 行注释）。
- **代价 / 陷阱**：契约数值直接对应生产常量（MaxRetryAttempts=5、RetryBaseDelayMs=50、RetryMaxDelayMs=2000）—— 测试把"对外行为"与"内部常量"绑死；改重试策略必须同步改测试（这是特性也是维护成本）。
- **证据**：SQLiteRetryTests.cs（全文）；对应生产 SQLite.cs:828-858, 964-977。
- **与我们的差异**：若我们实现重试/退避，这套"耗尽次数、延迟区间、异常可重试性"的契约断言可直接照搬；`GetUninitializedObject` 造驱动异常技巧是给"构造器依赖 native"的异常类型补测试的通用招。

### 经验点 12：`SQLiteSecurityTests` — 60 个安全用例，测试即规范（含"以实际代码修正设计稿"的实践）

- **解决什么问题**：路径验证器 + PRAGMA 净化器安全加固的回归护栏（46 方法 / 60 执行用例）。
- **方案**（SQLiteSecurityTests.cs 669 行）：
  - 8 类用例：PathTraversal(8) / NullByteInjection(5) / PragmaInjection-KeyWhitelist(7) / PragmaInjection-ForbiddenKeyBlacklist(7) / PragmaInjection-ValueCharBlacklist(4) / QuoteInjection(3) / Boundary(8) / HappyPath(4)。每类 Map 到生产 SQLite.cs 的具体行号。
  - 每个测试构造隔离临时目录（`Path.GetTempPath() + Guid`），Setup/Teardown 保存还原 Program 静态字段 + 删除临时目录（try/catch 吞删除失败防掩盖测试失败，56-80 行）。
  - **测试即规范**：三种"设计稿与实现不一致"在文件头显式记录（差异 1：错误消息以实际代码为准即 `not an absolute path`；差异 2：null 注入消息以实际代码 `ASCII letters` 为准；差异 3：`D:` 裸盘符跨平台行为分支断言（Windows 抛扩展名错误、Linux 抛绝对路径错误），不跳过）。
- **代价 / 陷阱**：这是"安全场景用测试当 spec"的完整样本 —— 边界、注入、黑名单逐条落测试，且不一致之处**改测试而非改实现**（注释说明差异属"主设计文档预期 vs 实际代码"，以实际代码为准）。
- **证据**：SQLiteSecurityTests.cs:1-80（策略 + 差异记录）；:82-180（用例）。
- **与我们的差异**：若我们给 bun:sqlite 的路径/配置做安全护栏，这套用例矩阵（遍历/注入/黑名单/边界/快乐路径 + 平台分支）是现成大纲。

### 经验点 13：`SQLitePoolStatsTests` / `MySqlPoolStatsTests` / `PostgreSqlPoolStatsTests` — 失败路径借用计数归零（#30 回归）

- **解决什么问题**：`6f12a1d6 fix(database): release failed pool borrows (#30)` 的回归测试 —— 每次失败调用（Ping/GetHealth/Execute/ExecuteNonQuery/BeginTransaction/BeginTransactionOnConnection 抛错）后，`availableCapacity` 必须回到 16（无借用计数泄漏）。
- **方案**：三文件同构（SQLite 174 行 / MySQL / PG）：
  - SQLite：`SetConnectionString` 反射把 `_connectionString` 换成无效值 → 24 次失败调用 → 断言 `availableCapacity == 16`（SQLitePoolStatsTests.cs:9-139）。`CreateInitializedSqlite` 用临时文件 + `VRCXStorageStub.Clear/Set` 构造真实例。
  - MySQL/PG：**本地 refused 端点**（`IPEndPoint` + 无监听 socket）触发连接拒绝，无需真服务器/网络（MySqlPoolStatsTests.cs 头部注释明写）。
  - 6 个失败入口 × 24 次循环 —— 压着计数泄漏类 bug。
- **代价 / 陷阱**：24 次循环是要让"泄漏"从 1 变成可断言差异；若泄漏是每失败 +1，16 max 容量 24 次后必然穿帮。断言值写死 16（与池上限绑定），池上限改动需同步。
- **证据**：SQLitePoolStatsTests.cs（全文）；MySqlPoolStatsTests.cs / PostgreSqlPoolStatsTests.cs 头部；提交 6f12a1d6。
- **与我们的差异**：资源计数（借出/活跃）泄漏是任何池/缓存层的通病；"每个失败入口 × 多轮 × 断言容量回到基线"是通用回归模板，"用本地 refused 端点模拟服务器不可达"无需外部依赖值得记录。

### 经验点 14：`*BridgeTests` + `BridgeTestHelper` — 跨桥签名契约用反射钉死，绝不 Skip

- **解决什么问题**：PR #17 修复（`Execute*OnConnection` connId `long?`→`object?` + `NormalizeConnId`）很容易被后来者"回退签名"（比如把 connId 改回 `long?`）重新破坏；并且 CefSharp 桥封装会引入"绑定层 ArgumentException"与"域内 ArgumentException"两种形态，不能简单断言抛错。
- **方案**（BridgeTestHelper.cs 135 行 + 三个 BridgeTests）：
  - `GetMethodOrFail(type, name, params Type[])` — 以**精确参数类型数组**反射定位 public 方法；定位失败（签名漂移）即 `Assert.Fail("... 回归 (PR #17 修复目标)")`，**绝不 Skip**（54-71 行）。
  - `AssertDomainException` — 桥接调用判别器三重判定（77-103 行）：① 裸 ArgumentException（反射绑定层）→ Fail；② `TargetInvocationException` 内层必须为消息含 "connId" 的 ArgumentException → pass；③ 未抛异常 → Fail。
  - 数据单一事实源：`ValidNormalizeCases`（5 条 MemberData）+ `InvalidNormalizeCases`（8 条）在 Helper 集中，PG/MySQL 共享（111-134 行）。
  - 坑记录在文件头（F2）：`Missing.Value` 不能进 xUnit Theory MemberData（反射绑定器把它当"参数默认值"标记 → 抛 "Missing parameter does not have a default value"）→ 从 MemberData 移出，用独立 [Fact] 覆盖（36-42 行）。
  - 三文件覆盖分布：SQLite 13 条、PG/MySQL 各 23 条；`NormalizeConnId` 全量 14 条（有效 6：null/DBNull/Missing/1/999L/3.0d；无效 8）+ 桥接 9 条（3 方法 × 3 无效值 3.14d/NaN/"abc"）。
- **代价 / 陷阱**：反射 GetMethod 对参数类型数组敏感（`IDictionary<string,object>` vs `object` 都要精确）—— 测试与签名强耦合是刻意的（防漂移）。xUnit 反射怪癖（Missing.Value）是踩出来的真实平台坑。
- **证据**：BridgeTestHelper.cs（全文）；三个 BridgeTests 头部注释。
- **与我们的差异**：跨语言/跨进程桥的**参数类型契约**若有"被悄悄放宽/回退"的历史，用"反射精确定位 + 域内异常判别器 + 单一事实源数据"钉死是教科书做法；"签名漂移断言不跳过"的态度也值得记录。

### 经验点 15：测试文件名即契约目录 —— 组件 Traits + 用例计数注释

- **解决什么问题**：10+ 测试文件如何让读者 30 秒内知道覆盖范围与设计意图。
- **方案**：每个文件头一个长注释块：用途 / 设计稿出处（阶段编号）/ Link 依赖策略 / 用例计数（"46 条方法 / 60 执行用例"式）/ 与设计稿差异记录 / 数据源事实源位置。测试类加 `[Trait("Component", "SQLite.Retry")]` 等分类；用例加 `[Trait("Category", ...)]` 二级分类。xUnit 可 `--filter Component=SQLite.Retry` 跑子集。
- **代价 / 陷阱**：注释与实现可能漂移（用例计数需手工维护）—— 但对该团队是净收益（测试可读性极高）。
- **证据**：SQLiteRetryTests.cs:1-20；SQLiteSecurityTests.cs:1-51；MySqlBridgeTests.cs:1-40。
- **与我们的差异**：我们 bun 栈测试已自成体系；"文件头契约目录 + Trait 分类"是轻量可借鉴的测试组织惯例。

---

## 5. MySQL 特有的分叉（PG 没有的坑）

### 经验点 16：MySqlConnector "This MySqlConnection is already in use" — 同连接连发命令的驱动已知行为

- **解决什么问题**：MySqlConnector 2.6.x 在**同一个连接**上同步连发命令时偶发抛 "This MySqlConnection is already in use"（前一条命令的异步清理尚未完成，连接仍标记 in-use）。这是驱动已知行为（MySQL.cs:697-703 注释明写）。
- **方案**：pinned 连接上的 SQL 用 `lock (h)`（可重入锁）串行化，并对该瞬时错误做**短暂重试**（≤3 次，每次 sleep 30ms）：`ExecutePinnedWithRetry` / `ExecuteNonQueryPinnedWithRetry`（MySQL.cs:704-754）。仅 PG/SQLite pinned 路径没有此包装（SQLite 用 ExecuteWithRetry 处理 Busy/Locked — 两个驱动不同的重试动机）。
- **代价 / 陷阱**：重试条件是**消息字符串包含 "already in use"**（无专用错误码）—— 字符串匹配是脆的；且单连接上"连发命令"在桌面 JS 桥（CEF 串行）场景其实概率低，此防御针对的是迁移/批量密集调用。
- **证据**：MySQL.cs:697-754；提交 387f0761（消息全文含 "serialize + retry SQL on a pinned transaction connection to avoid MySqlConnector 2.6.1 'This MySqlConnection is already in use' when synchronous commands run back-to-back on the same connection"）。
- **与我们的差异**：bun:sqlite 同步 API 无此驱动层问题；但"同步连发命令在同一连接上的瞬时 in-use"若出现（如未来用异步驱动），此模式（锁 + 短暂重试）可直接对照。

### 经验点 17：MySQL 方言适配的细节坑 —— UseAffectedRows / 复合主键长度 / selectUnion 别名

- **解决什么问题**：MySQL 与 SQLite/PG 的方言差异在适配器/DDL 层逐项抹平，三处被 Gito 评审/实测抓出：
  - `UseAffectedRows=true`：否则 `ExecuteNonQuery` 返回 matched rows（0 影响行也返回 1）而非 affected rows，与 SQLite/PG 语义不一致（提交 daf28e39 Gito #7）。
  - 复合主键字节长度：`activity_bucket_cache_v2` 4 个 PK VARCHAR(255) → 字节 4080 > InnoDB 索引上限 3072 → 各列加 `CHARACTER SET ascii` 后 1020（提交 daf28e39 Gito #14）。
  - `selectUnion` 派生表无别名 → MySQL < 8.0.19 / MariaDB 报 error 1248（"Every derived table must have its own alias"）→ 加 `AS u` / `AS outer_union`（提交 daf28e39 Gito #15 与 MySQLAdapter.js 的 UNION 分支）。
  - `mysql migration interop`：post-copy 行数校验放宽为只对数据丢失（dstCount < totalCopied）失败 —— configs 表因引擎预写 schema_version checkpoint 比源多 1 行，INSERT IGNORE 保留（提交 387f0761）。
- **方案**：逐坑进适配器/连接串，并用 gradle 级验证（提交 daf28e39 的验证清单：dotnet build 0 error 0 warning + npm test 202 文件 2320 用例全 pass）。
- **代价 / 陷阱**：`UseAffectedRows` 改动后需核对全部 `ExecuteNonQuery` 调用点无 matched-rows 语义依赖（DoD 盲区核对，见 daf28e39 提交尾注）。
- **证据**：提交 daf28e39（完整消息含三修复 + 验证）、387f0761（完整消息）；MySQL.cs:256-284（UseAffectedRows=true 落点）。
- **与我们的差异**：这些是"把 SQLite 语义搬上 MySQL"时真实撞到的引擎差异样本（affected vs matched rows、索引字节上限、派生表别名、预写行数干扰校验）——未来若我们做任何跨引擎/跨方言校验，这四类都是现成的检查清单。

---

## 6. SQLite.cs 补充（t2 未覆盖、与 org 改动相关的部分）

t2 已覆盖：PRAGMA 三件套与取值、ExecuteWithRetry 数值、路径/PRAGMA 注入安全校验、事务 pin/InFlight/TimedOut、池化与统计近似。**不重复**。补充：

### 经验点 18：SQLite.cs 的 org 独有扩展 — observer 连接 + IAuthStore + ChangeEnabled 门控

- **解决什么问题**：SQLite.cs（47 commits，上游 Natsumi 7 + org XChen446 34 + RainyN0077 4 + 1zyao 1）里 org **加在 SQLite 后端之上**的部分（与三引擎对称改造同步）：
  1. `_observerConn` 惰性单例观察连接（永不用于写）读 `PRAGMA data_version`（SQLite.cs:886-915）—— t2 已述，此处确认是 org 行为（80f07292 写漏斗提交引入）。
  2. `IAuthStore` 实现（`EnsureCookiesTable`/`LoadCookie`/`SaveCookie`，SQLite.cs:979-1005）—— 与 MySQL/PG 同接口（9351b097 "cookies 持久化解耦至当前激活引擎"）。
  3. `SetChangeEnabled` 门控 + `SetChangeCallback`（Electron 反向通道，SQLite.cs 与 PG/MySQL 同构）。
- **代价 / 陷阱**：无新增（补充性质）。
- **证据**：SQLite.cs:886-915, 979-1005；提交 80f07292、9351b097。
- **与我们的差异**：`data_version` 观察连接的三引擎分叉（SQLite 需要专用观察连接、PG/MySQL 服务端计数无需）是我们若做变更观测的直接参考。

---

## 本 org 在 Dotnet/ 的原创贡献清单（血统判断输入）

作者统计口径：`git log origin/old/main --format="%an" -- <file>`（按提交数）。**上游 VRCX 官方没有 MySQL/PG 后端**——这两个文件 + 测试工程 + IAuthStore 全 org 原创（提交 hash + 消息原文见 §7 附录；头尾引用 `d10b0cc0` 为仓库迁移一次性提交，也含品牌/文档改动）。

### MySQL.cs（38 commits；XChen446 33 / RainyN0077 3 / 1zyao 2）— 从零新建
- 无上游版本；首提交 `d1bb45f7 feat(C#MySQL): 添加 MySQL 数据库初版前置集`（2026-07-18）。
- org 全周期内容：Init 5 字段配置读取 → 连接串构建 → MySqlDataSource 池化（含 20cb5c4c 引入 DataSource 重构）→ 事务 pin 五件套 → Timer/InFlight 防御 → GetPoolStats（含反射拿驱动内部字段）→ IAuthStore → 写漏斗 → DataSourceCache → connId object? 归一化 → UseAffectedRows/复合主键/派生表别名修复 → 连接池上限 16 → 失败借出释放（#30）。

### PostgreSQL.cs（28 commits；XChen446 25 / RainyN0077 2 / 1zyao 1）— 从零新建
- 无上游版本；首提交 `2904d1c4 feat(C#PgSQL): 添加 PostgreSQL 数据库初版前置集`（2026-07-18）。
- org 全周期内容：Init 字段验证（白名单正则）→ NpgsqlDataSource 池化（显式 MinPoolSize=1/IdleLifetime/Timeout/CommandTimeout）→ 事务 pin（74fda9b1 持连接事务 API + sliding 超时）→ 写漏斗 + **LISTEN/NOTIFY 原生推送**（80f07292，PG 专属部分）→ GetPoolStats 反射真值 → DataSourceCache → connId/args 归一化 → 池上限 16 → #30。

### VRCX.Tests/（13 个 .cs，各 1-2 commits，全 org）
- XChen446：BridgeTestHelper / SQLiteBridgeTests / MySqlBridgeTests / PostgreSqlBridgeTests（桥签名契约，PR #17 回归）；
- RainyN0077：SQLiteRetryTests / SQLiteSecurityTests / SQLiteTestCollection / Stubs/ProgramStub / Usings；
- 1zyao + RainyN0077：Stubs/VRCXStorageStub（2 commits）；
- 1zyao：SQLitePoolStatsTests / MySqlPoolStatsTests / PostgreSqlPoolStatsTests（#30 池计数回归）。
- 测试工程从零建（VRCX.Tests.csproj 首个 C# 测试工程，Link+stub 方案 org 原创）。

### IAuthStore.cs（1 commit，XChen446）— 从零新建
- 唯一 org 全权作者文件之一；`internal interface` 3 方法；动机 = cookies 持久化解耦至当前激活引擎（9351b097 配套）。

### SQLite.cs（47 commits；上游 Natsumi 7 / Ethan Cordray 1 + org XChen446 34 / RainyN0077 4 / 1zyao 1）— 上游文件，org 大幅扩展
- 上游（VRCX 官方血统）部分：单连接 + ReaderWriterLockSlim 时代主体、基础 CRUD、VRCXStorage 集成（Natsumi/Ethan）；
- org 加的部分：池化改造（9b03dbb6 "SQLite/MySQL 真正池化"）、事务 pin 五件套 + Timer 防御、GetPoolStats、写漏斗 + data_version 观察连接、IAuthStore 实现、PRAGMA 注入/路径穿越安全加固（SQLiteSecurityTests 对应）、connId object? 归一化、重试（#30 计数释放参与）。

### 其余 Dotnet/ 文件（第二优先核查，未发现 org 深度参与）
- `VRCXStorage.cs`（13 commits：Natsumi 6 + XChen446 7）— org 有参与（7 commits），但以既有 VRCXStorage 之上扩展为主（本次未深挖其 diff，无法确定具体 org 新增内容）；
- `DBMerger/*`（Natsumi 3-4 + XChen446 1）— org 仅 XChen446 1 commit（`Merger.cs`），内容未深挖；
- `AppApiCommon.cs` 等 AppApi/* — org 少量参与（XChen446 3 / RainyN0077 1）；
- 其余（Cef/、Overlay/ 等）— 上游为主，未发现 org 显著提交。

---

## 附录：关键提交消息原文（节选）

- `2904d1c4` feat(C#PgSQL): 添加 PostgreSQL 数据库初版前置集
- `d1bb45f7` feat(C#MySQL): 添加 MySQL 数据库初版前置集
- `89c98f13` feat(C#PostgreSQL): Init 5 字段配置 + 池化 + 健康检查 + 4 处桥注册 (task 9.2 + 9.14)
- `1c645955` feat(Adapter): SQLite/MySQL C# 层 + JS 适配器统一池化事务 API
- `9b03dbb6` feat(C#SQL): SQLite/MySQL 真正池化,与 PG 对称
- `74fda9b1` feat(C#PgSQL): 持连接事务 API + sliding 超时
- `45f2979a` chore(C#SQL): TX_IDLE_MS 30s → 60s,给异地高延迟更多余量
- `7a01f818` fix(C#SQL): 修复慢查询竞态 — SQL 执行期间暂停 sliding Timer
- `5ba6ebb6` fix(C#SQL): Timer 排队竞态防御 — InFlight 引用计数 + TimedOut 延迟清理
- `57d366d2` fix(C#SQL): Timer 竞态完全闭环 — InFlight 读写全部纳入 _txLock
- `3a4fd2b8` perf(C#SQL): 三引擎对称 MinimumPoolSize=1 保活,消除挂机后重建连延迟
- `6bf9a0f1` feat(db): 三引擎连接池三态计数器 + GetPoolStats (Issue #14)
- `8aa06768` feat: 点击清空空闲连接池 + 确认框 (Issue #15)
- `2f8ff620` feat(GetPoolStats): 三引擎新增 idleInPool/totalOpen 扩展字段 (PG 反射真值)
- `9429cca8` fix: GetPoolStats poolIdle → availableCapacity (语义修正 + 公式修正)
- `7272699a` fix(MySQL): GetPoolStats 反射驱动真值替代配额估算,修复"池中空闲"恒显满值
- `28ceda93` fix(concurrency): 修复 ExecutePinned TOCTOU 致计数器永久泄漏(qa-review M3)
- `9351b097` fix: cookies 持久化解耦至当前激活引擎 + 纳 GLOBAL_TABLES 统一迁移
- `1f8324e7` feat(Dotnet): DataSource cache for ExecuteJsonOnConnection/ExecuteNonQueryOnConnection
- `2f49474c` fix(SQL*): Execute*OnConnection connId 类型 long? → object? 修复 CefSharp Int32 → Nullable&lt;Int64&gt; 转换
- `9669198b` fix(C#PgSQL): Execute*OnConnection args 类型 object[]? -> object? 修复 CefSharp List<object> -> object[]
- `5c30bc63` fix: 重命名 ExecuteJson/ExecuteNonQuery connectionString 重载避开 CefSharp 3 参重载歧义
- `9b4228ee` fix(SQLite): BeginTransaction 重载改名 BeginTransactionOnConnection 规避 CefSharp 同名重载解析
- `0c3cb1f5` feat(C#PgSQL): PostgreSQL BeginTransactionOnConnection + Execute*OnConnection connId
- `e9b9101c` feat(C#MySQL): MySQL BeginTransactionOnConnection + Execute*OnConnection connId
- `80f07292` feat: 数据库变更订阅 — 三端写漏斗实时层 + 计数器完备层 + PG 原生推送
- `387f0761` fix: MySQL migration interop & row-count verification（含 "MySqlConnector 2.6.1 'This MySqlConnection is already in use'" 串行化 + 行数校验放宽全文）
- `daf28e39` fix(MySQL): Gito #7 UseAffectedRows + #14 复合主键 + #15 selectUnion 别名（含验证清单与 DoD 盲区核对全文）
- `fbd5c7bb` chore(C#SQL): MySQL/PG 连接池上限 100 降至 16,与 SQLite 对称
- `6f12a1d6` fix(database): release failed pool borrows (#30)
- `20cb5c4c` refactor(MySQL): 引入 MySqlDataSource 对齐 PG 连接管理模式
- `631afe0b` feat(database): MySQL 对齐 PgSQL 跨引擎迁移链路 + 全栈偏心点修正
- `9fcd8252` fix(mysql): Gito 评论 6 剩余缺陷修复 + Program.cs AppApiInstance 空守卫
- `7842abe8` fix(review): 采纳 PR#6 Gito 评审 3 项合理缺陷(#1 部分/#5/#6),驳回 #2/#3/#4
- `b230041d` feat(MySQLAdapter/8.9): MariaDB 兼容适配
- `905bead5` feat(MySQLAdapter/8.4): DDL 类型映射 + createIndex 幂等 + maintenance
- `0d839997` feat(C#MySQL/8.3): 添加连接字符串重载，支持外部数据库操作

---

## 无法确定的事项

1. **VRCXStorage.cs 中 org 的 7 commits 具体加了什么**：作者分布（Natsumi 6 + XChen446 7）显示 org 参与度不低，但本次未做 diff 级核查；该文件不在本任务第一/二优先级文件清单内，若血统台账需要可按同样方法补查。
2. **DBMerger/ 的 org 参与**：`Merger.cs` 有 XChen446 1 commit、其余 Natsumi — 未核查该 commit 内容；与数据库层相关（merger 工具），但非本次 MySQL/PG 主线。
3. **PG `ChangeListenerLoop` 的 30s 重连与 `Notification + WaitAsync` 在 CefSharp 线程模型下的实际行为**：代码路径完整但无集成测试（VRCX.Tests 只测纯函数与早抛点；文件头注释自承 PG/MySQL 引擎级行为需真实后端 + 桥，见 t2 引用）。
4. **`MariaDB 兼容适配`（b230041d）的具体内容**：提交消息只有标题；MySQL.cs 头部注释声明"MySqlConnector 原生支持 MySQL 与 MariaDB（协议兼容），无引擎分支"，适配细节推测主要在 JS 适配器层（MySQLAdapter.js），本次未展开。
5. **`sqlite://` URI 手动解析与 `new URL()` 的分歧**：t2 已述 SQLiteAdapter.js 弃用 URL 解析的原因；但 PG/MySQL 的 `postgresql://`/`mysql://` URI 在 index.js `createAdapter` 只做 scheme 切片（`:3306` 等端口如何进入连接串）未核查。
6. **测试工程是否跑在 CI**：VRCX.Tests.csproj 注释称"可在 Linux CI 跑"（TFM 无 -windows 后缀），但 old/main 无 CI 文件证据（未查 .github/workflows）；"测试存在"不等于"测试常跑"。
7. **`GetPoolStats` 反射数值的三引擎口径**：PG 反射 `Statistics` 返回 (Total/Idle/Busy)，MySQL 反射 `m_sessions`/`m_sessionSemaphore`，SQLite 用 peak-borrowed 近似 —— 三者语义不完全同构（PG 精准、SQLite 近似），JS 侧自算 `idleInPool = totalOpen - active - pinnedIdle` 与各真值字段的关系未逐字段验证。
