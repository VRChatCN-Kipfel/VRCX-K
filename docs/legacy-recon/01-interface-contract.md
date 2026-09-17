# 经验勘察 01：EngineAdapter 接口契约（抽象方法集与适配器 API 文档）

> 勘察对象：`origin/old/main`（HEAD `e4ec5611`，2026-08-24）上的
> `src/services/database/adapter/EngineAdapter.js`（52 KB / 1307 行）、
> `docs/architecture/ADAPTER_API.md`（253 行）、`ADAPTER_GUIDE.md`（293 行）、
> `ENGINE_CONTRIBUTOR_GUIDE.md`（130 行）。
> 勘察方式：只读（`git show origin/old/main:<path>`），未改动任何 tracked 文件。
> 血统：这些代码是 VRCX(MIT) fork 链上的改版工作（XChen446 等），大部分内容非本 org 原创，仅作经验参考。

---

## 0. 数字核对结论（先放答案）

| 声称 | 出处 | 核验结果 |
|---|---|---|
| 「Interface frozen at 42 abstract + 3 optional (2026-07-16)」 | EngineAdapter.js:13；ADAPTER_API.md:5；ADAPTER_GUIDE.md:5 | ✅ **冻结时刻成立**：`3afecfb7`（2026-07-16，JSDoc 完善 + 接口冻结）版本实有 **42 个方法级 `@abstract` + 3 个方法级 `@optional`**（`_normalizeArgs`/`withPrefix`/`daysAgoISO`），逐一数过 |
| 冻结后「只增不改签名」+ 两次破例 | ADAPTER_API.md:5、ADAPTER_GUIDE.md:36-37 | ✅ 破例记录与提交历史吻合：① 2026-07-25 `26ee17fa` 事务重构（begin/commit/rollback → beginTransaction/commit/rollback + withTransaction + _txStack）；② 2026-07-26 `c08c62e1`/`9429cca8` 健康检查三方法提升为基类抽象 |
| 「47 个 @abstract」 | ADAPTER_GUIDE.md:47、92 | ✅ 与当前 HEAD 代码一致：**当前实际 47 抽象 + 5 可选**（见 §1 清单） |

**数字差异解剖**：42 → 47 精确对应两次破例（`begin/commit/rollback` 改名仍是 3 个，但新增 `_doBegin/_doCommit/_doRollback/_doKeepAlive` 4 个抽象钩子 + `withTransaction` 可选 = 42+4 抽象 +1 可选；随后 `isConnected/getHealth/getPoolStats` 3 个入抽象 = 47 抽象）。5 个可选 = 冻结时的 3 + `withTransaction` + 后续新增的 `onTableChange`。**文档说 42+3，指的是冻结快照；代码现为 47+5，两者都被文档自己的「破例流程」叙事自洽衔接——不是文档失真，是「冻结计数」与「现行计数」两个时点概念。** 接入方若想复用这套契约数字，需区分「冻结基线」与「现行面」。

---

## 1. 接口本体逐条清单（现行 HEAD，EngineAdapter.js，1307 行）

### 1.1 抽象方法（47 个，全部 `throw new Error('abstract')`）

