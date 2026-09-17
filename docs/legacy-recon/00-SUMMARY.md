# 00 汇总：经验点总表与交叉印证（legacy-db-recon 终稿）

> 汇总者：synthesizer（t6）。材料：t1/t2/t3/t4/t5 成员产出 + **两份队长材料**（06 复核 cap-1/cap-2 + 血统核验 cap-3）。
> 输出位置：`.temp/legacy-recon/00-SUMMARY.md`（不入库、不落 docs，.temp 可整体删除）。
> 勘察基线：`origin/old/main` HEAD `e4ec5611`（2026-08-24）；`rewrite` 为当前重写分支。
> **汇总纪律（队长三条，已照办）**：① 队长材料不是补充阅读，是必须交叉印证的对象；② 冲突不调和、并列标注；③ 不为简洁砍细节，结构可跳读。

---

## 0. 材料清单与来源前缀

| 前缀 | 文件 | 内容 | 状态 |
|---|---|---|---|
| IF | `01-interface-contract.md` | EngineAdapter 接口契约（42+3 冻结 → 47+5 现行；onTableChange；engineType；D1 不变量） | ✅ t1 完成 |
| SQ | `02-sqlite-implementation.md` | SQLite 实现与事务设计（18 经验点 + 复杂度归因三分类） | ✅ t2 完成 |
| MG | `03-migration.md` | .map 声明式迁移系统（10 经验点） | ✅ t3 完成 |
| DM | `04-data-model.md` | 数据模型（42 张表与 ERD/MCD/MLD） | ✅ t4 完成（attempt 2 重派后） |
| PV | `05-provenance.md` | 血统台账（作者分布与上游 merge 事实） | ✅ t5 完成 |
| **cap-1** | `06-captain-verification-sqlite-concurrency.md` §1-2 | **队长复核**：t2 并发论断的独立实测（bun:sqlite） | ✅ 队长材料① |
| **cap-2** | `06-captain-verification-sqlite-concurrency.md` §2-4 | **队长新增**：busy_timeout 在锁升级场景被绕过 | ✅ 队长材料① |
| **cap-3** | 队长消息（血统核验） | **队长独立核验 t5** + 新增事实：old/main 与 rewrite **无共同祖先** | ✅ 队长材料② |

> **cap 的定位（显式标注）**：cap-1/cap-2/cap-3 都是**队长对成员产出的复核与修正**（不是成员勘察产出），与 t2/t5 的原始结论**并列收录、不予合并**。cap-1 实测证实 t2 判断；cap-2 是队长新增、t2 未覆盖的发现；cap-3 独立复算 t5 断言并指出一条 t5 未提及的更根本事实。

---

## 0.5 最重要的三条跨材料结论（先读）

1. **SQLite 单连接并发是真实问题，但"损坏"结论与"可回滚恢复"实测并列存在**（cap-1 vs SQ-9，见 §2.1 交叉印证）：t2 说两事务并存"损坏连接"；队长对 bun:sqlite 的实测表现为"连接留在打开的事务里、可回滚恢复"。两者严重程度不同 —— **原文并列，不调和**；队长结论是否适用于本项目**未定论**（可能源自 t2 的 C# 桥层语境）。
2. **busy_timeout 不是万能**（cap-2）：一旦写事务内先 SELECT 再写（deferred 事务锁升级），SQLite 不能安全等待，`SQLITE_BUSY` 立即返回，busy_timeout 形同虚设（实测 2241ms vs 1ms）。⇒ 写事务要么 `BEGIN IMMEDIATE` 提前拿写锁、要么事务内不先读、要么应用层串行化。
3. **从 old/main 取用任何东西都是显式复制**（cap-3）：`old/main` 与 `rewrite` **没有共同祖先**（`git merge-base --all` 退出码 1），cherry-pick/merge 不会自然搬运任何东西 —— 取用行为本身可审计，无法意外发生；这也让血统证明成为"复制动作"的前置要求。

---

# 第一部分：经验点总表

> 归类标签（沿用 t2 三分类并扩展）：**[真需]** = 引擎/场景真实需要；**[PG 衍生]** = 为 PostgreSQL 池化发明的复杂度（对本仓库仅参考）；**[防御]** = 作者自述为将来误用兜底；**[方法]** = 工程方法论（可平移）；**[事实]** = 台账类事实；**[警告]** = 需要重设计/不可照搬。
> 每条保留四要素：「解决什么问题 / 方案 / 代价·陷阱 / 证据」。

## A. 接口与契约（t1）

| # | 经验点 | 标签 | 解决什么问题 | 方案（一句话） | 代价 / 陷阱 | 对我们的含义 |
|---|---|---|---|---|---|---|
| IF-1 | 接口冻结政策与破例流程 | 方法 | 三引擎并行时防止基类被单引擎需求随意改大 | 冻结基线（42 abstract + 3 optional，`3afecfb7` 2026-07-16）固化为文档计数；破例须「设计文档理由 → review → 基类+全部子类同步实现」；引擎特有扩展不入基类，走 `typeof x === 'function'` 能力检测 | 两次破例后文档「42+3」与代码「47+5」分叉，靠人肉同步数字必然滞后；`@private` 只是 IDE 高亮不强制（eslint 未开 check-access） | 我们 TS 用编译期 `abstract class`/`interface` 强制 + 契约测试断言数字，不靠注释纪律 |
| IF-2 | onTableChange 表级变更订阅（实时漏斗 + 完备层轮询双层） | 真需/方法 | 前端 Store 需要"表被写入时收到失效提示"，而非轮询 refetch | 事件是**失效提示**不是数据管道（负载 `{table,count,ts}`，无行数据，`count=-1`=全量失效）；实时层 = C# 写漏斗（表级毫秒）、完备层 = 计数器轮询 5s 兜底外部写者；基线去重防自写误触发；订阅即启停、无订阅零轮询 | 完备层 DB 级粒度 → 只能全表 `-1`；进程重启丢基线（重启后第一轮只重建基线）；PG 用 trigger+NOTIFY 原生推送，去重靠 500ms 窗口 | C# 桥层不可移植，但「物理表名 + 失效提示 + 基线去重 + 降级链」语义可直接复用；bun:sqlite 支持 `PRAGMA data_version`（完备层可平移） |
| IF-3 | engineType 元数据化（身份来自实例而非配置快照） | 真需/方法 | 迁移运行器要检测当前引擎但不应 import 适配器类 | `get engineType()` 默认 `'unknown'` 兼作"忘记覆写"信号，fallback 到 sqlite 保安全；迁移兼容性用结构化 `{compatible,skip}` 而非抛错 | `'unknown'` 是 truthy，fallback 用不等判断 `!== 'unknown'` 而非 `||`——约定易被忽略 | 「服务身份应来自服务实例本身，而非全局配置快照」对我们做可替换 storage 服务适用 |
| IF-4 | D1 不变量：业务零改动 | 方法 | 加第三引擎时 18 业务模块 338 处调用若都要改等于没有接口 | 接口被业务需求「吸」大（每个结构化方法对应真实调用点）；逃生口纪律（结构化优先、原始 SQL 兜底）；方言差异逐方法 `@engine-specific` 注释；契约测试去方言化一跑三引擎 | 接口持续膨胀会被反复破例；方言能力锁死在适配器层；`'foo@bar.com'` 字面量 `@` 会被当参数（三引擎共有已知边界，没人修） | 方向一致但宽度按需裁剪：不需要 47 方法全量，走「可替换 storage 契约 + 逃生口 + 能力检测」 |
| IF-5 | 事务抽象（上下文栈）——池化引擎逼出的复杂度 | PG 衍生 | PostgreSQL 池化后每次 execute 借不同连接 → BEGIN/INSERT/COMMIT 落不同连接，事务断裂 | `_txStack` connId 栈，栈顶在 execute 内部读，22 个数据方法签名不变；子类只实现 `_doBegin/_doCommit/_doRollback/_doKeepAlive` 4 钩子 | 单连接下 pin 纯属多余；事务内 await 交互被文档明令禁止（60s 静默回滚）；等待超时须 ≥ C# idle 60s 否则排队被误判死锁 | **「异步并发下的串行化」是真需求——见 cap-1**；单连接下 `BEGIN` 就是 `BEGIN`，pin 不需要 |
| IF-6 | 引擎注册表惰性加载 + 4 注册点清单 | 方法 | 加引擎漏一处注册点 = 半个功能（测试 stub 缺失 import 即炸） | `_engineSpec` 惰性注册表一行一个 `{load:()=>import(...),className}`；**必须惰性 + 字面量路径**（静态 import 拖垮无关测试 ~11x；变量路径被 Rolldown 打成 fetch 打包后 404，`8bb8bc52` 修复）；CefSharp/Electron/vitest 4 处桥注册缺一不可 | 每个引擎是永久横向面（DDL/SQL 片段/契约测试/CI matrix/上游表同步）；指南结论「不是技术问题，是维护承诺问题」 | 对应我们插件 manifest + 惰性 import；「加引擎=维护承诺」适用于我们加实现 |
| IF-7 | 契约文档分层 | 方法 | 契约散落无法让新人找到全量契约 | ADAPTER_API（参考）/ ADAPTER_GUIDE（教程）/ ENGINE_CONTRIBUTOR_GUIDE（流程）/ PGSQL_DESIGN（完整案例模板）四层分工 + 行号锚点互指 | 数字靠人肉同步会分叉（42+3 vs 47+5）；设计文档存活在 git 历史需读者会 git | 我们已有 docs 唯一副本 + issue 一等公民治理，可做到「接口定义即文档」 |

