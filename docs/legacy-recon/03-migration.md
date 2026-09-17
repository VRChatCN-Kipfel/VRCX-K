# 03 · 迁移机制勘察：.map 声明式迁移系统（old/main）

> 勘察对象：`origin/old/main`（VRCX 官方 MIT fork 链）的 `src/services/database/migrations/`。
> 全部内容来自 `git show origin/old/main:<path>`，只读提取，未复制任何旧代码入库。
> 代表性证据提交：`677dd653`（引入声明式 .map 系统）、`5c040a0b`（安全加固）、`c91ceeb9`（等价性修复 + dump 测试）、`8e525df8`（删除旧迁移代码）、`7a6022cb`（事务保护测试）。

## 总览：系统是怎么构成的

- 每个版本一个目录 `migrations/{N}/schema.map` + `data.map`（可缺其一），外加 `_template.map` 权威格式模板（266 行注释）。
- `index.js`（972 行）是运行器：`scanMigrationDir → topologicalSort(Kahn) → executeMigration(按版本+类型开事务) → recordCheckpoint`。
- 版本号存 configs 表 `config:VRCX_databaseversion`（`configRepository` transformKey 后小写），调用侧 `src/stores/vrcx.js` 的 `TARGET_DB_VERSION = 16`（vrcx.js:50）。
- 升级策略决策树（vrcx.js 启动 init 内）：`state.databaseVersion < TARGET` → `upgradeInPlace`（原地跑迁移）；版本丢失/全新库 → `handleUninitializedDatabase` → 三选一：备份指向旧库 → `migrateFromOldDb`（整库搬运 + 再跑 .map 迁移 + `{oldDb}` 参数）；否则 `initAndFixInPlace`（initTables + 跑迁移）。
- `migrateFromOldDb` 用 `createAdapter({connection: 'sqlite:///<旧库路径>'})` 建 oldDb 实例，`listTablesTypes()` 枚举旧库全表结构 → 逐表按可见列 `SELECT → INSERT OR IGNORE` 搬运 → 才对新库 `runFixes(targetVersion, {oldDb})`。`old_db` 参数源读的就是这个实例。最终版本号 `Math.max(旧库版本, 目标版本)`，防降级。
- 迁移跑完尾部执行 `adapter.vacuum() + adapter.optimize()`（index.js:88-93），失败仅 warn 不阻断。

---

### 经验点 1：`.map` 声明式 JSON——schema 变更与数据修复共用一个文件格式
- **解决什么问题**：一次数据库升级 =「schema 变更 + 数据修复 + 依赖顺序 + 幂等语义」四件事，用代码硬编码时（旧 `tableAlter.js`/`tableFixes.js`，见经验点 7）每次升级要手写 JS + try/catch 幂等，升级路径不可审阅、不可对拍。
- **方案**：
  - schema.map **完整字段**：`version`（必填，数字，须与目录名一致）、`type`（必填，`"schema"`/`"data"`）、`description`（可选）、`database`（可选 `{before, after}` 引擎限制，空串/省略=不限）、`dependencies`（可选版本号数组）、`changes`（schema 必填数组）。
  - **变更字段**（schema，5 种操作）：`table`（模式或精确名）、`operation`（`add_column` / `create_index` / `drop_column` / `rename_table` / `execute_sql`）+ 各操作专属字段：
    - `add_column`：`column` + `type`（TEXT/INTEGER/REAL/BLOB）+ `default`（必填）
    - `create_index`：`name`（可选，缺省自动生成 `${table}_${columns.join('_')}_idx`）+ `columns`
    - `drop_column`：`column`
    - `rename_table`：`newName`
    - `execute_sql`：`sql` + `idempotent: true` + `idempotentColumns: []`（白名单，见经验点 5）
  - data.map **额外字段**：`params`（参数定义对象）+ `fixes`（必填数组）。`fixes` 三种操作：`delete`（`table`+`where`）、`update`（`table`+`set` 对象+`where`，set 值支持 `@param` 引用）、`insert`（`table`+`columns`+`values`，`INSERT OR IGNORE`）。
  - **params 参数的 4 种 source**：`fixed`（字面值）；`subquery`（当前库执行标量 SQL 取首行首列，可选 `bind: [key]` 把同级字段作 `@key` 绑定）；`old_db`（在运行时传入的 oldDb 实例上执行）；`sql_embed`（将 SQL 文本**原样嵌入** SET 子句做相关子查询，运行时校验必须以 `(` 开头）。
  - **最小 schema 示例**（取自 16/schema.map:10-17，已去注释）：
    ```json
    { "version": 16, "type": "schema", "database": { "before": "", "after": "sqlite" },
      "dependencies": [], "changes": [
        { "table": "%_feed_gps", "operation": "add_column", "column": "group_name", "type": "TEXT", "default": "''" } ] }
    ```
  - **最小 data 示例**（16/data.map:53-57）：`{ "version": 16, "type": "data", "dependencies": [16], "fixes": [ { "table": "%_friend_log_history", "operation": "update", "set": { "type": "CancelFriendRequest" }, "where": "type = 'CancelFriendRequst'" } ] }`
  - 其中 `dependencies: [16]` 表示 data 依赖本版本 schema（同版本内 schema 恒在 data 前，这条显式依赖是自文档 + 跨类型排序锚点）。