| # | 方法 | 语义（JSDoc 原话精炼） | 引擎特有（`@engine-specific`） |
|---|---|---|---|
| 1 | `execute(cb, sql, args?)` | 原始 SELECT/PRAGMA，逐行回调（positional array） | — |
| 2 | `executeNonQuery(sql, args?)` | 原始写/DDL，返回影响行数 | — |
| 3 | `insert(table, data, conflict?)` | 单行 INSERT + 冲突处理 | ✅ SQLite `INSERT OR IGNORE/REPLACE` / PG `ON CONFLICT` / MySQL `INSERT IGNORE/REPLACE` |
| 4 | `bulkInsert(table, rows, conflict?)` | 批量 INSERT（rows 同键） | ✅ 同上 |
| 5 | `update(table, data, where)` | 等值条件 UPDATE | — |
| 6 | `updateWhere(table, data, whereClause, params?)` | 原始 WHERE 的 UPDATE | — |
| 7 | `delete(table, where)` | 等值条件 DELETE | — |
| 8 | `deleteAll(table)` | 清空全表 | — |
| 9 | `deleteWhere(table, whereClause, params?)` | 原始 WHERE 的 DELETE | — |
| 10 | `increment(table, column, amount, where)` | 数值列自增 | — |
| 11 | `upsertPartial(table, insertData, updateData, conflictColumn)` | 局部 UPSERT | ✅ SQLite/PG `ON CONFLICT(col)` / MySQL `ON DUPLICATE KEY` |
| 12 | `selectOne(table, columns, where)` | 单行（positional array 或 null） | — |
| 13 | `select(table, columns, where?, options?)` | 等值 SELECT，省略 where=全表，options `{order,limit,distinct}` | — |
| 14 | `selectWhere(table, columns, whereClause?, params?, options?)` | 原始 WHERE 的 SELECT | — |
| 15 | `selectJoin(spec)` | JOIN spec `{from,alias?,joins?,columns,where?,params?,order?,limit?}` | — |
| 16 | `selectWhereIn(table, columns, inColumn, inValues, extraWhere?, extraParams?, options?)` | `WHERE col IN (...)` | — |
| 17 | `selectUnion(sources, options?)` | UNION ALL 多源 | — |
| 18 | `selectGroupBy(table, spec)` | GROUP BY + 聚合 `{columns?,aggregates?,groupBy?,where?,params?,order?,limit?,having?}` | — |
| 19 | `count(table, where)` | 等值计数 | — |
| 20 | `countWhere(table, whereClause?, params?)` | 原始 WHERE 计数 | — |
| 21 | `createTable(tableName, columns)` | `CREATE TABLE IF NOT EXISTS`；columns `[{name,type,constraints?}]` 或裸字符串 | — |
| 22 | `createIndex(indexName, table, columns, unique?)` | `CREATE INDEX IF NOT EXISTS` | — |
| 23 | `alterTableAddColumn(table, columnDef)` | 完整列定义（如 `'name TEXT NOT NULL DEFAULT ""'`） | — |
| 24 | `alterTableDropColumn(table, column)` | — | — |
| 25 | `alterTableRename(table, newName)` | — | — |
| 26 | `dropTable(table)` | `DROP TABLE IF EXISTS` | — |
| 27 | `_doBegin()` | 事务 begin 钩子：PG 返回真实 connId；SQLite/MySQL 发 `BEGIN` 返回 0 | ✅ 语义随池化与否分裂 |
| 28 | `_doCommit(connId)` | 事务提交钩子 | ✅ 同上 |
| 29 | `_doRollback(connId)` | 事务回滚钩子 | ✅ 同上 |
| 30 | `_doKeepAlive(connId)` | 事务心跳重置，返回存活布尔 | ✅ MemorySQLiteAdapter 恒 true |
| 31 | `vacuum()` | 回收存储 | ✅ SQLite `VACUUM` / PG `VACUUM ANALYZE` / MySQL `OPTIMIZE TABLE` |
| 32 | `optimize()` | 维护提示 | ✅ SQLite `PRAGMA optimize` / PG `ANALYZE` / MySQL `ANALYZE TABLE` |
| 33 | `initUserSchema(prefix)` | 建某账号前缀的用户表（22 表 + 4 索引） | —（每个子类自带完整 DDL） |
| 34 | `initGlobalSchema()` | 建全局共享表（18 表） | —（同上） |
| 35 | `listTables(likePattern)` | 表枚举（LIKE 过滤，返回可直用的完整限定名） | ✅ `sqlite_schema` / `SHOW TABLES LIKE` / `pg_catalog.pg_tables` |
| 36 | `getTableColumns(table)` | 列元数据（方言特定 positional rows） | ✅ `PRAGMA table_xinfo` / `SHOW COLUMNS FROM` / `information_schema.columns` |
| 37 | `listTablesTypes()` | 表枚举 + 列元数据组合，结构化对象 `{tableName, columns:[{name,type,notNull,defaultValue,isPK,isHidden}]}` | — |
| 38 | `userTable(prefix, name)` | 用户表名解析 | ✅ SQLite/MySQL `{prefix}_{name}`；**PG `account_{prefix}.{name}`（schema 隔离）** |
| 39 | `sqlToUnixMs(column)` | SQL 表达式：ISO 时间 → Unix 毫秒 | ✅ 三端不同 |
| 40 | `sqlExtractWorldId(column)` | SQL 表达式：`"wrld_x:12345"` → `"wrld_x"` | ✅ 三端不同 |
| 41 | `sqlHasInstanceId(column)` | SQL 表达式：含 `:` | ✅ 三端不同 |
| 42 | `sqlDate(column)` | SQL 表达式：取日期部分 | ✅ 三端不同 |
| 43 | `sqlEnterTime(tsCol, msCol)` | SQL 表达式：离开事件 → 进入时间（BETWEEN 字面比较） | ✅ 三端不同（格式一致性是硬要求） |
| 44 | `getPoolStats()` | 连接池三态指标 `{active,pinnedIdle,availableCapacity,max,totalOpen,idleInPool}` | ✅ 内部实现各异（PG/MySQL 反射驱动真值，SQLite peak-borrowed 近似） |
| 45 | `clearIdleConnections()` | 清池中空闲连接 | — |
| 46 | `isConnected()` | 存活探针 | — |
| 47 | `getHealth()` | 健康快照 `{connected,latencyMs?,lastHealthCheck?}` | — |

### 1.2 可选方法（5 个，基类有默认实现，可覆写）

| # | 方法 | 默认实现 |
|---|---|---|
| O1 | `_normalizeArgs(_args)` | 恒等直通（方言绑定入口：SQLite 加 `@` 前缀 / PG `_bind` 转 `$N` / MySQL 转 `?`） |
| O2 | `withPrefix(prefix, fn)` | 临时覆盖 `_prefixOverride`，嵌套安全（try/finally 恢复） |
| O3 | `daysAgoISO(days)` | `new Date(Date.now() - days*864e5).toISOString()` |
| O4 | `withTransaction(fn)` | 完整事务编排（begin→fn→commit/rollback + `_txStack` + `_txTail` 串行队列 + 60s 超时防死锁） |
| O5 | `onTableChange(table, cb)` | **完整变更订阅默认实现**（详见 §4） |

### 1.3 非接口成员