## B. SQLite 实现与事务（t2 + 队长复核 cap-1/cap-2）

| # | 经验点 | 标签 | 解决什么问题 | 方案（一句话） | 代价 / 陷阱 | 对我们的含义 |
|---|---|---|---|---|---|---|
| SQ-1 | 适配器集中方言差异（22 个 CRUD 构建器 + SQL 表达式函数） | 真需/方法 | 三引擎共享业务，方言（`@param`/`$N`/`?`、INSERT OR IGNORE/ON CONFLICT/ON DUPLICATE）不泄漏到 feed.js 等调用方 | `_normalizeArgs` + 22 个结构化方法 + 5 个 SQL 表达式函数（strftime/INSTR/SUBSTR 封装）；`selectUnion` 分支包 `SELECT * FROM (branch)` 派生表绕 compound-select 硬限制 | `upsertPartial` 三引擎三份实现；DDL 不抹平（作者自觉注释"换引擎重写整个方法"）；LONGTEXT 在 SQLite 按 TEXT 亲和处理是跨引擎语义统一 trick | 「业务结构化参数 + 方言表达式函数化 + UNION 分支派生表」形状可平移 |
| SQ-2 | 连接管理：ADO.NET 池化 | PG 衍生（旧单连接时代无） | 事务期间其他查询走独立连接不被事务阻塞（PR #13 池化改造） | `Pooling=True; Max Pool Size=16`；C# 池无 idle timeout，连接常驻到进程退出（桌面 <5 活跃连接，每连接 ~2MB page cache，作者接受） | 池统计用 peak-borrowed 近似（非真值）；池化后多连接并发写 → 需要 PRAGMA 三件套 + 重试；CefSharp 桥重载/类型截断两坑（`9b4228ee`/`2f49474c`） | bun:sqlite 单连接无池；「事务期间非事务查询不混入同一事务」的目标仍要达成 |
| SQ-3 | 连接串手工解析 + ConnectionCache | 方法 | push/pull 引擎操作外部 .db 文件（`sqlite:///` URI 模式） | URI 非 URL（空格/非 ASCII/`#`/`?` 会坑 `new URL()`）→ 手写前缀剥离器（盘符/Linux/UNC）；迁移期间同文件开关数千次 → 按 connectionString 复用进程级常驻连接 | 外部连接操作带连接缓存；「CEF 消息泵串行化 JS 调用无需加锁」的假设是桥时代前提 | 多库操作若用多 Database 实例，旧的 connectionString + 事务 pin + 实例路由是参考 |
| SQ-4 | busy_timeout + 指数退避重试（两道防线） | 真需 | 多连接并发写 → `database is locked`（SQLite 只支持一个并发写事务） | 第一道 `busy_timeout=5000`（内核等待 5s，桌面写事务 ms 级够用；PG/MySQL 15/30s 是网络超时，概念层次不同）；第二道重试：5 次/50ms 起/2 倍/2s 封顶/±25% jitter/**仅 Busy+Locked 两个码**；四执行路径全包裹 | busy_timeout 是**逐连接**的必须进连接串；**cap-2：第一道防线在锁升级场景被完全绕过**（见 §2.2） | 数值可照搬；但必须叠加 cap-2 对策（BEGIN IMMEDIATE / 事务内不先读 / 串行化） |
| SQ-5 | PRAGMA 注入防御 + 路径穿越校验 | 真需 | 用户可用 `VRCX_Database.options.*` 配任意 PRAGMA，`;` 可分裂连接串、rekey 系可给数据库重新上锁（灾难级） | 三层：key 白名单正则**先于**黑名单（rekey 系 8 个禁设）→ 值禁 `; ' " \n \r \0`；路径校验：null 拒绝→解析→规范化→边界检查（防 `../../evil.db`）→扩展名白名单→Windows 保留设备名拒绝；**用 `Path.IsPathRooted(resolved)` 查原始输入而非 GetFullPath 结果**（后者恒真无意义） | — | 注入面小得多（无连接串语法）；「白名单先于黑名单」结构与路径校验可平移 |
| SQ-6 | 维护与健康探针 | 真需 | Storage 层需 VACUUM/optimize/健康检查/池监控 | `vacuum()`=VACUUM、`optimize()`=PRAGMA optimize、`isConnected()`=SELECT 1、`getHealth()`、`getPoolStats()` 6 字段契约 | 池监控无对应物（我们是单连接） | bun:sqlite 可直发 `PRAGMA optimize`/`VACUUM` |
| SQ-7 | `_txStack` + connId 路由 | PG 衍生（池化后 SQLite 也需要） | 事务必须 pin 到同一连接（PG 池化；SQLite 池化后同样） | 栈顶在 execute 内部读（`this._txStack.at(-1)`），23 数据方法签名不变；connId null/0 走默认池 | 栈管理必须 try/finally pop（抛错也恢复）；connId 事务外零行为变化 | 单连接无路由需要；「隐式事务上下文」句法若实现为 begin/commit 包对象仍可借鉴 |
| SQ-8 | `withTransaction(fn)`（栈式、抛错回滚、嵌套拒绝） | 真需+防御混合 | 收编 begin/try/finally-commit/catch-rollback 样板，保证原子性 + 栈清洁 | 成功 commit+透传返回值；抛错 rollback+重抛（rollback 容忍已超时连接静默 no-op，自身失败不掩盖原错）；**同步前缀嵌套立即抛**（`_txInFn` 只盖 fn 首个 await 前——异步函数同步前缀模型）；事务内读未 commit 写是关键正确性保证（单测验证） | 并发交错（await 让出后另一流进来）不算嵌套去排队（见 SQ-9） | 「嵌套拒绝 vs 并发排队」的判定（同步段 vs 时间交错）最值得抄；bun 有原生事务 API 可包 |
| SQ-9 | `_txTail` 串行队列（防两事务并存打到同一连接） | 真需 | 文档自认原始设计缺陷：「JS 单线程：无并发打断，栈操作原子」假设在 `await` 下不成立——两独立异步流时间交错，两事务并存 → SQL 全部打同一 pinned 连接损坏（#27） | `withTransaction` append 到 Promise 链尾，前一个 commit/rollback 后才执行下一个；release 在任意路径 finally 推进 | 队列无超时则 await 后嵌套排队等死（超时兜底 SQ-10 转成可 catch 异常）；长事务阻塞后续事务排队（只是等待不误杀）；修复链 `b5486313`→`1566485e`→`f00fb9a2`（超时纳入 try/finally 防队列毒化） | **cap-1 实测证实**（§2.1）；串行队列 = 竞态从「运行时撞车」变「排队等待」的现成思路 |
| SQ-10 | `_txWaitTimeoutMs=60000` 队列等待超时 | 防御 | await 后嵌套 → 永久挂起（死锁盲区，PR #28 review 指出） | `Promise.race` + setTimeout 60s，**刻意对齐 C# `TX_IDLE_MS=60000`**（等待超时 ≥ 前序事务合法最大存活，否则排队被误判死锁）；默认值 30s→60s 修正过（`005791d3`） | 注释明说生产 10 处调用点均无嵌套 → **防御性兜底**；但真实兜住「误用挂起 + 队列毒化」两子问题 | 不引入串行队列则不存在；「等待超时 ≥ 事务最大存活」对齐原则值得抄 |
| SQ-11 | 60s sliding idle Timer + keepAlive() | 真需 | 事务泄漏（忘 commit 连接不还池）；事务内 await 用户对话框长事务阻塞；单连接时代事务内非事务查询隐式混入事务 | C# `TX_IDLE_MS=60000` Timer；pinned SQL 执行前暂停/执行后恢复（防慢查询执行中误触发）；`keepAlive()` 只重置 Timer 不执行 SQL，返回存活布尔；推荐**提前续命**而非卡 60s 回来打卡 | keepAlive 是逃生舱不是鼓励长事务；「事务应尽可能短、交互拆出去（乐观锁）」两套正反样板 | bun 无 sliding timer；「事务要短、交互拆出去」价值观直接采用 |
| SQ-12 | InFlight + TimedOut 竞态防御 | 防御 | `Timer.Change(Infinite)` 不会取消已排队回调——回调恰在 SQL 执行期间拿锁 Dispose 连接 → ObjectDisposedException | `TxHolder.InFlight` 计数 + `TimedOut` 标记；OnTxTimeout 见 InFlight>0 不立即回滚，SQL 执行完 finally 自查标记清理；TryGetValue 与 InFlight++/Timer.Change 同 `_txLock`（锁提供 happens-before，不需 Interlocked） | 文档自述触发条件极苛刻（idle 近 60s + Timer 已排队 + 恰好发 SQL + 执行跨过回调瞬间）但后果不可诊断 → 防御 | 自建空闲超时器才有对应物；纯功能可不实现 |
| SQ-13 | srcAdapter/dstAdapter 实例隔离 + withPrefix 正交 | 真需 | push/pull 同进程操作源库与目标库，事务上下文不能交叉 | `_txStack`/`_txTail` 是实例属性（每 adapter 独立，`_changeInstances` 按 conn 路由漏斗事件）；`withPrefix` 用独立 `_prefixOverride` 保存/恢复 | 无——「实例级状态而非模块级全局」纪律的直接收益 | 多库操作（每库一个 Database）同纪律适用 |
| SQ-14 | SQLiteConcurrentWrite.test.js（WAL + busy_timeout 理论验证） | 方法 | PR #13 池化后多连接并发写同一 .db 需理论安全基础 | **node:sqlite `DatabaseSync` + worker_threads**（非 C#，文件头 TODO 明说 C# 池化并发写需独立测试）验证驱动无关的文件级理论：每 worker `busy_timeout=5000; WAL; NORMAL` + `BEGIN IMMEDIATE→INSERT→COMMIT`：4×50/2×100/8×25 = 200 事务全成功 0 BUSY；最后独立连接 COUNT 验证无丢失 | 自述局限：不覆盖 C# ADO.NET 池化的连接管理/超时/重试路径（TODO 3 项） | bun:sqlite 与 node:sqlite 同源（官方 SQLite）→ 理论结论对我们成立；「BEGIN IMMEDIATE 短事务」压测模板可复用（**与 cap-2 对策自洽**） |
| SQ-15 | 真实并发问题清单（5 条 + 3 历史修复点） | 事实/真需 | 系统化记录单连接→池化→任何模式的并发问题 | ①单连接：长查询阻塞健康检查 + 事务中非事务查询混入（→池化 + pinned）；②池化后多连接抢文件锁（→PRAGMA+重试）；③任何模式：两事务并存损坏连接（→串行队列）；④桥 connId 截断（`2f49474c`）、重载解析（`9b4228ee`）；⑤计数 TOCTOU 泄漏（`28ceda93`）、借出失败计数未释放（`6f12a1d6` #30） | 修复模式 =「实际入册才计数」最终核对（BeginTransaction finally `if(!_pinned.ContainsKey) Decrement`） | **注意 cap-1 对「损坏」表述的修正（§2.1）**；「计数/登记原子、失败路径回滚计数」通用教训 |
| SQ-16 | PRAGMA 三件套取值（**最有价值**） | 真需 | 池化后多连接并发写同一 .db 文件的直接应对 | `busy_timeout=5000` / `journal_mode=WAL` / `locking_mode=NORMAL`（明确弃 EXCLUSIVE：独占文件到 Exit 阻塞外部工具）× `optimize=0x10002`（数值模式位，空闲自动 analyze）；批量 insert 单条多值 SQL；fsync 分组事务 5-10× 提速；per-group try/catch（错误隔离优先整体原子性） | busy_timeout 逐连接；optimize 数值语义未逐位展开（见无法确定事项） | 取值可直接对照（WAL 已定）；**cap-2 约束 busy_timeout 适用面**；写事务持锁≈单条 SQL 的「短事务」粒度为主线取舍 |
| SQ-17 | `PRAGMA data_version` 观察连接 | 真需 | 写漏斗事件缺位时完备层兜底——检测"他写者"提交 | data_version 是**他写者视角**计数器（本连接读不到自己提交的递增）→ 主库配**专用观察连接**（永不写，惰性创建），dv 快照与 JS 轮询视角一致；写漏斗实时层（C# 表级写计数，事务内累积 COMMIT 后按表发射）与计数器完备层双轨 | dv 快照必须读自非写者连接，否则基线去重滞后一版失效；dv 按文件计数 | 「其他进程改库 → 界面刷新」场景通用；观察连接思路直接平移（bun:sqlite 支持） |
| SQ-18 | C# `_txLock` 全局串行化 + 计数纪律 | 方法 | pinned 事务登记/注销/计时器/Timer 竞态在钩子（线程池回调）与业务执行路径间共享状态 | 所有 TxHolder 状态变更在 `lock(_txLock)`；锁内 happens-before 免 Interlocked；锁外跨路径计数才 Interlocked；UpdatePeak 用 CAS 实现 Interlocked Max | 全局锁串行化不同连接并发执行（单文件 SQLite 写本来就串行可接受） | 单连接同步 API 无边；未来多连接+自建超时器时是模板 |
| **cap-1** | **单连接的并发事务必须串行化（队长复核·实测证实 t2）** | 真需/复核 | 单连接下两个并发异步事务交错 → 撞车 | 实测（bun:sqlite）：B 的 `BEGIN` 抛 `cannot start a transaction within a transaction` → `Promise.all` 整体失败 → **A 永远走不到 COMMIT**，连接被留在打开的事务里（rows 只有 `["A-1"]`）；bun 的**同步** `db.transaction()` 自动用 savepoint 处理重入不撞坑 | **触发条件 = 手动 BEGIN/COMMIT 且中间有 await**；事件驱动异步宿主「并发是常态而非例外」 | 写路径必须有串行化（或保证不同时开两个事务）——**这是需要代码保证的前提，不是自动成立的**；队长先前「SQLite 单连接没有并发问题」判断**被实测推翻** |
| **cap-2** | **busy_timeout 在锁升级场景被完全绕过（队长新增发现）** | 真需/复核 | 先读后写让 deferred 事务从 SHARED 升级写锁，SQLite 不能安全等待（等待会死锁）→ 立即 `SQLITE_BUSY` | 实测三方式（锁被他人持有）：先写（BEGIN→INSERT）等待 **2241ms** 遵守超时；`BEGIN IMMEDIATE` **2227ms** 遵守；**先读后写（BEGIN→SELECT→INSERT）1ms 立即失败** | 只有「先读后写」中招，纯写正常等待；对策三选一：写事务一律 BEGIN IMMEDIATE / 写事务内不先读 / 应用层串行化（与 SQ-9 一致） | **待验证、未定论**——作为设计约束上报；这是 t2 SQ-4「第一道防线」的适用边界修正 |

## C. 迁移机制（t3）

| # | 经验点 | 标签 | 解决什么问题 | 方案（一句话） | 代价 / 陷阱 | 对我们的含义 |
|---|---|---|---|---|---|---|
| MG-1 | .map 声明式 JSON（schema+data 共用格式） | 真需/方法 | 一次升级 = schema 变更 + 数据修复 + 依赖顺序 + 幂等语义四件事，手写 JS 时不可审阅、不可对拍 | schema.map 5 种操作（add_column/create_index/drop_column/rename_table/execute_sql）+ data.map 3 种 fix（delete/update/insert）；params 4 种 source（fixed/subquery/old_db/sql_embed）；`insert` 用 `INSERT OR IGNORE` | 格式校验只做浅层（列名/类型不校验，错误运行时才暴露）；未知 schema 操作只 console.warn 静默跳过（拼错不报错）；`execute_sql` 的 table 字段不展开通配符仅自述 | 格式与运行工具无关可作独立格式吸收 |
| MG-2 | 运行器语义五件套 | 真需/方法 | 迁移「什么先跑、跑哪些表、值从哪来、跑挂怎么办、跑到哪」全链路 | ①版本筛选（开区间 `(current,target]`，目标由调用者携带）；②Kahn 拓扑排序（同版本 schema→data、显式 dependencies、跨版本链式边；**循环依赖硬失败**，`5c040a0b` 从静默回退改硬抛）；③`%` 通配符表名展开（参数化绑定防注入）；④幂等 4 渠道（SQL 自身 + 错误文本匹配跳过 + idempotentColumns 白名单 + 全操作幂等⇒整批重跑）；⑤**检查点与迁移同事务**（COMMIT 前记录，失败版本不前进）；另 engine before/after 限制（不匹配跳过并记检查点 / 反向抛错） | `executeUpdate/Delete/Insert` catch 只 console.error **不抛**（data 修复失败被吞掉但事务继续 COMMIT——与「错误即回滚」相反，等价性测试正是为抓这类差异）；同一版本 schema 与 data 是两个独立事务 | 「每版本独立事务 + 检查点同行 + 全操作幂等」安全组合完全可移植 |
| MG-3 | 旧系统【无降版本回滚】——安全靠三件套 | 事实/真需 | `#27` 验收要求「迁移可执行且可回滚」，需先厘清旧系统真实安全模型 | **没有 down 迁移概念**；安全 = 事务原子性（任何一步抛错整事务回滚，检查点也不落盘）+ 全操作幂等（失败直接重跑即恢复）+ 等价性金样测试；append-only 修补（bug 只能写 vN+1）；调用侧 Math.max(旧版本,目标) 防降级；引擎切换回退靠推送式管道（滚回引擎而非版本） | 「幂等⇒重跑恢复」前提是每个操作真的幂等（c91ceeb9 抓 4 处不幂等才闭环——**幂等是写出来的纪律不是框架保证**）；无 down 迁移 = 上线后 bug 不能撤回 | 我们验收若要求「可回滚」，需自建 down 或快照；三件套是**不引入回滚的最强替代** |
| MG-4 | 等价性测试三层方法论（重点） | 方法 | 重写/声明式化迁移代码时最大风险是行为悄悄变 | preV16Fixture（手写 DDL 建旧形状 schema，两组用户前缀逼 `%_` 通配符 bug）+ migrationEquivalence.test（逐条语义断言 + **金样 dump 逐字节对拍** + 幂等两遍 dump 一致）+ dumpNormalizer（确定性规范化：表/行列排序 + 字面量规范化 + 剥 IF NOT EXISTS）+ memoryAdapter（node:sqlite `:memory:` 跑真实运行器真实 .map）；`WRITE_GOLDEN=1` 仅本地禁 CI；对拍史 c91ceeb9 F1-F4 | 金样是整库快照（任何 fixture 改动连带重生成）；逐条断言按 id 硬编码维护成本线性涨；双保险不是重复（逐条定位差异语义、金样防「每条都对但整体没对」）；对拍前提是旧实现还活着（保留旧分支/开关） | 可平移：迁移器重写 / 换驱动 / 多引擎抽象时的行为保全 |
| MG-5 | `execute_sql` 幂等白名单（可重试 vs 不吞错平衡） | 真需/方法 | 「列重命名+数据回填」一次性操作重跑会 `no such column`；无脑吞错掩盖拼写错误 | `idempotent:true` + `idempotentColumns` 白名单；`isMissingDeclaredColumn` 解析错误文本，**仅当**错误指向白名单内列才跳过，其他照抛（F4 产物：旧代码根本不回填丢数据，新路径保留回填） | 白名单列名写错 → 照常抛安全侧不失效；文本子串匹配跨引擎需逐引擎验证 | bun:sqlite 结构化错误可精确分类替代文本匹配；「白名单化一次性 DDL+数据搬运」与我们列演进同构 |
| MG-6 | `import.meta.glob` 构建耦合（警告） | 事实/警告 | 把 .map 运行时 JSON 资源打进生产 bundle | `import.meta.glob('./*/*.map',{query:'?raw',import:'default'})` + 运行时取 loader → JSON.parse；踩坑史：动态 import+@vite-ignore 不被 Vite 看到 → 404（22df5aa0 修复） | **Vite 编译期特性：bun 语义不同（返回懒加载模块非 raw 字符串）、`?raw` 在 bun 不成立 → 这行不可能原样工作**；路径模式与目录约定强绑定；glob 构建时快照（运行期增改不生效） | bun 下重设计：构建期静态资源目录 + fs 扫描（保留「新版本免注册」），或显式 import JSON；「迁移集在构建期收集」耦合点要重新设计 |
| MG-7 | 对拍式替换完整流程（双实现+开关+观察期+删除） | 方法 | 高风险系统性迁移代码重写可增量上线、可回退、可证明等价 | 引入声明式时保留旧实现 + `USE_NEW_MIGRATION=false` 开关新旧共存 → 等价性测试修 F1-F4 → 生产观察期 → `8e525df8` 删除开关+旧代码（grep 确认无残留；顺手统一 runFixes） | 双路径共存期两套代码都要维护；开关常量是死代码风险（忘删则行为永久停在 false） | 重写既有数据层时（换驱动等）可复用 |
| MG-8 | 跨引擎声明式迁移纪律（engine 限制 + 运行期探测） | 方法 | 同一套 .map 会跑 SQLite/PG/MySQL，跨引擎执行错误 schema 是灾难 | `database.before/after` 限制写在迁移文件而非运行器；引擎探测读运行时 adapter 的 `engineType` getter（防配置快照与实例分叉，Phase 9 任务 9.12 动机）；ENGINE_MIGRATION_GUIDE 记录推送管道（只读源/白名单表/mirror 兜底/行数严格校验/分组事务/bulkInsert('ignore')/500 行分批规避 PG 参数上限） | engine 限制是「.map 作者自律 + 运行时校验」双轨；空串=不限容易漏约束 | 单一 SQLite 期间可简化，将来多引擎直接采用 |
| MG-9 | 事务基础设施工程细节 | 真需/方法 | C# 连接池下事务跨异步调用会断；JS 单线程假设在 await 交错下不成立 | connId 栈 + 串行队列 + 60s 等待超时防 await 后嵌套死锁 + 同步前缀检查；rollback 对已超时/消失 connId 静默 no-op（catch 可无条件调 rollback）；commit 无事务照常抛（调用方 bug 要响）；回滚自身失败不掩盖原始错误；C# 60s idle 超时 + keepAlive 逃生舱（强烈建议交互拆出事务） | 事务内 await 用户交互是最常见坑；嵌套语义两段式（同步段快速失败 + await 后超时兜底）不直观 | bun:sqlite 同步事务下大概率不需串行队列；「检查点与迁移同事务」「回滚失败不掩盖原始错误」沿用 |
| MG-10 | 迁移失败的用户路径与状态机 | 方法 | 启动时迁移是用户等待中的阻塞路径，失败要可见、可重试、不静默 | `databaseUpgradeState`（fromVersion/toVersion/currentTable/rowsCopied）驱动升级对话框；upgradeInPlace 失败 → 弹不可关闭 alert + ShowDevTools；坏备份降级 initAndFixInPlace + warn；调用侧 finally resolveDatabaseInit 放行等待者；版本高于目标（降级场景）只 warn 不阻断 | 失败 UI 直接弹 DevTools 是开发者向取舍 | 「失败=可见状态+可重试+版本不前进」状态机语义可迁移 |