- **代价 / 陷阱**：
  - 格式校验只做浅层（`validateMapFile`：version 是数字、type 匹配、changes/fixes 是数组、database 字段形状），**列名/类型不校验**，错误在运行时才暴露。
  - `execute_sql` 的 `table` 字段**不展开通配符**，仅作自述文档（_template.map:64）。
  - index.js:506-508：未知 schema 操作只 `console.warn` 后继续——**拼错 operation 不会报错，静默跳过**，这是设计上的软肋。
- **证据**：`_template.map:15-136`（完整字段清单）、`_template.map:157-266`（引擎限制/表名模式/操作类型/参数解析/排序规则）、`16/schema.map`、`16/data.map`、`index.js:155-204`（validateMapFile）。
- **与我们的差异**：本仓库宿主是 Cordis(bun) 且数据库层将来在 bun 侧实现；.map 是 Vite 时代的产物（见经验点 6），但其「声明式 + 校验 + 依赖 + 幂等」文件格式本身与运行工具无关，可作为独立格式吸收。

---

### 经验点 2：运行器语义五件套——排序/通配符/参数/幂等/检查点
- **解决什么问题**：迁移的「什么先跑、跑哪些表、值从哪来、跑挂了怎么办、跑到哪了」全链路语义。
- **方案**（逐条）：
  1. **版本排序/筛选**：`scanMigrationDir(maxVersion)` 遍历 glob 出来的 `./{N}/schema.map|data.map`，正则 `^\.\/(\d+)\/(schema|data)\.map$` 解析版本与类型，`version > maxVersion` 直接丢弃（index.js:105-126）；`runMigrations` 再按 `(currentVersion, targetVersion]` 开区间筛选（index.js:62-66）。目标版本由**调用者携带**，运行器不持有内部常量。
  2. **拓扑依赖排序**：Kahn 算法建 DAG（index.js:306-413）。三类边：① 同版本内 `schema → data` 隐式边；② 显式 `dependencies: [N]` → 都指向 `v{N}-schema`（跨版本依赖 schema 版）；③ 跨版本链式边 `vN 末位 → vN+1 首位`。队列每轮稳定排序：版本号升序，同版本 schema 优先。**循环依赖直接抛错终止**（不再静默回退——`5c040a0b` 安全加固把「回退简单版本排序」改成硬失败）。
  3. **通配符表名展开**：`table` 以 `%` 开头 → `adapter.listTables(pattern)` → `SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE @pattern`（参数化绑定，`5c040a0b` 消除注入风险）。`%_friend_log_history` 匹配到所有 `{前缀}_friend_log_history` 用户表。精确名不查询直接返回。
  4. **参数解析**：见经验点 1 的 4 种 source；`@` 前缀只在 `update.set` 对象值里触发（resolveParamsInObject），非 `@` 开头原样保留；`sql_embed` 返回 `{__sqlEmbed: true, sql}` 哨兵对象，`buildSetClause` 直接嵌入文本、`flattenArgs` 跳过它（index.js:936-961）。未定义的 `@param` 按字面返回 paramName（index.js:836-841）——把「拼错参数名」静默变成「把 '@xx' 当字符串写进列」。
  5. **幂等性**：四种渠道叠加——SQL 本身（`CREATE INDEX IF NOT EXISTS`、`INSERT OR IGNORE`）、错误文本匹配跳过（`duplicate column name`/`no such column`/`no such table`/`already exists`，且 `isMissingDeclaredColumn` 只匹配白名单列名防误吞）、`idempotent+idempotentColumns` 白名单（见经验点 5）、以及「所有操作幂等 ⇒ 部分失败可整批重跑」的总体保证（_template.map:265-266）。
  6. **版本中途检查点**：`recordCheckpoint(version)` = `configRepository.setInt('VRCX_databaseVersion', version)`，且在 `withTransaction` 的 **COMMIT 前**执行（index.js:458-467）——检查点与迁移同事务，`schema 成功 / data 失败` 时版本号不前进（注释明说：因全操作幂等，下次重试可安全恢复）。被跳过的 .map（引擎不匹配）也记录检查点，避免每次启动重复评估（index.js:437-446，INV-04）。
  7. **引擎限制**：`database.before/after` 不区分大小写比较；`.map` 锁定 sqlite 而当前引擎非 sqlite → **跳过并记检查点**（PgSQL initSchema 已含最新结构）；其他不匹配（含反向）→ **抛错**（index.js:256-289）。