- `engineType` getter（EngineAdapter.js:137-139）：**元数据，不在 42+3 计数内**（代码注释明说）。默认 `'unknown'`，三子类各自覆写（`SQLiteAdapter.js:28` / `PgSQLAdapter.js:59` / `MySQLAdapter.js:38`）。冻结时（3afecfb7）尚无此 getter——是 2026-07-19 与 MySQL 分支对齐时加的（`4ff8aaa8`）。
- 实例字段：`_prefixOverride` / `connectionString`（默认 null=主库 conn `"default"`）/ `_txStack` / `_txTail` / `_txInFn` / `_txWaitTimeoutMs=60000`。
- 模块级变更通知门控：`_changeSubscriberCount` / `_changeGateHook` + 导出 `setChangeGateHook(hook)`（EngineAdapter.js:1288-1305）。

---

## 2. 接口为什么这么大：必要抽象 vs 历史累积

**判断：混合，但「方法论上必要」的成分大于「纯历史包袱」。** 逐类拆解：

- **业务面全量结构化 = 故意的分层策略，不是膨胀**。18 个 `database/*` 业务模块共 **338 处 adapter 调用零改动**（ADAPTER_GUIDE.md:14, 26 的 D1 不变量；验收门槛第 1 条就是 git diff 确认零改动）。42+3 之所以这么大，是因为要覆盖 feed/gameLog/用户表等业务**在 SQL 层想要的每一种形状**（JOIN、UNION ALL、GROUP BY、IN、局部 UPSERT、原始 WHERE 逃生口……），让方言差异全部收敛在适配器一层，业务模块只写 `@key` 命名参数。这是**「一次付清的抽象税」**：新引擎代价高，但业务永不再碰方言。
  - 佐证：git 历史里 `0a3f0200`、`68f02064`、`fbd43ff4` 一连串「消灭 adapter.execute 回调模式 / 消灭 ~65 处 execute / 提取列常量迁至结构化查询」——接口是**被业务逐渐「吸」大的**，每个结构化方法都对应真实调用点（selectUnion 对应三个 UNION ALL，selectGroupBy 对应聚合，selectJoin 对应 CTE JOIN）。
- **真正的「只服务单一引擎」成员**：
  - **PG 专用撑胖**：`_doBegin/_doCommit/_doRollback/_doKeepAlive` 4 个事务钩子 + `withTransaction` 的 `_txStack`/`_txTail` 全套，**起因是 PostgreSQL.cs 的池化设计导致跨调用事务断裂**（EngineAdapter.js:15-21、26ee17fa）。SQLite/MySQL 单连接根本不需要 pin——`_doBegin` 直接发 `BEGIN` 返回 0。**没有 PG，事务面会小一半**。
  - SQL 片段 5 个（39-43）本质是业务查询（世界 ID 提取、进入时间推算）的方言归一，**每个都只有一个真实调用点**（sqlEnterTime 仅 gameLog.js 一处，还带 BETWEEN 字典序格式硬约束）。
  - 健康检查 4 个（44-47）是 2026-07-26 的破例追加（三引擎对称，StatusBar 池监控消费，Issue #14/#15），服务「桌面应用显示 DB 健康」这一横切需求。
- **结论**：这 47 个的**绝大部分是「必要抽象」**（为 D1「业务零改动」服务），小部分是 PG 单引擎驱动（4 个事务钩子）与历史沉淀（SQL 片段是查询上移的产物）。但注意反例：**引擎特有扩展不进基类**——PG 的 `dropUserSchema` 等留在子类，调用方用 `typeof adapter.x === 'function'` 能力检测（ADAPTER_GUIDE.md:38、ENGINE_CONTRIBUTOR_GUIDE.md:53）。所以基类只收纳「三引擎都表态过的面」，不是「所有引擎的面」。

---

## 3. 经验点 1：接口冻结政策与破例流程（演进纪律）

- **解决什么问题**：三引擎并行开发时，防止基类被某一引擎的局部需求随意改大（PG 要求 pin → 若直接改事务签名会波及另两引擎与 338 处调用点）。
- **方案**：
  1. 冻结基线：`3afecfb7`（2026-07-16）把当时 42 abstract + 3 optional 固化为文档中的「冻结计数」，头注释（EngineAdapter.js:13）与 ADAPTER_API.md:5、ADAPTER_GUIDE.md:5 三处一致引用。
  2. 破例流程（ADAPTER_GUIDE.md:34-35）：设计文档说明理由 → review 通过 → **基类 + 全部现有子类同步实现**。
  3. 引擎特有扩展**不入基类**，留在子类 + `typeof x === 'function'` 能力检测（ADAPTER_GUIDE.md:38）。
  4. JSDoc 标记约定 `@abstract`/`@optional`/`@engine-specific`/`@private`，新方法必须带标并**同步更新基类冻结计数**（ENGINE_CONTRIBUTOR_GUIDE.md:112）。
- **代价 / 陷阱**：
  - 两次破例后文档与代码的「冻结数字」出现分叉（文档仍写 42+3，代码 47+5）——虽然文档用「破例记录」自洽，但**靠人肉同步的数字必然滞后**。接我们这种以文档为承诺的工程，数字应由脚本/契约测试断言而不是手写。
  - `@private` 只是 IDE 高亮引导（eslint-plugin-jsdoc 没开，不触发 lint 失败）——纯约定，无强制执行（EngineAdapter.js:23-27）。
  - 破例本身是「改名 + 新增」，依赖 commit message 记录因果（`26ee17fa`/`c08c62e1`/`9429cca8`），无专门 changelog 文件。