## D. 数据模型（t4）

> ⚠ **权威源声明（队长要求放本节顶部）**：**`docs/architecture/models/` 里没有任何一份是「从代码生成的权威」schema。唯一权威源是 `adapter/{SQLite,MySQL,PgSQL}Adapter.js` 的 `initUserSchema` SQL 字符串**，`docs/models` 是对它的逆向描述。下面任何 ERD/DDL 都不可直接当作可用的 schema。

| # | 经验点 | 标签 | 解决什么问题 | 方案（一句话） | 代价 / 陷阱 | 对我们的含义 |
|---|---|---|---|---|---|---|
| DM-1 | 多账号隔离不靠数据库实例，靠表名前缀 | 真需 | 一个 SQLite 文件支持多账号各自独立的好友/笔记/feed/互斥图 | `userTable(prefix,name)=${prefix}_${name}`；prefix 由 userId 去分隔符计算（数字开头加 `_`）；`initUserSchema(prefix)` 批量建表；切换账号热替换 `dbVars.userPrefix` | SQL 全动态拼表名（注入面变大）；跨账号聚合要 UNION 多套前缀表；`dbVars.userPrefix` 全局可变状态必须自持 prefix 传入否则写错库 | 每机单数据引擎无多账号诉求，但「用户 ID 派生键 + 动态表名」是可参考隔离形态 |
| DM-2 | 实体层三层建模各自独立演进（MCD 概念/SR 逻辑/DDL 物理） | 方法 | 同一模型给不同受众（设计讨论/实现/图）可用文档 | Mocodo 单源（.mcd→DDL+MLD+ERD）+ 手写 dbml + mermaid 衍生物；SR 把 MCD 关联实体折叠成内嵌外键列 | **文档与实现脱节极快**：SR DDL 漏 mutual_graph_friends、dbml 缺 3 实体表、Mocodo DDL 类型全 VARCHAR(42) 占位、mmd 关系错向；无任何一份是从代码生成 | 我们若做模型文档，用「建表代码 + 手写 ERD 对账脚本」保持单一事实源 |
| DM-3 | 关系不靠外键约束，靠列名约定 + 字符串 ID 软关联 | 真需 | SQLite 物理库零 FK 强制，跨表查询直接拼 SQL | 实体以 VRC 用户/世界/头像 ID 字符串为 PK；关联=列名约定（user_id/world_id/avatar_id）；部分按 location 字符串关联 | 脏数据/孤儿行无 DB 层拦截；无 FK ⇒ 删用户不级联只能应用层清理；location 字符串关联脆弱（格式变更断链） | bun:sqlite 同样面临 FK 取舍；可主动 `PRAGMA foreign_keys` + 显式索引（主动选择而非继承） |
| DM-4 | 「加法演进」替代破坏性迁移——`_V2_`/`_OLD_` 命名即版本档案 | 真需 | 通知格式升级、活动统计重构、互斥图加时间维度不打断存量数据 | 新表+版本后缀并存；client 按需读新旧两表；push/pull 同步并列新旧表 | 表数量膨胀（42 张有 5 张版本并存）；新旧表维护两份写路径；不做数据搬迁旧表永远留存 | schema v1 无存量包袱；但「schema_version 元数据 + 兼容列演进 vs 新表并存」权衡值得预设策略（尤其插件生态出现后） |
| DM-5 | 统计类「会话窗口 + 预计算 bucket + 增量游标」三件套 | 真需/方法 | 热力图/时长统计在大时间跨度反复读原生事件表太贵 | ①ACTIVITY_SYNC_STATE 记增量游标（source_last_created_at + pending_session_start_at + is_self 分叉自己/好友来源）只拉新增；②ACTIVITY_SESSION 拼合会话窗口（start/end/is_open_tail + source_revision 防代际污染；整表重建或按点追加）；③ACTIVITY_BUCKET_CACHE 复合主键 (user,target,range,view,exclude) 预计算 + `bucket_version` 做结构失效（改算法只 bump 版本） | 复合缓存键行数膨胀；游标与缓存对账需 built_from_cursor；open tail（未闭合会话）易算错；重建/追加两套事务路径并发边界要小心 | 时长统计的「原始事件→会话→预聚合缓存」分层与游标设计可直接借鉴；聚合层可用 SQL 视图/物化替代 JSON bucket |
| DM-6 | Feed 事件表统一「previous_* 冗余字段」模式 | 方法 | 展示「谁把 X 改成 Y」要拿到变更前后两值，且 feed 行不可变（历史流） | 每张 FEED_* 表存快照对（status/previous_status、bio/previous_bio、location/previous_location…）；`time` 记上一状态持续毫秒（FEED_GPS.time=在 previous_location 停留时长） | 冗余存储；同一事件多字段变化需拆多条或只记一对；previous_* 更新时机要精确（先读后写） | 事件溯源式设计里可由上一条事件推导而非冗余存储，但查询廉价 vs 存储廉价可权衡 |
| DM-7 | 缓存表 = 实体表（以 id 直接作对象 ID） | 真需 | VRC API 返回的世界/头像对象要离线/快速展示 | CACHE_WORLD/CACHE_AVATAR 直接以 VRC ID 作 PK 存 author/name/图片/release_status/version；收藏、memo、tag 引用 cache 的 id | 缓存与真实对象可能过期（updated_at 有但无 TTL 策略）；author_id 不含 relation 到 USER（作者非好友就不在 USER 表）——实体关系网断裂 | 要决定「VRC 对象单实体表复用」而非复制两份（cache+entity），后者正是前人的扩展点 |
| DM-8 | pub 表与 pri 表可互相引用——分级不是硬壳 | 真需 | 收藏好友（pub 共享）必须引用每账号的好友实体（pri） | 跨分级引用用列名约定（FAVORITE_FRIEND.user_id_ref→USER、MEMO.user_id_ref2→USER、GAMELOG_LOCATION.world_id→WORLD） | pub/pri 命名易被误读为「隐私级别」，实际是「账号隔离级别」（为什么 gamelog 是 pub 而 feed 是 pri 无注释）；层级语义不清 | 我们设计应把「隔离维度（account/global）」与「隐私维度」分开命名，避免一次命名承担两语义 |
| DM-9 | 模型文档「手工+生成」混合链及其实测漂移 | 方法 | 给设计评审与实现同时交付图、文档、DDL | Mocodo 4.3.3 出 MCD/SR 全链；dbml 手工维护最富语义；mermaid/svg 从 dbml 派生 | **实测三份对不上**：SR=42 表、dbml=40 表（缺 USER/AVATAR/WORLD 实体）、mmd=39 表（再缺 MANUAL_RELATIONS_MANUEL）、MCD=54（多 13 关联表）；mmd 通知关系错向；Mocodo DDL 类型全 VARCHAR(42) —— **此类产物只能当「实体清单 + 关系意图」参考，不能当 schema 权威** | 模型文档应以可执行 schema 为源（如单文件 schema.ts + 生成 ERD + 对账测试） |