- **代价 / 陷阱**：
  - `drop_column` 依赖 SQLite ≥ 3.35（_template.map:50）。
  - `executeUpdate`/`executeDelete`/`executeInsert` 的 catch 只 `console.error` **不抛**（index.js:725-728, 757-759, 782-784）；真正的止错点是 schema 路径（add_column 等兜底跳过是设计）与 `execute_sql`（严格抛）。**data 修复失败会被吞掉但事务继续 COMMIT**——这是与「错误即回滚」相反的语义，等价性测试正是为抓住这类差异而存在。
  - 同一版本 schema 与 data 是**两个独立事务**（index.js:455-456 注释），不是一个大事务。
- **证据**：index.js:46-97（runMigrations）、105-126（扫描）、306-413（拓扑排序）、793-804（展开）、813-903（参数解析）、936-961（SET 构建）、458-467（检查点/事务）、256-289（引擎限制）；`_template.map:244-266`（依赖与排序规则）；`5c040a0b`（安全加固提交）；`677dd653`（引入提交）。
- **与我们的差异**：bun 宿主单进程模型，事务语义更简单（无 C# 连接池/60s idle 超时）；但「每版本独立事务 + 检查点与迁移同事务 + 全操作幂等」这套安全组合完全可移植。

---

### 经验点 3：可回滚吗？——旧系统【没有回滚】，安全靠「事务 + 幂等 + 等价性测试」三件套
- **解决什么问题**：`#27` 验收要求「迁移可执行且可回滚」。需要先厘清旧系统的真实安全模型，才能判断什么能力需要自己建。
- **方案**：
  - **结论：旧系统不支持「降版本回滚」**（down-migration），完全**没有** down 脚本/逆向 .map 的概念。
  - 它的安全保证是三层递进：
    1. **事务原子性**：每个 `version+type` 一个事务（`adapter.withTransaction`），其中任何一步抛错 → 整个事务 ROLLBACK → 数据库回到迁移前状态，检查点（同事务内、COMMIT 前记录）也不落盘（index.js:458-467；migrationTransactionProtection.test.js:158-196 实测证明「先前成功的 ADD COLUMN 也被回滚」+「无检查点」）。
    2. **全操作幂等**：所有 schema 操作与 SQL 按经验点 2 第 5 条设计为可重复执行 ⇒ 失败后无需回滚，**直接重跑整个迁移**即恢复（transactionProtection 测试专项覆盖「失败 → 重试 → 到达目标版本」）。
    3. **等价性测试**（见经验点 4）：迁移前后「旧实现 vs 新声明式实现」在 fixture 上逐字节等价，防止迁移本身写错数据。
  - 调用侧还有**版本保护**：`TARGET_DB_VERSION` 高于当前 → 升级；**低于**当前（旧库新版）→ 只 warn「数据可能不完全兼容」不降级（vrcx.js:182-185）；`migrateFromOldDb` 取 `Math.max(旧版本, 目标版本)` 防降级。
  - 引擎切换升级（SQLite→PG/MySQL）的「备份/回退」依赖的是**推送式管道**（`pushFromSqlite`/`pullToSqlite`，见 `ENGINE_MIGRATION_GUIDE.md`）——目标库由管道重建、源库只读不被破坏、可再拉回 SQLite，这是「回滚」的替代实现（滚回引擎而非滚回版本）。