- **证据**：EngineAdapter.js:13-39（头注释含两次破例 + engineType 说明）；ADAPTER_GUIDE.md:32-39；提交 `3afecfb7`（冻结）、`26ee17fa`（事务破例）、`c08c62e1`（健康检查破例）、`9429cca8`（字段改名）。
- **与我们的差异**：旧实现靠 JSDoc 注释 + 人肉纪律表达「抽象/可选/引擎特有/私有」四类标记，无运行时强制（`throw new Error('abstract')` 是唯一兜底，漏实现到调用时才炸）；我们是 TS 严格模式，`abstract class` + `interface` 是编译期强制，可选方法天然是 `abstract` 之外的具象方法，`typeof x === 'function'` 能力检测可换成可选链/类型收窄。

---

## 4. 经验点 2：onTableChange —— 表级变更订阅（两层检测：实时漏斗 + 完备层轮询）

这是旧实现里**最可能超出我们当前能力面的机制**，单独详述。

### 4.1 解决什么问题

前端 Store（feed 缓存、多账号热替换等）需要**在表被写入时收到「失效提示」**，而不是自己定时轮询 refetch。VRCX 数据由多个路径写入（WS feed、用户操作、迁移、push/pull、甚至外部进程），Store 无法在所有写点埋通知，需要一个挂在 DB 层、对所有写者透明的变更信号。

### 4.2 核心语义（ADAPTER_API.md §9.1-9.6，与代码一致）

- **事件是失效提示（invalidate hint），不是数据管道**——负载不带行数据，只有 `{table, count, ts}`；收到事件后应重新查询（`count=-1` 表示「全量失效」，应重查整表；≥0 是本次批量行数）。**漏事件最多延迟一次 UI 刷新，永不导致数据不一致**——这个设计决策（§9.8：「行级被设计明确否定，负载一旦带行数据就变成数据管道，漏一行即数据不一致」）是关键取舍。
- **接口**：`onTableChange(table, cb) => unsubscribe`（EngineAdapter.js:1126-1166）。`table` 是**物理表名**（订阅方用 `userTable(prefix, name)` 计算，如 `abc_feed_gps`；PG 是 `account_abc.feed_gps`）。
- **@optional 默认实现**（基类完整实现，不覆写即退化为带实时层的可用功能）：
  - 订阅注册表：`_changeSubs = Map<物理表名, Set<回调>>`（EngineAdapter.js:1105）。
  - **实时层**：C# 侧写漏斗事件（每个写操作发射 `DatabaseChanged`，负载含表名 + 行数 + 发射时计数器快照 dv），经 `adapter/index.js` 的 `wireFunnelEvents` 按 `conn` 路由到对应实例的 `_onFunnelEvent(evt)`（EngineAdapter.js:1233-1256）。命中订阅 → 毫秒级触发表级回调；未知表 → 只推进基线。
  - **完备层**：引擎原生计数器轮询兜底（EngineAdapter.js:1193-1204 `_pollChangeCounter`，间隔 `CHANGE_POLL_MS = 5000`）。读 `_readChangeCounter()`（默认返回 null = 引擎不启用兜底；SQLite `PRAGMA data_version` / PG `xact_commit` / MySQL `performance_schema`）；**版本前进且无对应漏斗事件时** `_fireAllTables()` 触发全部订阅表 `count=-1` 失效——这就是「外部写者检测器」。**首轮只建基线不触发**（订阅方通常自会做初始拉取）。
  - **基线去重**：自写已被实时漏斗事件覆盖（dv 推进 `_changeBaseline`），完备层不再因自写触发 `count=-1`（EngineAdapter.js:1212-1216、1209-1211）。
  - **门控**：跨实例订阅计数 0→1 时通过 `setChangeGateHook` 打开 C# 写漏斗（`SetChangeEnabled(true)`），归零关闭；**无消费者时写路径仅剩表名提取正则 + 门控布尔读，近零开销**（EngineAdapter.js:1139-1163、1288-1305；ADAPTER_API.md §9.6）。
  - **订阅即启停**：首个订阅启动轮询定时器，全部退订即停——**无订阅者 → 零轮询**；对外也无需手动管理。
- **引擎支持矩阵（检测机制异构，上层接口统一）**：
  - SQLite：实时 = C# 漏斗；完备 = `PRAGMA data_version` 轮询（DB 级粒度）。
  - MySQL：实时 = C# 漏斗；完备 = `performance_schema` 轮询（表级源 → DB 级信号）。
  - **PostgreSQL：完备层是「trigger + NOTIFY 原生推送（表级，含外部写者）」**——消费方装 `FOR EACH STATEMENT` 触发器（`CreateChangeTrigger(table)`，先 `EnsureChangeFunction()` 一次），NOTIFY 经专用 `LISTEN vrcx_change` 连接接收；自写去重靠「漏斗发射时间戳在 dv 读/COMMIT 之前记录，监听侧 500ms 窗口内 NOTIFY 视为自写镜像丢弃」，误杀由计数器轮询 ≤5s 补上；计数器轮询仅作监听通道故障/未装触发器时的安全网（ADAPTER_API.md §9.7）。**这是三端里唯一真正做到表级 + 外部写者全覆盖的形态**。