### D.1 数据模型：42 张表领域分布（SR 逻辑模型视角）

> `(pri)` = `{userPrefix}_表名`（每账号一份）；`(pub)` = `表名`（全局共享）。表名手写规范大小写，DB 实际为小写下划线。

| 领域 | 表（SR） | 计数 |
|---|---|---|
| A 账户/凭证 | `USER_pri_`、`COOKIES_pub_`、`CONFIGS_pub_`、`MODERATION_pri_` | 4 |
| B 好友与社交 | `FRIEND_LOG_CURRENT_pri_`、`FRIEND_LOG_HISTORY_pri_`、`TRACKED_NONFRIENDS_pri_`、`MANUAL_RELATIONS_MANUEL_pri_`（拼写 MANUEL 为真实痕迹）、`MUTUAL_GRAPH_FRIENDS/LINKS/META_pri_`、`MUTUAL_GRAPH_FRIENDS/LINKS_OLD_pri_`（PR#21 新增） | 8 |
| C Feed | `FEED_AVATAR/BIO/GPS/ONLINE_OFFLINE/STATUS_pri_`（全带 previous_* + time 毫秒） | 5 |
| D 游戏日志 | `GAMELOG_LOCATION/JOIN_LEAVE/PORTAL_SPAWN/VIDEO_PLAY/RESOURCE_LOAD/EVENT/EXTERNAL_pub_` | 7 |
| E 通知 | `NOTIFICATION_pri_`（旧格式）、`NOTIFICATIONS_V2_pri_`（新格式，并存非迁移） | 2 |
| F 收藏 | `FAVORITE_WORLD/AVATAR/FRIEND_pub_` | 3 |
| G 备注/标签 | `MEMO_pub_`、`NOTES_pri_`、`WORLD_MEMO_pub_`、`AVATAR_MEMO_pub_`、`AVATAR_TAG_pub_` | 5 |
| H 缓存 | `CACHE_AVATAR_pub_`、`CACHE_WORLD_pub_`、`AVATAR_HISTORY_pri_` | 3 |
| I 活动/在线时长 | `ACTIVITY_SYNC_STATE_V2_pri_`、`ACTIVITY_SESSION_V2_pri_`、`ACTIVITY_BUCKET_CACHE_V2_pri_` | 3 |
| J VRC 对象实体 | `AVATAR_pub_`、`WORLD_pub_` | 2 |
| **合计** | | **42 ✓** |