- **代价 / 陷阱**：
  - 「幂等 ⇒ 重跑可恢复」成立的前提是**每个操作真的幂等**——c91ceeb9 正是抓到 4 处不幂等/不等价（含 F4：先回填后 drop 列导致重试时 `no such column`），补了白名单机制才闭环。**幂等是写出来的纪律，不是框架保证的**。
  - 无 down 迁移意味着：上线后发现 vN 迁移有 bug，只能写 vN+1 的修复迁移（append-only 修补），不能撤回 vN。
  - 事务内禁止用户交互：C# 侧 60s idle 超时自动回滚（EngineAdapter JSDoc），超时后事务内后续 SQL 报「connId 已超时回滚」。
- **证据**：index.js:454-473（事务+回滚+检查点）、_template.map:261-266（幂等/重试语义）、vrcx.js:176-186（版本决策树）、vrcx.js:312-319（Math.max 防降级）、migrationTransactionProtection.test.js:251-273（失败重试达标）、`ENGINE_MIGRATION_GUIDE.md:82-88`（远程→SQLite 回退语义）。
- **与我们的差异**：若我们的验收红线是「可回滚」，需自行设计 down 迁移或快照方案；旧系统给出的「事务 + 检查点同行 + 幂等重试 + 等价性金样」是**不引入回滚的最强替代**，可作为「可执行且可回滚」验收的等价解读参考。

---

### 经验点 4：等价性测试方法论——「金样 dump + 双实现对拍 + 幂等重复」三层（重点）
- **解决什么问题**：重写/声明式化迁移代码时，最大风险是**行为悄悄地变**（漏修一条、语义差一点、重试炸掉）。等价性测试把「迁移前后数据等价」变成可提交、可回归、可在 CI 跑断言的机械检查。
- **方案**（三个文件 + 一个金样）：
  1. **`preV16Fixture.js`**——「迁移前」标准库构造器。用手写 DDL 建旧形状 schema（含 `gamelog_location.groupName` 旧列名），造**两组用户前缀** `userA1`/`userB2`（专门逼出 `%_` 通配符多表展开的 bug），每条 schema 变更与每条数据修复都至少配一个「正例 + 对照组」行（注释明说这个设计原则）。**不建 configs 表**——检查点走 mock 的 configRepository，与库解耦（fixture 顶部注释）。
  2. **`migrationEquivalence.test.js`**——三层断言：
     - **逐条语义断言**：SC1-SC11（schema 等价）+ D1-D9（data 等价）。用 PRAGMA 直读列/索引/行，逐行核对每个 fix 的正例与对照组（如 D7：Alice 的 traveling 被回填、Dave 无匹配 join 保持 'traveling'；D8：超出 SUM 的归零、未知 location 因 EXISTS 守卫不动、低于 SUM 不动）。注释明说：**变体逐条断言是「等价 oracle」的投影**（旧 tableAlter/tableFixes 的语义逐条翻译成断言）。
     - **整体金样比对**：`runMigrations(0,16)` 后 `normalizeDump(db)` 与提交的 `__fixtures__/v16-expected.dump` 逐字符比较（仅容忍 CRLF）。金样用 `WRITE_GOLDEN=1` 环境变量再生成（**仅本地，禁 CI**——测试里该路径直接 return 不断言）。
     - **幂等断言**：`runMigrations(0,16)` 跑两遍，dump 必须逐字节一致（equivalence.test.js:332-339）。
  3. **`dumpNormalizer.js`**——把任意 sqlite 变成确定性文本：
     - schema 段：`sqlite_schema` 里 `type IN ('table','index')` 且排除 `sqlite_%`（滤掉 sqlite_sequence 等易变内部对象）；表按字母序、索引按字母序；DDL 压缩空白 + **剥掉 `IF NOT EXISTS`**（幂等与否不影响比对）。
     - data 段：每表按字母序，行按 PK 列（无 PK 则全列）排序；字面量规范化（`null→NULL`、数字原样、字符串加单引号且内嵌 `'` 加倍、BLOB→`X'hex'`、布尔→0/1）。
     - 产出行稳定 ⇒ 可作提交的金样。
  4. **`memoryAdapter.js`**——让测试跑「真实运行器 + 真实 .map」：继承生产 `SQLiteAdapter` 只覆写两个裸执行方法，底层是 Node 内置 `node:sqlite` 的 `:memory:` 库；事务 override 成 SQL 语句模式 + 恒真 keepAlive。生产单例 `adapter`/`configRepository` 用 vi.mock 换成内存实现（多行注释说明「mock 解析到同一绝对模块才拦得住 import」）。
  5. **对拍源头**：这套测试的「旧行为」基准来自**已被删除的旧手写迁移** `tableAlter.js`/`tableFixes.js`（8e525df8 前一天还在 USE_NEW_MIGRATION 开关的旧分支）。`c91ceeb9` 提交正文记录了完整的对拍史：F1（set 值带引号入库的 BUG）、F2（固定索引名 + IF NOT EXISTS 导致第二个用户表索引被静默跳过）、F3（COALESCE 归零误伤无记录 location，需 EXISTS 守卫复现旧 Map 语义）、F4（回填后 drop 列破坏幂等）。**迁移代码重写 = 双实现并行 + 开关 + 对拍测试 + 观察期 + 才删除旧实现**。