- **事务语义**：回滚不通知（仅 COMMIT 成功后发射）；事务内同表批量写合并为该表 COMMIT 后一条事件（多表事务每表各一条）（§9.6）。
- **降级链**：桥绑定失败/编组失败静默 → 完备层兜底不漏，仅响应性降级；引擎未实现计数器 → 退化为纯实时层。
- **实例边界 = 连接边界**：订阅挂在 adapter 实例上，事件按 `conn` 路由（`connectionString` 字段）；主库单例收 `conn='default'`，外部实例（`createAdapter({connection})`）只收自己连接的事件——**多账号前缀不同 = 物理表不同 = 天然隔离**（§9.3-9.4）。
- 与 TanStack Query 的衔接被显式提及：收到事件后 `invalidateQueries` 对应 query key——**「下移到 DB 层的 refetchInterval」**（§9.5）。
- 已知边界/未实现：行级订阅明确否定；外部进程写库非支持场景（PG 由 trigger+NOTIFY 原生覆盖）；`getPendingChanges(sinceId)` 拉式接口是设计备选**未实现**；PG/MySQL 的 trigger outbox 轮询形态未实施；`createTrigger/dropTrigger/listTriggers` 三端统一形态当前仅 PG 有对应方法。

### 4.3 代价 / 陷阱

- **完备层粒度缺陷**：计数器是 DB 级/全局不分表，版本前进只能触发**全部订阅表** `count=-1` 全量失效（EngineAdapter.js:1189 注释明说）——精度要靠实时层补，实时层不可靠时全量重查是最坏解。
- **PG 原生去重的 500ms 窗口**是经验值，靠「漏斗时间戳先于 dv 读/COMMIT」排序保证，窗口误杀交给轮询兜底——去重不会造成漏报，但**不提响应性**。
- **polling + 门控的复杂度**：跨实例订阅计数、定时器、桥名列表（`CHANGE_BRIDGES = ['SQLite','PostgreSQL','MySQL']`）三处必须同步，`setChangeGateHook` 注入即重置计数（测试可重复安装）。退订闭包要幂等（`c4f6b581` 修过门控计数失衡）。
- 写路径的「零成本」依赖 C# `EmitChange` 首行早退（无订阅 → 不知道发射给谁）——这是 C# 侧配合做的门控，不是纯 JS 能省的。
- 状态在 JS 侧维护（基线、订阅、定时器），**进程重启后基线丢失**，重启后首轮轮询只重新建基线（不误触发），代价是「进程存活期内的外部写才能被完备层发现」。

### 4.4 证据

EngineAdapter.js:30-33（头注释）、1090-1285（实现区）、1288-1305（门控）；ADAPTER_API.md §9 全节；提交 `80f07292`（三端写漏斗实时层 + 计数器完备层 + PG 原生推送）、`9b6442af`（完备层轮询）、`94590689`（漏斗事件路由与基线去重）、`53dfd951`（门控）、`c4f6b581`（退订幂等修复）。原始设计文档：`git show 07ebdba2:docs/CHANGE_NOTIFICATION_DESIGN.md`（ADAPTER_API.md:131 指引）。

### 4.5 与我们的差异

- 旧实现依赖 **C# 侧写漏斗**（业务层无法直接移植）：所有写操作由 C# 桥发射事件 + `conn` 路由。我们是 bun:sqlite 单进程直写，若做同样机制，实时层只能在自己的写封装里内建（无外部 C# 桥），完备层（`PRAGMA data_version` 轮询）反而可以直接平移——bun:sqlite 支持读 data_version。
- 旧实现订阅挂在「adapter 实例 = 连接」上；我们若做成可替换 storage 服务契约，订阅键的归属（服务实例？表命名空间？）需要重新设计，但「物理表名 + 失效提示 + 基线去重 + 订阅即启停」这套语义可以直接复用。
- 我们有事件总线（kkrpc 事件推送）和响应式 Store（Vue）基础设施，表级失效提示可以直接映射为事件/query 失效，不需要「下移成 DB 层 refetchInterval」这种变通理由——但「把变更信号放 DB 层而非 UI 层」的分层思想正是旧实现最有价值的点。

---

## 5. 经验点 3：engineType getter —— 把「引擎身份」做成元数据而非接口