### D.2 ERD/文档规模与可用性（三份互相漂移，均非权威）

| 文件 | 规模 | 可用性 | 关键差异 |
|---|---|---|---|
| `vrcx_erd.dbml` | 40 表（22 pri + 18 pub）/ 23 Ref | ✅ **唯一可直接导入工具**（dbdiagram.io/dbdocs），带字段级语义注释，**信息量最大、最适合作参照起点** | 缺 USER/AVATAR/WORLD 3 张实体表（数据由 CACHE_* 承载——「缓存吸收实体」） |
| `vrcx_erd.mmd` | 39 表 / 24 rel | ✅ 可直接粘贴进支持 mermaid 的编辑器（GitHub/Typora） | 无 USER/AVATAR/WORLD、无 pri_manual_relations_MANUEL；notification sender/receiver 两条画成同向（生成瑕疵） |
| Mocodo 产线（sr/mcd） | SR DDL 42 表 / MCD DDL 54 表（41 实体+13 关联，41 FK） | ❌ **DDL 完全不可用**：表名带 `_pri_`/`_pub_` 后缀，**列类型全是 VARCHAR(42) 占位**；物理 DDL 真源在 adapter 的 initUserSchema | MCD 把「事件由谁产生」建模成独立关联表（HAS_AVATAR/HAS_BIO/…/RELATED/TRACKED_BY/TAGGED/FAV_FRIEND_OF…），SR 折叠回内嵌 user_id 列——两个抽象层级并存 |

### D.3 跨表关系要点（引用 t4 §4）

- **好友中心**：`pri_friend_log_current.user_id` 作枢纽 10 条 Ref（friend_log_history / feed 五表 / moderation / notes / activity 两表 / notifications sender+receiver）。
- **互斥图**：4 条（friends ↔ links × 2 组新旧）；游戏日志 1 条按 location 字符串关联（非 ID）。
- **缓存→收藏/备注/日志 5 条**（`pub_cache_world.id→favorite_world/world_memos/gamelog_location.world_id`（注释 "loose reference, no FK enforcement in SQLite"）、`pub_cache_avatar.id→favorite_avatar/avatar_memos/avatar_tags`）。
- **物理层**：SQLite 零 FK 强制；所有关联以 user_id 字符串或 location 字符串为纽带，不是自增整数外键。GAMELOG_* 多数不挂 USER（LOG/EXTERNAL 只是「出现在我实例中的他人」）。
- **活动模型三表**（DM-5 详述）：sync_state（增量游标 + is_self + pending_session_start_at）→ session（会话窗口，is_open_tail）→ bucket_cache（复合键预计算，bucket_version 失效）。

## E. 血统台账（t5 + 队长核验 cap-3）

> t5 产出 `05-provenance.md` 只上报事实、不做可用性判断；cap-3 为队长独立复算，结论**完全一致**并新增一条事实。本总表同样不明着替用户裁定「可不可以复制」。