- **代价 / 陷阱**：
  - 金样是**整库快照**：任何 fixture 或迁移改动都会让整个 dump 断言红掉，改 fixture 必须连带重新生成金样（需人工确认差异合理）。
  - 逐条断言是按 id 硬编码的（`expect(byId.get(11).location).toBe('wrld_abc:12345')`），fixture 加行会破坏行号语义，维护成本随迁移数线性涨。
  - 「逐条语义断言」与「金样」是**双保险不是重复**：逐条断言精准定位差异语义，金样防「每条都对但整体没对」（如少了某张表）。
  - `WRITE_GOLDEN` 门禁写在测试代码里（`.env` 判断），靠纪律防 CI 误开。
  - 对拍方法论前提是**旧实现还活着**——重写迁移时保留旧分支/开关是必要条件（8e525df8 先删，测试才成为唯一权威）。
- **证据**：`migrationEquivalence.test.js:1-21`（方法论文档注释）+ 107-340（三层断言）、`dumpNormalizer.js:1-26`（规范化规则）+ 106-159（实现）、`preV16Fixture.js:1-19`（fixture 设计原则）+ 28-399、`memoryAdapter.js:24-113`、`__fixtures__/v16-expected.dump`（金样）、`c91ceeb9` 提交正文（对拍史 F1-F4）、`8e525df8`（删除旧实现）。
- **与我们的差异**：我们（bun 宿主）没有「CefSharp C# SQLite 旧实现」可对拍，但「金样 dump + 幂等重复 + 双实现开关对拍」方法论可直接用在：迁移器重写、bun:sqlite 换驱动、多引擎适配器抽象时的行为保全。

---

### 经验点 5：`execute_sql` 的幂等白名单——「可重试」与「不吞错」的平衡
- **解决什么问题**：`execute_sql` 承载「列重命名 + 数据回填」这类一次性操作（加新列 → 旧列数据搬过去 → drop 旧列）。首次运行成功后再重跑，SQL 引用的旧列已不存在，会抛 `no such column`——只靠 SQL 自身无法幂等，而**无脑吞错误又会掩盖未来迁移作者的拼写错误**。
- **方案**：`executeRawSql` 读 `op.idempotent`（true 才启用）+ `op.idempotentColumns`（预期重试时已消失的列名白名单）。出错时 `isMissingDeclaredColumn` 解析错误文本（`no such column: X` 与带引号变体），**仅当**错误指向白名单内列时跳过，其他任何错误（含拼错列名）一律抛（index.js:520-528, 545-568）。schema.map 实例（16/schema.map:32-38）：
  ```json
  { "table": "gamelog_location", "operation": "execute_sql", "idempotent": true,
    "idempotentColumns": ["groupName"],
    "sql": "UPDATE gamelog_location SET group_name = groupName WHERE groupName IS NOT NULL AND groupName != ''" }
  ```