- **解决什么问题**：迁移运行器要检测当前引擎来决定是否跳过 sqlite 锁定的 `.map`，但**不应该 import 适配器类**（避免循环依赖与耦合并行开发）；且引擎检测必须与 `initAdapter(mode)` 实际构造的实例**保持同步**。
- **方案**：`get engineType()` 默认返回 `'unknown'`（EngineAdapter.js:137-139），三个子类覆写返回 `'sqlite'/'postgresql'/'mysql'`。`getDatabaseEngine()`（migrations/index.js:233-244）读 `adapter?.engineType`；`'unknown'` 被显式当「忘记覆写」处理——**fallback 到 `'sqlite'` 保证默认引擎安全，而非报错**；与此相对，`'unknown'` 不会静默冒充 sqlite（迁移兼容性检查用结构化 `{compatible, skip}` 返回：`after:"sqlite"` 的 .map 在非 sqlite 引擎上 `{compatible:false, skip:true}` → 调度入口 continue+warn，不抛错）。
- **为什么是「元数据不是接口」**：不携带任何 SQL 语义，不参与 42+3 计数（EngineAdapter.js:35-39 明说）。
- **代价 / 陷阱**：`'unknown'` 的 fallback 用了**不等判断**（`engine !== 'unknown'`）而非 `||`——注释明说 `'unknown'` 是 truthy，`||` 不会触发 fallback（migrations/index.js:236-244）。这种「默认值兼作错误信号」的约定容易被人忽略；文档要求子类必须覆写，否则会暴露在迁移兼容性检查里。
- **证据**：EngineAdapter.js:35-39、119-139；migrations/index.js:78-85、210-244；提交 `4ff8aaa8`（同步 MySQL 分支 engineType getter）、`3a457262`。加入时间 2026-07-19，晚于冻结日——再次说明「冻结计数」只约束方法面，元数据/字段可后加。
- **与我们的差异**：我们 TS 里引擎身份可直接由 `service identifier`/DI 环境或接口常量表达，未必需要 getter；但它「身份检测与实例构造单一来源对齐」的理由（配置可能被别处改、单测可能未走 init 路径）对我们做「可替换 storage 服务」仍然适用：**服务身份应来自服务实例本身，而不是全局配置快照**。

---

## 6. 经验点 4：业务零改动（D1）作为接口设计的最高不变量

- **解决什么问题**：加第三个引擎（MySQL）时，18 个业务模块 338 处调用若都要改，等于没有接口。
- **方案**：D1 不变量 =「业务模块零改动」+ 验收门槛第 1 条「git diff 确认」（ENGINE_CONTRIBUTOR_GUIDE.md:92、ADAPTER_GUIDE.md:26、293）。为守住它：
  - 业务只写 `@key` 命名参数 + 结构化方法；参数绑定方言全部收进适配器内部（`_normalizeArgs`/PG `_bind` 正则 `@key`→`$N`/MySQL `?`）。
  - 逃生口纪律：`execute`/`executeNonQuery` 是逃生口，生产模块优先结构化方法（ADAPTER_GUIDE.md:111）——接口不是阻止你用原始 SQL，而是让「常用形状」不重复发明。
  - 方言差异标签化：`@engine-specific` 注释在每个方法上直接写三端差异，让新引擎实现者逐方法对照。
  - 契约测试去方言化：用例保持 `@named` 参数，PG `_bind` 自动转 `$N`/MySQL 转 `?`，同一套 `runAdapterContractTests(adapterFactory, name)` 跑三引擎（ADAPTER_GUIDE.md:248-253）。
- **代价 / 陷阱**：
  - 接口被「吸」得越来越大（见 §2）——业务每需要一种 SQL 形状，就往基类加一个抽象方法；若业务面继续膨胀，冻结会被反复破例。
  - 「338 处零改动」的另一面：**方言能力被锁死在适配器层**，引擎想暴露独有能力只能走后门能力检测（`typeof x === 'function'`），或者等业务需求推动破例。
  - `_normalizeArgs` 直通默认的代价：SQLite 加 `@` 前缀、MySQL 转数组没问题，但「字符串字面量里的 `@` 会被当参数」（`'foo@bar.com'` 中 `@bar`）是三引擎共有的**已知边界**，没人修（ADAPTER_GUIDE.md:282-283 陷阱表）。
- **证据**：ADAPTER_GUIDE.md:22-31（D1-D5 表）、97、111、144-155；ENGINE_CONTRIBUTOR_GUIDE.md:92；提交 `0a3f0200`/`68f02064`/`fbd43ff4`（结构化方法的历史推进）。
- **与我们的差异**：我们计划的可替换 storage 服务契约可以把 D1 换成「存储服务消费者（业务模块）只依赖服务接口，不依赖具体实现」——方向一致，但我们的服务面会更小（storage 不是全功能 CRUD 而是幂等存取 + 批处理？），值得按需裁剪而不是全盘照搬 47 个方法的宽度；「逃生口」概念（服务接口外保留原始执行入口）对我们同样有意义——可替换实现的能力差靠逃生口 + 能力检测吸收，而不是逼所有实现都做满。

---

## 7. 经验点 5：事务抽象 —— 池化引擎逼出的「上下文栈」设计