| # | 事实 | 来源 | 证据强度 |
|---|---|---|---|
| PV-1 | `old/main` = 2019-08-16 pypy 根提交的 **4526-commit fork 链**（VRCX 官方 → VRCX-Luo → VRCX-jirai → 本 org），85 个 merge commit；merge-base(old/main, VRCX-jirai/master) = **jirai tip `c8b8f744`**（2026-05-20 "Update version from 2026.4.21 to 2026.5.20"） | t5 + **cap-3 独立复算一致** | 事实（双源印证 ✅） |
| PV-2 | `old/main` 388 个 commit 不在 jirai 上游可达范围 = org 在 2026-05-20 上游快照之上的自加增量；XChen446 的 **203 个提交全部在其中**（0 个继承自上游） | t5 | 事实 |
| PV-3 | 数据库目录 org 期工作（2026-06-23 起 `c6aac869`）与最后一批上游作者提交（2026-04-20 FuLu糖福禄 "typo"）**无交叠**；`pa`(981)/`FuLu糖福禄`(100)/`copilot-swe-agent[bot]`(90)/`Natsumi`(2011) 在数据库文件的提交全部在祖先链内，**不是本 org 的 merge 动作**（上游 fork 在 2026-05-20 前已并入 old/main） | t5 | 事实 |
| PV-4 | **「全 org」文件数：t5 数 ~30，cap-3 独立逐文件复算 = 34 个**（52 个文件中从未出现非 org 作者提交者 34 个；被上游作者碰过 18 个——前几个：gameLog.test.js、activityV2.js、avatarFavorites.js、avatarTags.js、feed.js、friendFavorites.js、friendLogCurrent.js、friendLogHistory.js、gameLog.js、index.js、manualRelations.js、memos.js） | t5 + **cap-3 复算** | 事实（数量口径微差：~30 vs 34，队长复算为准；均不推翻结论） |
| PV-5 | copy-ready **候选**清单（cp 判定准则：①路径内全部提交作者 ∈ org 候选 {XChen446, RainyN0077, 1zyao, mobaiQWQ}；②无上游 fork 作者提交；③无 FuLu 系 "Merge upstream/master"；④`--follow` 溯源链最老节点也是 org 作者）：adapter/ 三引擎 + adapter/index.js + 全部 adapter 测试 + migrations/ 全族（index.js/migrations.js/_template.map/16 两份 .map/全部测试）+ pullEngine/pushEngine 及测试 + feed.test/configRepository.test —— **≈30+ 个文件**（t5 与 cap-3 数字口径见 PV-4） | t5 | **候选非结论**（可用性判断归 captain/用户） |
| PV-6 | 例外（不满足④）：`configRepository.js` 路径内全 org 但 `--follow` 最老节点 = **2020-11-02 pypy**（rename 上游文件继续改，R100/R098/R096）；`SQLiteAdapter.js` 44 follow 提交全 org 但**inline 自曾含上游作者提交的 `sqlite.js`**（`ff152992` pa rename / `4337bd57` copilot / `dfa91e8d` yixijun）——是否「完全 org 原创」**git 证据只给到渊源，不裁定** | t5 | 事实（所有权判断不裁定） |
| PV-7 | org 作者候选名单：**确定** = XChen446（203 提交全 org 增量；rewrite 78 提交）、CenFangyu=Dmao233（**事实**：GitHub id 对应，rewrite 3 提交 M1 PR1-3）；**推测** = RainyN0077（org 期数据库重构主力）、1zyao（rewrite 8 提交带 #27/#30/#35/#36）、mobaiQWQ（创建 .map 迁移系统；与上游 fork 名 MiaobaiQWQ 重合，归属不明）；rewrite 分支活跃作者 = XChen446/1zyao/Dmao233（**无 RainyN0077/mobaiQWQ**） | t5 | 事实+推测（成员身份需用户确认） |
| PV-8 | org 自己做过 15 个 merge 提交（`0eeb3150` Merge(database-refactor)、`3045e486` Merge(master): 同步上游 v2026.07.18）——主题含「同步上游」但作者是 org，**不计**为「上游 merge 痕迹」；merge 冲突解决时可能手工并入上游快照（逐文件无法纯靠 git log 拆分，行级需 blame+merge 差异分析） | t5 | 事实（边界明确） |
| **cap-3-a** | **`old/main` 与 `rewrite` 分支没有共同祖先**（`git merge-base --all origin/old/main origin/rewrite` 退出码 1，无输出）⇒ `rewrite` 是**全新起点的重写**，与旧工程历史不相连 | **cap-3（队长核验新增）** | 事实（队长独立脚本） |
| **cap-3-b** | **cap-3-a 的含义**：`git cherry-pick` / `git merge` 不会自然而然地搬运任何东西；从 old/main 取用**必然是显式复制文件内容**——而显式复制正是需要血统证明的那个动作；取用行为本身**可审计、无法意外发生** | **cap-3（队长新增事实）** | 判断（基于事实） |
| PV-9 | 上游作者集合（cap-3 给出完整名单）：pa / FuLu糖福禄 / FuLuTang / copilot-swe-agent[bot] / Natsumi / yixijun / pypy / Teacup | cap-3 | 事实（队长复算） |

---

# 第二部分：交叉印证（最有价值的部分）

## 2.1 核心冲突：t2「损坏连接」 vs 队长实测「可回滚恢复」——结论一致、严重程度不同，**原文并列，不调和**

| 维度 | t2 原始表述（SQ-9/SQ-15） | 队长复核实测（cap-1，bun:sqlite） | 印证 |
|---|---|---|---|
| 单连接 + 并发异步事务是否真问题 | **是**：两事务并存打到同一连接会**损坏连接** | **是**：第二个 `BEGIN` 抛 `cannot start a transaction within a transaction`；第一个**永远走不到 COMMIT** | ✅ **结论一致** |
| 「损坏」的具体表现 | 表述为「连接损坏」（C# 桥侧语境：SQL 全部打到同一 pinned 连接） | **连接被留在打开的事务里（可回滚恢复）**；未见永久性损坏（实测回滚后可继续写） | ⚠️ **严重程度差异：可回滚恢复 vs 永久损坏** —— 队长结论针对 bun:sqlite；t2 表述可能源自旧实现的 C# 桥层；**是否适用于本项目未定论** |
| 是否必须串行化 | `_txTail` 归属 **[SQLite 真实需要]** | 写路径必须有串行化（或保证不同时开两个事务） | ✅ 一致 |
| 触发前提 | 异步交错（await 让出事件循环后另一流进来） | **精确化：手动 BEGIN/COMMIT 且中间有 await**；bun 同步 `db.transaction()` 自动 savepoint 处理重入，正常用不撞坑 | ✅ cap 补全了前提边界 |

> **队长指令的落实说明**：这是同一结论（并发是真问题）的两种严重程度表述。队长要求「差异要写出来，不要私自调和」——本总表按字面并列：t2 说「损坏」，cap-1 实测「可回滚恢复」，并注明队长结论是否适用于 bun:sqlite 直连方案**未定论**（06 §5.2：可能与旧实现 C# 桥层有关；cap-1 的 06 文档明确写「t2 说的『损坏连接』具体是什么表现——本次实测表现为『连接留在打开的事务里』（可回滚恢复），未见永久性损坏」）。

## 2.2 交叉印证：cap-2（busy_timeout 锁升级绕过） vs t2 SQ-4/SQ-14

- **t2 SQ-4 把 busy_timeout=5000 列为「第一道防线」**；**cap-2 实测证明这道防线在「同一事务内先 SELECT 再写」下完全失效**（1ms 失败 vs 2241ms 等待）→ **cap-2 是 SQ-4 的适用边界修正**，不是矛盾：纯写事务/`BEGIN IMMEDIATE` 下 busy_timeout 有效。
- **t2 SQ-14 的并发写测试用 `BEGIN IMMEDIATE` 循环**——这其实是旧实现**规避锁升级的隐含实践**；cap-2 补上了理论解释（deferred 事务升级锁不能安全等待）。
- **结论**：采纳 busy_timeout=5000 时必须同时采纳「写事务 `BEGIN IMMEDIATE`」或「事务内不先读」或「应用层串行化」，否则配置形同虚设。这与 SQ-14 模板自洽。

## 2.3 交叉印证：t1 IF-5 «大概率不需要串行队列» vs cap-1 «写路径必须有串行化»

- **t1 IF-5** 结论：「我们是 TS + bun:sqlite（单连接，事务语义由 SQLite 自身保证），栈式上下文与串行队列**大概率不需要**」——前提是「事务语义由 SQLite 保证」。
- **cap-1** 实测给出精确边界：在使用**同步事务 API**（bun `db.transaction()`，自动 savepoint）且不同时手写两个 BEGIN 的前提下，t1 成立；在手写 BEGIN/COMMIT + await 交错下**不成立**。
- **不矛盾，是同一结论的两个面**：t1 的「大概率不需要『串行队列』」与 cap-1 的「写路径必须有串行化」之间的桥梁是——**串行化的需求被「同步事务 API」这个选择吸收，而不是消失了**。若未来手写 BEGIN（如事务内需要 await），串行队列就是那个必须补的件。

## 2.4 交叉印证：60s 一致性（t1/t2/t3 三方独立产出同值对齐——强印证）

- **t1 IF-5**：「事务超时上限与事务等待超时必须对齐（等待超时 60s ≥ C# idle 60s），否则排队调用被误判死锁」
- **t2 SQ-10**：「默认 60000ms 刻意对齐 C# `TX_IDLE_MS=60000`：前序事务可经 keepAlive 合法存活至 60s，等待超时必须 ≥ 该上限」
- **t3 MG-9**：「配 60s 等待超时防 await 后嵌套死锁」
- 三份独立产出从三个文件（EngineAdapter.js / SQLite.cs / migrations）对「60s = 等待超时对齐事务最大存活」给出**同一解释** → 跨成员独立核实的一致，可信度高。

## 2.5 交叉印证：复杂度归属趋同（t1/t2/t3 独立得出同一分层）