- **代价 / 陷阱**：
  - 白名单列名写错（与实际 drop 的列不符）→ 错误不匹配 → 照常抛，安全侧不失效。
  - 匹配基于**错误文本子串**（`e.toString().includes`），跨引擎错误文案不同时需逐引擎验证（如 PG/MySQL 的 `column ... does not exist`）。
  - 这是 F4 的产物：旧代码根本不回填（直接 drop 丢数据），新路径保留回填（数据保留是正确的重命名语义），代价是必须发明白名单机制保证重试安全。
- **证据**：index.js:520-568、16/schema.map:32-38、`c91ceeb9` F4 段落。
- **与我们的差异**：bun:sqlite 错误是结构化的（`ERR_SQLITE_ERROR` 等），可做更精确的错误分类而不用文本匹配；「白名单化的一次性 DDL+数据搬运」模式与我们的列演进需求同构。

---

### 经验点 6：构建耦合——`import.meta.glob` 是 Vite 专用的静态分析钩子（警告）
- **解决什么问题**：把 `.map` 文件（运行时 JSON 资源）打进生产 bundle。
- **方案**：`const mapGlob = import.meta.glob('./*/*.map', { query: '?raw', import: 'default' })`（index.js:32-35），Vite 静态分析把匹配文件以 raw 字符串打进产物；运行时按路径取 loader → `await loader()` → `JSON.parse`。文件头注释记录了踩坑史：此前用动态 `import()` + `@vite-ignore`，**Vite 看不到 → 文件不进 bundle → 生产环境 404**（22df5aa0 提交「…import.meta.glob 替换 @vite-ignore 动态导入」）。
- **代价 / 陷阱**：
  - **耦合点**：`import.meta.glob` 是 Vite（及少数 bundler）的编译期特性；**bun 的 `import.meta.glob` 语义不同（返回懒加载模块而非 raw 字符串），且 `?raw` 查询在 bun 不成立**。宿主换 bun 后这行代码不可能原样工作。
  - 路径模式 `./*/*.map` 与目录约定强绑定：版本目录必须数字命名、下划线模板根级排除、每个新版本目录自动进 bundle（新增迁移**无需注册**，这也是声明式的好处）——但扫描靠**模式匹配字符串** `^\.\/(\d+)\/(schema|data)\.map$`，glob 结果里混入的无关文件会被静默跳过（scanMigrationDir 的 continue），坏处是「目录里放了文件但没被匹配」时无报错。
  - glob 是构建时快照：运行期新增/修改的 .map 不生效，必须重新构建。
- **证据**：index.js:19-35（含 4 行长注释）、22df5aa0（修复提交）、loadMapFile index.js:134-147。
- **与我们的差异**：我们的宿主是 bun（走 `bun build`/直接运行），`import.meta.glob` 的 raw 语义不成立。等价做法：构建期把 `migrations/**/*.map` 作为静态资源目录随产物分发 + 运行时用 `fs.readdir/readFile` 扫描（保留「新版本免注册」特性），或用 bun 的 `Bun.file`/导入 JSON；若用 TypeScript，也可 `import.meta.glob` 换成显式 `import x from './16/schema.map?raw'` 的转译插件。无论如何，**「迁移集在构建期收集」这个耦合点在 bun 下要重新设计**。

---

### 经验点 7：对拍式替换的完整流程——「双实现 + 开关 + 等价测试 + 观察期 + 删除」
- **解决什么问题**：让高风险的系统性迁移代码重写（手写 → 声明式）可增量上线、可回退、可证明等价。
- **方案**：
  1. 引入声明式系统时保留旧实现，`USE_NEW_MIGRATION = false` 开关（8e525df8 前的 vrcx.js），新旧双路径共存。
  2. 新路径跑等价性测试（经验点 4），对照旧 `tableAlter.js`/`tableFixes.js` 行为逐项修（F1-F4）。
  3. 生产观察期结束后，`8e525df8` 删除开关 + 旧代码，注释明确引用第三方 grep 确认无残留引用才删。删除收尾时还顺手统一：runFixes 简化为单委托、vacuum/optimize 挪进 runMigrations 尾部（去重复）。