- **解决什么问题**：事务要么全引擎对称要么爆炸。SQLite/MySQL 单连接发 `BEGIN/COMMIT` 即可；**PostgreSQL 池化后，跨调用事务会断裂**（每次 execute 可能借不同连接），必须 pin 连接；而业务在事务体内调的是一堆不带 connId 的结构化方法。
- **方案**（EngineAdapter.js:15-27 + §7 全节 + 26ee17fa）：
  - 基类维护 `_txStack`（connId 栈），`execute`/`executeNonQuery` 读栈顶决定走 pinned 连接还是默认池——**调用方无感，22 个数据方法签名不变**。
  - 子类只实现 4 个 `@protected` 钩子 `_doBegin/_doCommit/_doRollback/_doKeepAlive`；PG 返回真实 connId 并 pin，SQLite/MySQL 发 SQL 返回 0。
  - 生产代码只用 `withTransaction(fn)`；`beginTransaction/commit/rollback` 标 `@private`（仅测试验证栈契约用）。
  - **并发安全演进史**（EngineAdapter.js:63-107 + 提交链）：最初「不支持嵌套 → 栈非空即抛错」在异步下误伤并发（两个异步流时间交错被当嵌套）→ 加 `_txTail` 串行队列（同一实例同时只有一个事务，按到达顺序排队）→ 加 `_txInFn` 同步前缀检测（真嵌套立即抛）→ 加 60s 等待超时防「await 后嵌套死锁」（`1566485e`/`b5486313`/`f00fb9a2`/`005791d3`）。
  - C# 侧 60s idle 超时（`TX_IDLE_MS=60000`）三引擎对称；`keepAlive()` 是逃生舱（事务内 await 长交互前续命），但文档反复强调**推荐把交互拆到事务外（乐观锁模式）**（EngineAdapter.js:654-694, 707-720）。
- **代价 / 陷阱**：
  - 这套设计是**为了 PG 池化的复杂度**而生的——SQLite/MySQL 单连接根本不需要 pin 与串行队列；对单连接引擎，`_txStack` 恒为单元素，串行队列纯属额外调度。
  - 事务内 await 用户交互 = 文档明令禁止反模式（60s 静默回滚 + 延迟错误「connId 已超时回滚」），keepAlive 只是逃生舱。
  - 事务超时上限与事务等待超时**必须对齐**（等待超时 60s ≥ C# idle 60s），否则排队调用会被误判死锁（EngineAdapter.js:101-104）。
- **证据**：EngineAdapter.js:15-27、41-107、534-798；ADAPTER_API.md §7、ADAPTER_GUIDE.md §8；提交 `26ee17fa` 起的一串 fix。
- **与我们的差异**：我们是 TS + bun:sqlite（单连接，事务语义由 SQLite 自身保证），没有池化/跨连接断裂问题，栈式上下文与串行队列大概率不需要；但「事务包装成服务契约上的一个不变量（要么全提交要么全回滚 + 超时语义）」以及「让事务内所有读写在事务上下文中自动路由（隐式传输）」这两个设计点，对可替换 storage 服务有参考价值——不过更强的参考是它的反面：**别为未来引擎的复杂度提前建抽象**（这层复杂度是被 PG 真实需求逼出来的，不是设计期预判的）。

---

## 8. 经验点 6：引擎注册表的惰性加载与四注册点（加引擎的成本清单）

- **解决什么问题**：加一个引擎（MySQL）时，要知道全部接入点，否则漏一处就是半个功能（如测试 stub 缺失 → import 就 ReferenceError；Electron 分支没初始化 → 引擎「看起来注册了」实则没起）。
- **方案**（ADAPTER_GUIDE.md §3、§9）：
  - `adapter/index.js` 的 `_engineSpec` 惰性注册表，一行加一个 `{ load: () => import('./XxxAdapter.js'), className }`。
  - **必须惰性加载 + 字面量路径**：静态 import 会让 sqlite 模式测试被迫 transform 重型适配器（实测 PgSQL transform ~11x、import ~3.3x，拖垮无关测试超时）；变量路径会被 Rolldown 静态分析退化为运行时网络 fetch，**打包后在 CefSharp/Electron 里 404**（`8bb8bc52` 修过）。
  - **4 处桥注册**（CefSharp `JavascriptBindings.cs` / `Program.cs` 引擎分支 / `src-electron/main.js` / `vitest.setup.js` 的 `globalThis.Xxx = Proxy<noopAsync>` stub）——漏一处在测试里炸或运行时静默。
  - 测试 stub 用 `new Proxy({}, { get: () => noopAsync })`——任何访问都返回 async no-op，保证 import 不炸。
- **代价 / 陷阱**：每个引擎是**永久横向面**（DDL 翻译、SQL 片段、契约测试、CI matrix、上游表变更同步都要持续跟进）——ENGINE_CONTRIBUTOR_GUIDE.md §1 的结论是「除非有明确用户场景与维护承诺，否则不要引入新引擎。这不是技术问题，是维护承诺问题」。
- **证据**：ADAPTER_GUIDE.md:60-87、196-213；提交 `8bb8bc52`、`0687cdba`（CI repair）。
- **与我们的差异**：我们是 bun workspace + 插件机制，引擎/实现注册更像「插件 manifest + 惰性 import」，旧实现的「4 注册点」清单对我们是「插件要声明/注册哪些入口」的清单化启示；「测试环境给全局桥打 no-op Proxy stub」可直接迁移为「未提供实现时服务契约的 stub/假实现」模式。

---

## 9. 经验点 7：文档与代码的契约同步方式（冻结数字 + 例程化指南）

- **解决什么问题**：三引擎 + JSDoc 时代，接口契约散落（方法签名、方言差异、引擎矩阵、事件语义），新人写新引擎从哪找「全量契约」。
- **方案**：四层文档分工：
  1. `ADAPTER_API.md`（契约参考）：全部公开方法签名表 + 方言差异列 + 事件推送 §9 + 维护表。
  2. `ADAPTER_GUIDE.md`（实现方教程）：步骤 0-9 从 C# 封装到验收，含「47 个抽象按类实现」清单与 13 条陷阱表。
  3. `ENGINE_CONTRIBUTOR_GUIDE.md`（贡献者流程）：立项→设计(D1-D5 等价物)→实现切片(S1-S12 依赖图)→测试→文档→验收门槛。
  4. `PGSQL_DESIGN.md`（1242 行完整设计案例）：作为新引擎设计文档模板（含失败模式表、切片划分、Resume-Critical 事实供上下文恢复）。