- t1 IF-5：「为 PG 池化的复杂度而生」；t2 SQ-7~SQ-12 归属矩阵（PG 衍生 / SQLite 真实需要 / 防御）；t3 MG-9：「bun:sqlite 事务是同步的、无连接池与 idle 超时，串行队列 + keepAlive 大概率不需要」。
- **结论**：三个成员从三个文件独立得出同一分层：「池化/桥层复杂度不可移植，仅留方法论；SQLite 文件级实践（PRAGMA/短事务）可平移；防御层按需」。

## 2.6 交叉印证：data_version 观察连接（t1 IF-2 vs t2 SQ-17 —— 独立描述同一机制）

- t1（onTableChange 完备层）与 t2（SQ-17）从不同文件（EngineAdapter.js / SQLite.cs）独立描述了「data_version 是他写者视角、观察连接永不写、dv 快照必须读自非写者连接否则基线去重失效」→ 一致。这同时是 t2 唯一被 t1 从接口侧印证的具体机制。

## 2.7 交叉印证：t5 血统 vs 各勘察的提交证据（来源归因彼此印证）

| 勘察引用 | t5 台账对应 | 印证 |
|---|---|---|
| t1 IF-1 两次破例提交（`26ee17fa`/`c08c62e1`/`9429cca8`） | t5 §5.1 EngineAdapter 时间线（07-25 事务重构、07-26 健康检查破例，作者 XChen446/RainyN0077）→ 全 org 候选 | ✅ **接口冻结纪律是本 org 自建**，无上游贡献（可借鉴则风险低） |
| t2 #27 修复链（`b5486313`/`1566485e`/`f00fb9a2`/`005791d3`） | t5 时间线（08-18/19 1zyao） | ✅ 并发串行化是 org 重写期修复 |
| t3 迁移系统三提交（`677dd653` mobaiQWQ / `c91ceeb9` RainyN0077 / `8e525df8` 删旧） | t5 copy-ready 全绿（migrations/ 目录全 org） | ✅ .map 声明式系统是 org 原创，格式借鉴风险低 |
| t4 §8 models 目录同一提交 `d10b0cc0` 落地 | t5 仓库转移收尾提交 | ✅ 模型文件与 database 目录同批迁移 |

## 2.8 交叉印证：cap-3 vs t5（队长独立核验——完全一致 + 一条新事实）

- **数量口径**：t5 说「~30 个 copy-ready 文件」，cap-3 独立逐文件复算**34 个**「从未出现非 org 作者」文件、**18 个**被上游触碰（t5 的 18 一致）→ 数字微差（~30 vs 34）源于统计口径（t5 用 follow 溯源判定的候选清单 vs cap-3 用「历史从未出现非 org 作者」直接判定），**结论不冲突**；以队长复算 34/18 为精确口径。
- **cap-3-a（无共同祖先）是 t5 未提及的新事实**，且比「哪些文件纯 org」更根本：它说明取用行为本身是显式的、可审计的、无法意外发生的（`rewrite` 全新起点，无祖先 ⇒ 无自然搬运）。
- t5 的「merge-base = jirai tip」断言经 cap-3 独立复算**完全一致**。

## 2.9 单一来源、未经印证的事项（透明列出）

- **IF-2 onTableChange 的 PG trigger/NOTIFY 原生推送细节**：仅 ADAPTER_API.md §9.7 叙述，未核 C# PostgreSQL.cs（t1 无法确定事项 5）。
- **DM 的表数差异精确归因**（dbml 为何省略 USER/AVATAR/WORLD 实体——刻意「缓存吸收实体」还是遗漏）：无代码注释，单一来源（t4 无法确定事项 1）。
- **GAMELOG_LOCATION 为何 pub**、**COOKIES_pub_ 共享语义**、**MANUAL_RELATIONS_MANUEL 拼写**：t4 无法确定事项 2/3/5，均无代码注释。
- **SQ-16 optimize=0x10002 的确切语义**（数值模式位未逐位展开）；**Max Pool Size 16 vs 100 不一致**（测试 TODO 文本 vs 主连接串）：t2 无法确定事项 1/5。
- **MG-4 WRITE_GOLDEN 的 CI 防线**：t3 无法确定事项 6。
- **cap-1 三条未定论**：BEGIN IMMEDIATE 在真实异步/多进程竞争下是否确实更优；t2「损坏连接」定性；与 t2 §并发写测试（node:sqlite worker_threads）未交叉验证。

---

# 第三部分：按主题重组（跨产出）

## 主题一：接口 / 契约设计（IF-1/3/4/6/7，DM-2/9 对照）

- 旧实现最大经验 = **「D1 业务零改动」不变量 + 冻结/破例纪律**（IF-1/IF-4）：接口被业务真实需求「吸」大，不是设计期预判；引擎特有扩展不入基类走能力检测。
- **对我们**：TS 编译期强制替代 JSDoc 人肉纪律；「契约一份/教程一份/流程一份」分层的文档治理可借鉴（IF-7）；引擎注册的「4 注册点 + 惰性字面量路径」清单化启示（IF-6）。
- **对照 DM-2/DM-9**：接口文档（42+3 vs 47+5 分叉）与模型文档（42/40/39/54 漂移）暴露同一个病——**靠人肉同步的派生文档必然滞后于代码**；旧工程两处都犯了，我们的对策是「可执行代码为源 + 对账测试/契约测试断言」。

## 主题二：SQLite 具体实践（SQ-4/5/14/16/17，cap-1/cap-2，IF-2 完备层）

**PRAGMA 取值（最有价值、可直接对照）**：`busy_timeout=5000` / `journal_mode=WAL` / `locking_mode=NORMAL`（弃 EXCLUSIVE）/ `optimize=0x10002`；重试 5 次/50ms 起/2 倍/2s 顶/±25% jitter/仅 Busy+Locked。

**但 cap-2 给定边界**：busy_timeout 只在非锁升级路径生效；**写事务用 BEGIN IMMEDIATE 或事务内不先读或串行化**。

**并发事务（cap-1 为核心）**：
- 单连接 + 手动 BEGIN/COMMIT + await = 撞车（第二个 BEGIN 抛错、第一个永不 COMMIT、连接留事务里）→ **写路径必须串行化**；
- bun 同步 `db.transaction()` 自动 savepoint = 第一道天然防线；
- 若需手写事务，串行队列（SQ-9 形态）是把竞态变排队的现成思路；
- data_version 观察连接（SQ-17/IF-2）：「他写者视角」检测外部提交，观察连接永不写——bun:sqlite 支持。

## 主题三：迁移方法论（MG-1~10，DM-4 对照）

- **安全模型**：旧系统无 down 迁移；靠「事务 + 检查点同行 + 全操作幂等 + 等价性金样」三件套（MG-2/MG-3/MG-4）⇒ 我们若要「可回滚」需自建 down/快照，三件套是不引入回滚的最强替代。
- **等价性测试三层方法论**（MG-4）：逐条语义断言 + 金样 dump 对拍 + 幂等重复；配 dumpNormalizer/preV16Fixture/memoryAdapter；WRITE_GOLDEN 禁 CI——可平移用于迁移器重写/换驱动。
- **对拍式替换流程**（MG-7）：双实现 + 开关 + 观察期 + 删除。
- **加法演进**（DM-4）：旧工程对结构演进的默认反应是新表并存（`_V2_`/`_OLD_` 后缀即版本档案），与迁移系统的「版本化 + append-only 修补」互为表里。
- **bun 注意**（MG-6）：`import.meta.glob ?raw` 是 Vite 专用，bun 必须重设计迁移资源收集。

## 主题四：数据模型与领域划分（DM-1~9）