- **代价 / 陷阱**：双路径共存期两套代码都要维护；开关常量本身是死代码风险（若忘删则行为分支永远停在 false）。
- **证据**：`677dd653`/`c91ceeb9`/`8e525df8` 三个提交的时间线（6/27 引入 → 7/17 修等价 → 7/17 删旧）。
- **与我们的差异**：我们是从零建新系统（无旧实现），对拍对象不存在；但「重写既有数据层时保留开关做 A/B」对任何后续大改（如 bun:sqlite 换驱动、加多引擎）仍是可复用的工程流程。

---

### 经验点 8：跨引擎的「声明式迁移」纪律——engine 限制 + 运行期引擎探测
- **解决什么问题**：同一套 .map 会跑在 SQLite / PostgreSQL / MySQL 上（本项目后端有多引擎分支），跨引擎执行错误 schema 是灾难。
- **方案**：
  - `.map` 声明 `database.before/after` 限制；`.map` 锁 sqlite 而当前引擎非 sqlite → **跳过并记检查点**（因为非 sqlite 的 `initSchema` DDL 已含最新结构，INV-04）；反向/其他不匹配 → **严格抛错**（防误执行）。
  - 引擎探测从「读 VRCXStorage 配置」改为**读运行时 adapter 单例的 `engineType` getter**（index.js:206-241 注释记录 Phase 9 任务 9.12 的动机：配置读与真实构造的 adapter 可能分叉，导致把 sqlite 定向的 .map 打到 PgSQL schema）。
  - 配套 `docs/architecture/ENGINE_MIGRATION_GUIDE.md`：完整记录 SQLite→PG/MySQL 的推送管道（只读源、白名单表、mirror 兜底、行数严格校验、分组事务、bulkInsert('ignore') 防污染启动检查点、500 行/批规避 PG 参数上限、自增 id 原样复制、BY DEFAULT IDENTITY 兼容）与引擎差异对照表（表名形态/schema 隔离/主键类型/事务隔离/LIKE 通配/外部队列）。
- **代价 / 陷阱**：engine 限制是「.map 作者自律 + 运行时校验」双轨；新引擎加入时每个历史 .map 都要重新评估 `before/after` 是否覆盖（模板里空串 = 不限，容易漏约束）。
- **证据**：index.js:206-241、256-289、437-448；`ENGINE_MIGRATION_GUIDE.md:92-131`（push/pull 流程 + 引擎差异表）。
- **与我们的差异**：我们目前单一 SQLite(bun:sqlite)；若未来接 PG/MySQL，「迁移声明带引擎约束 + 引擎限制写在迁移文件里而非运行器里」值得直接采用。

---

### 经验点 9：事务基础设施的工程细节——`withTransaction` 池化栈与防死锁
- **解决什么问题**：C# 侧连接池设计下事务跨异步调用会断；且 JS 单线程假设在 `await` 交错时不成立，事务并发与嵌套需要明确定义。
- **方案**（`EngineAdapter.withTransaction`，index 之外的基础设施）：
  - 事务 connId 栈 `_txStack`：withTransaction push/pop，事务内所有 execute/executeNonQuery 读栈顶走 pinned 连接，外部走默认池。
  - **串行队列** `_txTail`：并发调用按到达顺序排队执行（而非「栈非空即抛错」误杀并发），配 60s 等待超时防**await 后嵌套死锁**（外层等内层、内层等队列 → 超时抛错）。
  - 同步前缀嵌套检查 `_txInFn`：只覆盖 fn 首个 await 前的同步段，快速失败。
  - `rollback` 对已超时/消失的 connId **静默 no-op**（对齐 PG 语义，让 catch 可无条件调 rollback），`commit` 无事务则**照常抛**（调用方 bug 要响）。
  - C# 侧 60s idle 超时自动回滚 + `keepAlive()` 逃生舱（事务内长交互前续命，但文档强烈建议交互拆出事务）。
- **代价 / 陷阱**：事务内 await 用户交互是最常见坑（对话框等 60s 即被静默回滚）；嵌套事务语义是「同步段快速失败 + await 后超时兜底」两段式，行为不直观。
- **证据**：EngineAdapter.js 头部注释（2026-07-25 变更记录）+ withTransaction 全文（含 4 个 @protected 字段注释）+ commit/rollback/keepAlive；migrationTransactionProtection.test.js:116-153（显式事务语义 4 项契约测试）、275-311（回滚自身失败不掩盖原始错误）。
- **与我们的差异**：bun:sqlite 事务是同步的、无连接池与 idle 超时，「串行队列 + keepAlive」大概率不需要；但「检查点与迁移同事务」「失败重试幂等恢复」与 withTransaction 的「回滚失败不掩盖原始错误」原则可直接沿用。