- **代价 / 陷阱**：数字靠人肉同步（42+3 已与代码 47+5 分叉，靠破例叙事自洽但仍是两个概念）；文档指引 `git show 07ebdba2:docs/CHANGE_NOTIFICATION_DESIGN.md` 这种「历史提交里的设计文档」存活在 git 历史而非工作树，需要读者会 git。
- **证据**：三份文档头部互引 + 行号锚点互指（ADAPTER_API.md:3, 5；ADAPTER_GUIDE.md:3, 5）。
- **与我们的差异**：旧工程是「三份 Markdown 手册 + JSDoc」约定；我们仓库已有 docs/ 唯一副本原则 + GitHub issue 一等公民的治理，契约装载点可以更强（如接口定义即文档、类型即契约、验收写进 issue）。但「契约一份、教程一份、流程一份」的分层值得借鉴。

---

## 无法确定的事项

1. **42 个方法在冻结时刻（3afecfb7）的「逐方法」文档表**：ADAPTER_API.md 没有冻结快照的完整方法名清单（本文档 §1.1 的 42 项清单是我从代码逐个数出的，其中 `begin/commit/rollback` 在冻结时叫这名、现在改名了）；文档表是「现行」视角。
2. **`getPoolStats` 的 JS 侧 fallback**：提交 `b540b0d4`（getPoolStats fallback + JSDoc 扩展字段同步）与 `9dedc048`/`762b8943`（健康检查保持 async）的存在说明健康检查曾有非抽象形态，但**「什么时候开始有 fallback 逻辑、代码在哪」未逐行核实**（不在本任务四文件范围内）。
3. **`onTableChange` 的当前生产消费方**：ADAPTER_API.md:142 明说「当前尚无生产消费方（接口就绪，等待首个接入，如多账号 Store 热替换）」——**未在任何非 adapter 目录 grep 到订阅调用，但未做全仓 grep 确认**。
4. **冻结时的「3 optional」与现在「5 optional」**：本文已从代码核实（冻结 = `_normalizeArgs`/`withPrefix`/`daysAgoISO`；现行 + `withTransaction` + `onTableChange`），但**文档从未给出这 3/5 个的名字清单**——上表是我从代码推的。
5. **PG trigger + NOTIFY 的实现细节**（`CreateChangeTrigger`/`EnsureChangeFunction`/`ListChangeTriggers`/`DropChangeTrigger`）：只在 ADAPTER_API.md §9.7 有叙述，**未在 C# 源码（Dotnet/PostgreSQL.cs）核对**（超出本任务范围）。
6. **52KB EngineAdapter.js 之外的适配器实现差异**：SQLiteAdapter（53 KB）/PgSQLAdapter（83 KB）/MySQLAdapter（59 KB）的具体实现（`_bind`、类型映射、索引策略）仅在 ADAPTER_GUIDE 里有转述，**未逐行读实现文件**。
7. **「Interface frozen」是团队口径还是作者个人口径**：只有 2026-07-16 单一提交 + JSDoc 头注释，**未找到独立的冻结批准记录**（如 issue review 链接；ADAPTER_GUIDE 引用的 tasklist 是 Issue #3，冻结本身无专门 issue）。
8. **文档称 EngineAdapter.js「1205 行」（ADAPTER_API.md:3）与实测 1307 行**：差异来源（后续提交增加 onTableChange/事务队列所致）合理但**未逐提交验证**，故不写死原因。

---

## 附：本任务涉及的关键提交（便于 captain 复核）

| 提交 | 日期 | 内容 |
|---|---|---|
| `3afecfb7` | 2026-07-16 | JSDoc 完善 + **接口冻结**（42 abstract + 3 optional） |
| `b13fa83b` | 2026-07-19 | PgSQLAdapter 42+3 方法 + `_bind` + schema 隔离 + 三引擎 initAdapter |
| `4ff8aaa8` | 2026-07-19 | 同步 MySQL 分支 engineType getter（**engineType 晚于冻结**） |
| `26ee17fa` | 2026-07-25 | 事务破例：栈式事务上下文 + withTransaction |
| `1566485e`/`b5486313`/`f00fb9a2`/`005791d3` | 2026-07-25~ | withTransaction 并发串行化/超时兜底修复链 |
| `c08c62e1` | 2026-07-26 | 健康检查 isConnected/getHealth 提升为基类抽象（破例②） |
| `9429cca8` | 2026-07-26 | GetPoolStats poolIdle → availableCapacity |
| `80f07292` | 2026-08-02 | 变更订阅：三端写漏斗实时层 + 计数器完备层 + PG 原生推送 |
| `9b6442af`/`94590689`/`53dfd951`/`c4f6b581` | 2026-08-02~ | onTableChange 轮询/路由/门控/退订幂等 |
| `e4ec5611` | 2026-08-24 | origin/old/main HEAD（勘察基线） |