- 42 表 /**10 领域**（见 §D.1）：账户凭证 / 好友社交 / Feed / 游戏日志 / 通知 / 收藏 / 备注标签 / 缓存 / 活动统计 / 对象实体。
- **权威源是 adapter 的 `initUserSchema` SQL**；`docs/models` 是逆向描述，SR=42/dbml=40/mmd=39/MCD=54 互相漂移，**不可直接当 schema**；dbml 是唯一可导入工具的参照起点。
- 命名约定即语义：`_pri_`=账号隔离（userPrefix 前缀）、`_pub_`=全局共享、`_V2_`=结构并存、`_OLD_`=带日期的功能补充（非废弃）。
- 悬空引用/断链（DM-3/DM-8）：「无 FK ⇒ 删用户不级联」「pub 引用 pri」「gamelog pub 挂 world_id 无 WORLD 行」——旧实现接受这些，是因为它们是**软关联应用层清理**的设计选择；我们可主动 FK+索引，但那是主动选择。

## 主题五：血统与可复制性（PV-1~9 + cap-3）

- **链**：VRCX 官方(MIT) → VRCX-Luo(pa/copilot/Natsumi) → VRCX-jirai(FuLu糖福禄) → 本 org（2026-05-20 上游快照之上自加 388 commit）。
- **34 个「全 org」文件 / 18 个被上游触碰**（cap-3 精确口径）；copy-ready **候选**清单见 §E PV-5（**候选非结论**，需用户对照本 org 成员名单裁定）。
- **cap-3 根本事实**：old/main 与 rewrite **无共同祖先** → 取用 = 显式复制 = 可审计、需血统证明。
- **注意**：license 红线（VRCX 官方 MIT 可借鉴、vrcx-0 GPL 禁抄）在 AGENTS.md 已有；本总表不重复裁定，只并列事实。

---

# 第四部分：血统摘要（copy-ready 候选清单原样转出）

> 来源：`05-provenance.md` §4（t5 独立产出）+ cap-3 复算。**判定准则四项**（t5 原文）：①路径内全部提交作者 ∈ org 候选 {XChen446, RainyN0077, 1zyao, mobaiQWQ}；②路径内无任何上游 fork 作者提交；③无 FuLu 系 "Merge upstream/master" 痕迹；④`--follow` 溯源链最老节点也是 org 作者。
> **cap-3 精确口径**：52 个数据库文件中 34 个「从未出现非 org 作者」，18 个被上游触碰（名单见 PV-4）。

**全绿（满足 1-4）约 30+ 个文件（t5 口径）**，按目录分组：

- **adapter/ 三引擎 + 入口**：`EngineAdapter.js`（37 follow 提交全 org，add=2026-07-10 XChen446）、`MySQLAdapter.js`（37 全 org）、`PgSQLAdapter.js`（20 全 org）、`SQLiteAdapter.js`（44 follow 全 org，inline 自 XChen446 自己的 `sqlite.js`；**但 sqlite.js 上游血统见 PV-6 ⚠**）、`adapter/index.js`（13 全 org）。
- **adapter 测试**：`index.test.js`、`__tests__/SQLiteAdapter.test.js`、`transaction.test.js`、`connectionStringRouting.test.js`、`changeNotification.test.js`、`SQLiteConcurrentWrite.test.js`、`adapterContract.test.js`、`MySQLAdapter.unit/mysql.test.js`、`PgSQLAdapter.unit/pgsql.test.js`。
- **migrations/ 全族**：`index.js`（19 follow 全 org，add=2026-06-27 mobaiQWQ）、`migrations.js`、`_template.map`、`16/data.map`、`16/schema.map`、`__tests__/memoryAdapter.js`、`migrationEquivalence.test.js`、`migrationTransactionProtection.test.js`、`dumpNormalizer.js`、`preV16Fixture.js`、`__tests__/__fixtures__/v16-expected.dump`。
- **引擎/业务**：`pullEngine.js`（16 follow 全 org）、`pushEngine.js`（22 follow 全 org）、`pullEngine.test.js`、`pushEngine.test.js`、`__tests__/feed.test.js`、`__tests__/configRepository.test.js`。

**例外（需人为判断，t5 已标注）**：
- `configRepository.js`：路径内全 org 无 merge 痕迹，但 `--follow` 最老节点 = **2020-11-02 pypy**（R100/R098/R096 rename 链）→「rename 上游文件继续改」情形，是否 copy-ready 不裁定。
- `SQLiteAdapter.js`：44 follow 提交全 org，但 inline 源 `sqlite.js` 在 2026-03-10 前有上游作者提交（pa rename / copilot / yixijun）——XChen446 07-16 inline 时已由 org 重写过，**最终内容 = org 层 + 旧 sqlite.js 血统** → 是否完全 org 原创属判断事项。
- 上游污染文件 18 个（不满足 2/3）：feed.js / gameLog.js / index.js / mutualGraph.js / manualRelations.js / trackedNonFriends.js / avatarFavorites.js / activityV2.js / avatarTags.js / friendFavorites.js / friendLogCurrent.js / friendLogHistory.js / memos.js / moderation.js / notifications.js / tableSize.js / worldFavorites.js / `__tests__/gameLog.test.js`（t5 §1 全表）。

> **这份清单是「候选」，不是「结论」**。判定「哪些文件确实属于本 org 可放心借鉴」**需要用户对照本 org 成员名单裁定**（RainyN0077/mobaiQWQ 是否组织成员、mobaiQWQ 与 MiaobaiQWQ 是否同一人、pa 是否有 org 别名等，均无法从 git 确定）。

---

# 第五部分：给用户的待决问题（必须由用户拍板，汇总者不代答）

## A. 血统 / 可复制性（最高优先，cap-3 说这是最根本的）

1. **less-org 成员名单确认**：RainyN0077、1zyao、mobaiQWQ 是否确属 VRChatCN-Kipfel 组织？（t5 只能给「推测」；rewrite 分支只有 XChen446/1zyao/Dmao233 出现）——这直接决定 PV-5 候选清单里哪些可以放心借鉴。
2. **mobaiQWQ 与 MiaobaiQWQ（VRCX-onkel fork 主）是否同一人**？影响 `.map` 迁移系统（我们最可能借鉴的格式）的所有权判断。
3. **`configRepository.js` 与 `SQLiteAdapter.js` 的 inline/rename 上游血统**：是否接受「org 重写后所有权转移」的解释？不接受则这两文件降级为「观察参照」。
4. **从 old/main 取用的动作授权**：cap-3 确认无共同祖先 ⇒ 任何取用都是显式复制 ⇒ **建议用户明确给出「哪些主题允许显式复制」的授权边界**（接口形状？PRAGMA 取值？.map 格式？schema 结构？），复制时按文件做血统留痕。

## B. SQLite 并发 / 事务策略（cap-1/cap-2 相关性最高）

5. **写路径是否接受「bun 同步事务 API 为第一道防线」**（即所有事务用 `db.transaction()`，禁止手写 BEGIN/COMMIT）？还是需要保留手写事务能力（如事务内 await）→ 若保留，是否立项实现串行队列？
6. **cap-2 三对策选哪个**：写事务一律 `BEGIN IMMEDIATE` / 写事务内不先读 / 应用层串行化？（cap-1 的反证：旧实现并发写测试用 BEGIN IMMEDIATE；cap-2 建议优先验证 BEGIN IMMEDIATE 在真实异步竞争下是否显著优于 deferred）
7. **是否需要 busy_timeout=5000 的原值**？若我们单连接 + 串行化，多写者场景基本不存在，数值是否照抄取决于「宿主是否会有多进程/多 Database 实例写同一文件」（如将来插件直接写库）。

## C. 迁移机制

8. **「可回滚」验收红线**：采纳旧三件套（事务+幂等重试+等价性金样，无 down 迁移）作为等价解读？还是必须自建 down-migration / 快照方案？（MG-3 直接相关）
9. **schema 演进策略**：采纳「加法演进（新表并存 + 版本后缀）」还是「版本化迁移 + ALTER」？（DM-4 与 MG 系列的交点）

## D. 数据模型

10. **schema v1 是否直接沿用旧 42 表模型**？还是按领域裁剪（如跳过 MOT 互斥图/gamelog 防火墙追踪等 VRCX 特有功能）？（t4 产出实体清单 + 关系意图，未评判取舍）
11. **ERD 方式**：以 dbml（40 表）为参照起点 + 「schema.ts 可执行源 + 对账脚本」？还是别的？（DM-9）
12. **FK 策略**：SQLite 物理库旧实现零 FK；我们是否主动 `PRAGMA foreign_keys` + 显式索引？（DM-3，需拍板因为这是主动选择）

## E. 接口/契约

13. **可替换 storage 服务契约的宽度**：不照搬 47 方法；但「逃生口 + 能力检测 + 冻结纪律」是否采用？（IF-1/IF-4）
14. **变更订阅机制是否立项**：表级失效提示（data_version 完备层可平移）是否进入我们 v1 范围？（IF-2）

---

## 附：关键提交速查（供复核）

| 提交 | 日期 | 内容 |
|---|---|---|
| `3afecfb7` | 2026-07-16 | 接口冻结（42 abstract + 3 optional） |
| `26ee17fa` / `c08c62e1` / `9429cca8` | 07-25/26 | 事务破例 / 健康检查破例 / 字段改名 |
| `b5486313` / `1566485e` / `f00fb9a2` / `005791d3` | 08-18/19 (1zyao) | withTransaction 并发串行化 / 超时兜底 / 防队列毒化 / 60s 对齐 |
| `c91ceeb9` | 07-17 (RainyN0077) | .map 等价性修复 + dump 测试（F1-F4 对拍史） |
| `677dd653` | 06-27 (mobaiQWQ) | 声明式 .map 迁移系统新建 |
| `8e525df8` | 07-17 | 删除旧迁移实现（对拍收尾） |
| `22df5aa0` | 07-16 | import.meta.glob 修复（404 踩坑） |
| `80f07292` | 08-02 | 变更订阅（写漏斗 + 计数器完备层 + PG 原生推送） |
| `d10b0cc0` | 08-08 | 仓库转移收尾（VRCX-K 品牌；models 目录同批落地） |
| `e4ec5611` | 08-24 | origin/old/main HEAD（勘察基线） |

## 附：cap 两份队长材料的原始位置

1. `.temp/legacy-recon/06-captain-verification-sqlite-concurrency.md`（cap-1/cap-2，含 probe 原始输出 `.temp/probe-sqlite-concurrency.ts` / `.temp/probe-lock-upgrade.ts`）
2. 队长消息（血统核验 cap-3：merge-base 复算一致 + 34/18 文件口径 + **old/main 与 rewrite 无共同祖先**）