---

### 经验点 10：迁移失败的用户路径与状态机——升级对话框 + 非阻塞告警
- **解决什么问题**：启动时迁移是用户**等待中**的阻塞路径，失败要可见、可重试、不静默。
- **方案**：`databaseUpgradeState`（fromVersion/toVersion/currentTable/rowsCopied）驱动 `DatabaseUpgradeDialog` 进度展示；`upgradeInPlace` 失败 → 弹不可关闭的 alert（`dismissible: false`）提示升级失败 + `AppApi.ShowDevTools()`；`handleUninitializedDatabase` 的坏备份自动降级到 `initAndFixInPlace` 并 warn；调用侧统一在 `finally` 里 `resolveDatabaseInit()` 放行等待者。
- **代价 / 陷阱**：失败 UI 直接弹 DevTools 是「开发者向」的取舍；版本号高于目标（降级场景）只 warn 不阻断。
- **证据**：vrcx.js:151-208（决策树 + 升级分支）、258-270（upgradeInPlace 失败路径 + dialog 状态）、337-355（initAndFixInPlace）、数据库升级对话框状态字段。
- **与我们的差异**：我们无 CefSharp UI 层（宿主 sidecar + WebApp），对话框粒度不同；「迁移失败 = 可见状态 + 可重试 + 版本不前进」的状态机语义可迁移。

---

## 无法确定的事项

1. **`migrations.js` 只有 re-export**（`export { runMigrations } from './index.js'`），无附加逻辑——不确定其存在的意图（可能是历史兼容入口或 webpack 别名目标），对机制无影响。
2. **v15 及更早版本的迁移**：`old/main` 的 migrations 目录只有 `16/`——更早版本号的数据库升级在旧系统里是**无版本化迁移直接改 schema**（`tableAlter.upgradeDatabaseVersion` 幂等补列 + 9 个 fix 函数，8e525df8 删除）才落到 v16 的。也就是说：**v0→v16 的「一次性建库 + 补丁式修复」时代没有版本化迁移记录**，v16 是第一个版本化的 .map 版本；不确定历史上还有过多少「版本」概念。
3. **`_template.map` 声称 `execute_sql` "Idempotent: depends on the SQL itself"**，而运行器后来加了 `idempotent/idempotentColumns` 白名单（F4）——模板与实现存在轻微版本差；不确定模板是否后来同步更新过。
4. **`update`/`delete`/`insert` 的 catch 只 console.error 不抛**（index.js:725-784）是不是有意设计（吞掉 = 继续 COMMIT，还是应改为中止）；看代码注释无明确意图声明，只有 schema 路径与 execute_sql 明确「严格抛」。
5. **`expandWildcard` 只支持 `%` 前缀通配**（`%_suffix` 语义），LIKE 的 `_` 单字符通配未被转义——若表名本身含 `_`（表名都含 `_`），`%_feed_gps` 实际是「任意前缀 → `任意单字符`feed_gps」的近似匹配；在 `sqlite_schema LIKE` 语义下**不会**误匹配别的后缀，但不确定作者是否意识到 `_` 的通配含义（镜像代码里 comment 提到「等价查询但不含 ESCAPE」——说明注意到了）。
6. **`WRITE_GOLDEN` 门禁**依赖 `process.env` 且只在测试文件里用 `if` 分支——CI 一旦误设会静默覆写金样（不 fail），不确定是否有 CI 层防线。
7. **`import.meta.glob` 的 `./*/*.map` + 正则 `^\.\/(\d+)\/...` 的匹配集**：若未来版本目录是 `v17/schema.map`（带 v 前缀）会被静默忽略；不确定团队是否约定纯数字目录（当前 16 是）。
8. **`old_db` 参数源的使用场景**：`migrateFromOldDb` 流程中旧库数据已全量搬到新库后才跑迁移（copyTableData 在 runFixes 之前），`old_db` 源此时读旧库还有多少价值不确定（可能是跨引擎迁移时读源端结构/元数据用；`README 架构`未细述）。
