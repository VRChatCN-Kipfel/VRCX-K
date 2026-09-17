# 血统台账：`src/services/database/` 作者分布与上游 merge 事实

> 生成：2026 数据库层只读勘察（t5）
> 只读勘查，未改动任何 tracked 文件。
> **本台账只上报事实，不做可用性判断** —— 「可不可以复制」由 captain / 用户判定。

---

## 0. 血统链基线（事实）

- `old/main` 根提交 = `fe5fcd29` **2019-08-16 pypy "Initial commit"**（4526 commits，85 个 merge commit）。
- `old/main` 与 `VRCX-jirai/master`（FuLuTang 的 fork）的 **merge-base 就是 jirai 的 tip** `c8b8f744`（2026-05-20 "Update version from 2026.4.21 to 2026.5.20"），且 `VRCX-jirai/master` 完全被 `old/main` 包含。
- `old/main` 中 **388 个 commit 不在 jirai 上游可达范围内** = **前端工程在 2026-05-20 上游快照之上自加的增量**。
- `old/main` 中 **203 个 XChen446 提交全部不在 jirai 上游可达范围内**（org 自己的提交，0 个来自上游继承）。
- `pa` / `FuLu糖福禄` / `copilot-swe-agent[bot]` / `Natsumi` / `yixijun` 在 `git log -- path` 里出现 → 是**上游历史通过祖先链被继承**（上游 fork 在 2026-05-20 前已并入 old/main），**不是本 org 把上游分支 merge 进这些文件**。
  - 所有上游作者的提交日期 ≤ 2026-04-20（最新一笔 `FuLu糖福禄` 2026-04-20 "typo"）；org 工作从 **2026-06-23** 才开始（`c6aac869` XChen446）。
  - `pa <maplenagisa@gmail.com>`（981 提交，2024-12-05→2026-04-03）与 `FuLu糖福禄`（100 提交）在 old/main 的提交数与 `VRCX-Luo/master` 上游分支内对应作者提交数**完全一致重合并**（981 / 100 / 90 copilot / 2011 Natsumi）——证明这些提交是上游链上就发生的，不是本 org 的 merge 动作。
- **`XChen446` 有 1 个提交（`c6aac869`, 2026-06-23）也在 `VRCX-Luo/master` 内**，且它是 `old/main` 的祖先 —— 即 org 最早的一笔曾进入 VRCX-Luo 上游链（npm audit fix），被本工程后续 merge-base 继承。
- 本工程 remote 链（事实）：`origin` = `VRChatCN-Kipfel/VRCX-K`；`VRCX` = `vrcx-team/VRCX`（官方）；`VRCX-Luo` = `yixijun/VRCX-Luo`；`VRCX-jirai` = `FuLuTang/VRCX-jirai`；`VRCX-onkel` = `MiaobaiQWQ/VRCX-onkel`。
- **说明/推测（标注）**：`pa <maplenagisa@gmail.com>` 是上游 VRCX-Luo 链的核心作者（非本 org）；`FuLu糖福禄` / `FuLuTang` / `Haochen TANG` = `tanghaochen0506@hotmail.com`（同一 GitHub 账号 FuLuTang，上游 jirai fork 作者，非本 org）；`copilot-swe-agent[bot]` / `Natsumi` / `yixijun` / `pypy` / `Teacup` / `FuLu糖福禄` 全是上游 fork 链作者，**不是本 org**。

---

## 1. 数据库目录逐文件台账（事实，`git log origin/old/main` 非 follow 口径）

> 说明：总提交数 / 作者分布 / 末次改动 按 `git log -- path`（不追 rename 的路径内提交口径）统计。
> 「上游 merge 痕迹」= 该文件历史里是否存在**上游 fork 作者（pa/FuLu糖福禄/copilot-swe-agent[bot]/Natsumi/yixijun/pypy/Teacup 等）提交**或 **FuLu糖福禄 的 "Merge upstream/master" 提交** —— 注意：这些是**上游链内 merge 痕迹**（发生在 jirai 上游 fork 内部），不是本 org 的 merge 动作。

| 路径 | 总提交数 | 作者分布（人: 次数） | 最后一次改动 | 上游 merge 痕迹 |
|---|---|---|---|---|
| `adapter/EngineAdapter.js` | 38 | XChen446:30, RainyN0077:4, 1zyao:4 | 2026-08-19 1zyao | 无 |
| `adapter/MySQLAdapter.js` | 37 | XChen446:35, RainyN0077:1, 1zyao:1 | 2026-08-24 1zyao | 无 |
| `adapter/PgSQLAdapter.js` | 20 | XChen446:18, RainyN0077:2 | 2026-08-08 XChen446 | 无 |
| `adapter/SQLiteAdapter.js` | 46 | XChen446:39, RainyN0077:7 | 2026-08-08 XChen446 | 无 * |
| `adapter/index.js` | 13 | XChen446:9, RainyN0077:4 | 2026-08-08 XChen446 | 无 |
| `adapter/MySQLAdapter.mysql.test.js` | 3 | XChen446:2, RainyN0077:1 | 2026-08-01 XChen446 | 无 |
| `adapter/MySQLAdapter.unit.test.js` | 7 | XChen446:6, 1zyao:1 | 2026-08-24 1zyao | 无 |
| `adapter/PgSQLAdapter.pgsql.test.js` | 3 | RainyN0077:2, XChen446:1 | 2026-07-25 XChen446 | 无 |
| `adapter/PgSQLAdapter.unit.test.js` | 7 | XChen446:6, RainyN0077:1 | 2026-08-02 XChen446 | 无 |
| `adapter/__tests__/SQLiteAdapter.test.js` | 4 | XChen446:3, RainyN0077:1 | 2026-07-31 XChen446 | 无 |
| `adapter/__tests__/SQLiteConcurrentWrite.test.js` | 1 | XChen446:1 | 2026-07-26 XChen446 | 无 |
| `adapter/__tests__/adapterContract.test.js` | 1 | RainyN0077:1 | 2026-07-18 RainyN0077 | 无 |
| `adapter/__tests__/changeNotification.test.js` | 2 | XChen446:2 | 2026-08-08 XChen446 | 无 |
| `adapter/__tests__/connectionStringRouting.test.js` | 4 | XChen446:3, RainyN0077:1 | 2026-07-31 XChen446 | 无 |
| `adapter/__tests__/transaction.test.js` | 6 | 1zyao:3, XChen446:3 | 2026-08-19 1zyao | 无 |
| `adapter/index.test.js` | 1 | RainyN0077:1 | 2026-07-31 RainyN0077 | 无 |
| `activityV2.js` | 11 | XChen446:7, pa:3, Natsumi:1 | 2026-07-25 XChen446 | 有（上游 pa/Natsumi 3+1 提交）|
| `avatarFavorites.js` | 11 | XChen446:7, pa:2, Natsumi:1, RainyN0077:1 | 2026-07-25 XChen446 | 有（pa/Natsumi）|
| `avatarTags.js` | 4 | XChen446:3, pa:1 | 2026-07-11 XChen446 | 有（pa，含 origin `ff152992 rename`）|
| `configRepository.js` | 4 | XChen446:3, 1zyao:1 | 2026-08-24 1zyao | 无（路径内）* |
| `feed.js` | 25 | XChen446:11, pa:7, FuLu糖福禄:4, copilot-swe-agent[bot]:3 | 2026-07-31 XChen446 | 有（pa/FuLu/copilot）|
| `friendFavorites.js` | 4 | XChen446:3, pa:1 | 2026-07-11 XChen446 | 有（pa rename）|
| `friendLogCurrent.js` | 5 | XChen446:4, pa:1 | 2026-07-11 XChen446 | 有（pa rename）|
| `friendLogHistory.js` | 7 | XChen446:5, pa:2 | 2026-07-14 XChen446 | 有（pa）|
| `gameLog.js` | 39 | copilot-swe-agent[bot]:12, pa:11, XChen446:8, FuLu糖福禄:5, RainyN0077:2, Natsumi:1 | 2026-07-31 XChen446 | 有（上游 29 提交 + 4 个 "Merge upstream" FuLu 提交）|
| `index.js` | 20 | pa:8, XChen446:6, copilot-swe-agent[bot]:3, FuLu糖福禄:1, mobaiQWQ:1, RainyN0077:1 | 2026-07-25 XChen446 | 有（pa/FuLu/copilot/Natsumi 溯源）|
| `manualRelations.js` | 7 | XChen446:5, FuLu糖福禄:1, copilot-swe-agent[bot]:1 | 2026-07-14 XChen446 | 有（FuLu/copilot）|
| `memos.js` | 5 | XChen446:4, pa:1 | 2026-07-11 XChen446 | 有（pa rename）|
| `migrations/16/data.map` | 4 | XChen446:2, RainyN0077:1, mobaiQWQ:1 | 2026-07-17 RainyN0077 | 无 |
| `migrations/16/schema.map` | 4 | XChen446:2, RainyN0077:1, mobaiQWQ:1 | 2026-07-17 RainyN0077 | 无 |
| `migrations/_template.map` | 6 | XChen446:5, mobaiQWQ:1 | 2026-07-16 XChen446 | 无 |
| `migrations/index.js` | 17 | XChen446:11, RainyN0077:5, mobaiQWQ:1 | 2026-07-25 XChen446 | 无 |
| `migrations/migrations.js` | 1 | mobaiQWQ:1 | 2026-06-27 mobaiQWQ | 无 |
| `migrations/__tests__/__fixtures__/v16-expected.dump` | 1 | RainyN0077:1 | 2026-07-17 RainyN0077 | 无 |
| `migrations/__tests__/dumpNormalizer.js` | 1 | RainyN0077:1 | 2026-07-17 RainyN0077 | 无 |
| `migrations/__tests__/memoryAdapter.js` | 5 | XChen446:4, RainyN0077:1 | 2026-08-02 XChen446 | 无 |
| `migrations/__tests__/migrationEquivalence.test.js` | 2 | RainyN0077:2 | 2026-07-18 RainyN0077 | 无 |
| `migrations/__tests__/migrationTransactionProtection.test.js` | 3 | XChen446:2, RainyN0077:1 | 2026-07-25 XChen446 | 无 |
| `migrations/__tests__/preV16Fixture.js` | 1 | RainyN0077:1 | 2026-07-17 RainyN0077 | 无 |
| `moderation.js` | 5 | XChen446:4, pa:1 | 2026-07-11 XChen446 | 有（pa rename）|
| `mutualGraph.js` | 12 | XChen446:6, pa:3, copilot-swe-agent[bot]:2, FuLu糖福禄:1 | 2026-07-25 XChen446 | 有（pa/FuLu/copilot）|
| `notifications.js` | 8 | XChen446:7, pa:1 | 2026-07-14 XChen446 | 有（pa rename）|
| `pullEngine.js` | 14 | XChen446:14 | 2026-08-01 XChen446 | 无 |
| `pullEngine.test.js` | 9 | XChen446:8, RainyN0077:1 | 2026-08-01 XChen446 | 无 |
| `pushEngine.js` | 17 | XChen446:15, 1zyao:2 | 2026-08-08 XChen446 | 无 * |
| `pushEngine.test.js` | 6 | XChen446:6 | 2026-08-01 XChen446 | 无 |
| `tableSize.js` | 4 | XChen446:3, pa:1 | 2026-07-11 XChen446 | 有（pa rename）|
| `trackedNonFriends.js` | 5 | XChen446:4, copilot-swe-agent[bot]:1 | 2026-07-14 XChen446 | 有（copilot 创建）|
| `worldFavorites.js` | 4 | XChen446:3, pa:1 | 2026-07-11 XChen446 | 有（pa rename）|
| `__tests__/configRepository.test.js` | 1 | 1zyao:1 | 2026-08-24 1zyao | 无 |
| `__tests__/feed.test.js` | 3 | XChen446:3 | 2026-07-31 XChen446 | 无 |
| `__tests__/gameLog.test.js` | 10 | XChen446:5, copilot-swe-agent[bot]:2, FuLu糖福禄:1, Natsumi:1, pa:1 | 2026-07-31 XChen446 | 有（上游）|

脚注（事实）：
- `*` `SQLiteAdapter.js` / `pushEngine.js` / `configRepository.js` 路径内提交全为 org 作者，但存在 **rename/inline** 溯源链（见 §4 / §5）。
- 上游 fork 作者的「Merge upstream/master」提交**发生在 FuLuTang/VRCX-jirai fork 内部**，不是本 org 对 vrcx-team 的 merge —— 但若要做「完全 org 原创」认定，它们仍是污染信号（该提交同时把上游代码带进文件历史）。
- 无改动的目录文件：`migrations/16/data.map` 的上游 merge 列为「无」。

---

## 2. 本 org 作者候选名单（推测，标注）

> 依据：① `rewrite` 分支现在的活跃作者（`rewrite` 是当前 VRCX-K 重写工作分支）；② 提交信息风格（中文、`feat/fix/refactor(database)` 前缀、issue/PR 编号）；③ 时间范围（2026-06 之后、org 工作期）；④ email 域名/组织归属。

| 候选作者名 | 依据 | 判定 |
|---|---|---|
| `XChen446 <xchen446@outlook.com>` | 项目负责人；`rewrite` 分支 78 提交；old/main 203 提交全部为 org 自加；提交信息为中文 + conventional 前缀 | **事实**（任务也点名）|
| `RainyN0077 <gotiyu0407@gmail.com>` | org 期（2026-07-14→2026-07-31）数据库重构主力；中文 task 编号提交信息（task 9.x/10.x）| **推测**（无 explicit 明示，但时间/风格/与 XChen446 协同强匹配）|
| `1zyao <107829654+1zyao@users.noreply.github.com>` | rewrite 分支 8 提交（PR/issue 编号 #27/#30/#35/#36）；old/main 12 提交全在 2026-08 org 期 | **推测**（用户提示里 1zyao 是 old/test/SQL_seedmap 相关；rewrite 活跃成员）|
| `mobaiQWQ <2748376556@qq.com>` | old/main 2 提交（2026-06-27、2026-07-04），创建声明式 .map 迁移系统；对应 remote `VRCX-onkel` = `MiaobaiQWQ/VRCX-onkel`（但那是上游 fork，非本 org）| **推测**（名字与 MiaobaiQWQ/onkel fork 相关，但该 fork 是上游，不是 VRChatCN-Kipfel；需要 captain 核实是否同一人）|
| `CenFangyu <164994318+Dmao233@users.noreply.github.com>` | **rewrite 分支 3 提交（M1 PR1-3），GitHub id = Dmao233**（用户在 M1 背景里点名的 PR 作者）| **事实**（CenFangyu = Dmao233 同一账号；rewrite 上无 CenFangyu 在 old/main 的提交）|
| `copilot-swe-agent[bot]` | 是 GitHub Copilot 的 agent commit 身份（<198982749+Copilot@users.noreply.github.com>）；90 提交在 old/main 但 **全部继承自上游 jirai fork**（不在 org 自加增量内）| **事实**：不是本 org 人工作者；是上游 fork 内 copilot 产物 |
| `pypy` / `Natsumi` / `Teacup` / `yixijun` / `FuLu糖福禄|FuLuTang|Haochen TANG` / `pa` / `dependabot[bot]` | 上游 VRCX / VRCX-Luo / VRCX-jirai fork 链作者（email：pypy 无名可考、Natsumi 官方主线、FuLu 三别名同 email、pa=maplenagisa）| **事实**：非本 org |

- 依据**反证**：`pa <maplenagisa@gmail.com>` 的 981 提交全部在 jirai/Luo 上游继承链内（0 个在 org 增量里）；`copilot-swe-agent[bot]` 90 提交同样全部在上游继承链内（0 个 org 增量）。

---

## 3. 本 org 候选作者在 `rewrite` 分支的当前名单（对照，事实）

| 作者 | 提交数（rewrite 分支）| email |
|---|---|---|
| `XChen446` | 78 | `xchen446@outlook.com` |
| `1zyao` | 8 | `107829654+1zyao@users.noreply.github.com` |
| `CenFangyu`（= Dmao233）| 3 | `164994318+Dmao233@users.noreply.github.com` |

> rewrite 分支 tip：2026-09-17（XChen446）。对照结论：rewrite 上的活跃作者 = XChen446 / 1zyao / Dmao233(CenFangyu) —— 与 old/main 数据库层的 org 提交人（XChen446 / RainyN0077 / 1zyao / mobaiQWQ）**不完全一致**（RainyN0077、mobaiQWQ 未在 rewrite 出现）。

---

## 4. `copy-ready` 候选清单（全部提交来自本 org 候选作者 + 无上游 merge 痕迹）—— 候选，非结论

判定准则（事实）：
1. 该文件路径内**全部提交作者 ∈ {XChen446, RainyN0077, 1zyao, mobaiQWQ}**（org 候选）；
2. 该文件**路径内无任何上游 fork 作者（pa/FuLu糖福禄/FuLuTang/copilot/Natsumi/yixijun/pypy/Teacup）提交**；
3. 无 FuLu 系 "Merge upstream/master" 痕迹；
4. `--follow` 溯源链**最老节点也是 org 作者**（排除 rename 自上游文件）；
5. 例外地核查了 rename/inline 链（SQLiteAdapter←sqlite.js、pushEngine←migrateEngine 等）。

**全绿（满足 1-4）文件：**

| 文件 | 说明 |
|---|---|
| `adapter/EngineAdapter.js` | 37 follow 提交，全 org；add=f36e2e0c 2026-07-10 XChen446 |
| `adapter/MySQLAdapter.js` | 37 follow 提交，全 org；add=2f9d94e0 2026-07-19 XChen446 |
| `adapter/PgSQLAdapter.js` | 20 follow 提交，全 org；add=b13fa83b 2026-07-19 RainyN0077 |
| `adapter/SQLiteAdapter.js` | 44 follow 提交，全 org；add=746efa34 2026-07-05 XChen446；inline 自 XChen446 自己的 `sqlite.js`（无上游作者）|
| `adapter/index.js` | 13 follow 提交，全 org；add=746efa34 XChen446 |
| `adapter/index.test.js` | 1 follow 提交（RainyN0077）|
| `adapter/__tests__/SQLiteAdapter.test.js` | 全 org |
| `adapter/__tests__/transaction.test.js` | 全 org（1zyao/XChen446）|
| `adapter/__tests__/connectionStringRouting.test.js` | 全 org |
| `adapter/__tests__/changeNotification.test.js` | 全 org |
| `adapter/__tests__/SQLiteConcurrentWrite.test.js` | 全 org |
| `adapter/__tests__/adapterContract.test.js` | 全 org |
| `adapter/MySQLAdapter.unit.test.js` | 全 org |
| `adapter/MySQLAdapter.mysql.test.js` | 全 org |
| `adapter/PgSQLAdapter.unit.test.js` | 全 org |
| `adapter/PgSQLAdapter.pgsql.test.js` | 全 org |
| `migrations/index.js` | 19 follow 提交，全 org；add=677dd653 2026-06-27 mobaiQWQ |
| `migrations/migrations.js` | 1 follow 提交（mobaiQWQ）|
| `migrations/_template.map` | 全 org |
| `migrations/16/data.map` | 全 org |
| `migrations/16/schema.map` | 全 org |
| `migrations/__tests__/memoryAdapter.js` | 全 org |
| `migrations/__tests__/migrationEquivalence.test.js` | 全 org（RainyN0077）|
| `migrations/__tests__/migrationTransactionProtection.test.js` | 全 org |
| `migrations/__tests__/dumpNormalizer.js` | 全 org |
| `migrations/__tests__/preV16Fixture.js` | 全 org |
| `migrations/__tests__/__fixtures__/v16-expected.dump` | 全 org |
| `pullEngine.js` | 16 follow 提交，全 org；add=a5231ccb 2026-07-24 XChen446（rename 自 backup/migrate 引擎，rename 链内仍全 org）|
| `pushEngine.js` | 22 follow 提交，全 org（origin `a7c57570` RainyN0077 2026-07-19）|
| `pullEngine.test.js` | 全 org |
| `pushEngine.test.js` | 全 org |
| `__tests__/feed.test.js` | 全 org（XChen446）|
| `__tests__/configRepository.test.js` | 全 org（1zyao）|

**注意（事实）**：`configRepository.js` 路径内全 org 且无 merge 痕迹，但 `--follow` 溯源链**最老节点 = 2020-11-02 pypy**（原始路径 `html/src/repository/config.js` → `src/service/config.js` → `src/services/config.js` → `src/services/database/configRepository.js`，R100/R098/R096 rename）。org 的 2026-07 提交（3 次）是**在同一文件里改**，但文件本体可追溯至 2020 pypy。这条链是否构成「copy-ready」**不做判断**，因它属于「rename 上游文件继续改」情形，与上面「全绿」文件不同。

**上游污染文件（不满足 2/3，供对照）：** 见 §1 表格「上游 merge 痕迹 = 有」的所有行（feed.js / gameLog.js / index.js / mutualGraph.js / manualRelations.js / trackedNonFriends.js / avatarFavorites.js / activityV2.js / avatarTags.js / friendFavorites.js / friendLogCurrent.js / friendLogHistory.js / memos.js / moderation.js / notifications.js / tableSize.js / worldFavorites.js / __tests__/gameLog.test.js）。

---

## 5. 三个最可能被借鉴文件的单独详查

### 5.1 `adapter/EngineAdapter.js`（作者时间线，`--follow` 全链，旧→新）

| 日期 | 作者 | 提交 | 主题 |
|---|---|---|---|
| 2026-07-10 | XChen446 | `f36e2e0c` | **新建**：引入 EngineAdapter 抽象基类 |
| 07-11 | XChen446 | `c89d60f7` `68f02064` | 消灭 adapter.execute；selectUnion/selectGroupBy |
| 07-13 | XChen446 | `0a3f0200` `89227780` | 统一数据交付层；表结构枚举 |
| 07-14 | XChen446 | `0aa954af` `f0afb46a` `fbd43ff4` | dropTable 抽象；_normalizeArgs 提基类；列常量 |
| 07-14 | RainyN0077 | `cd9421bf` | 修复 Gito 审查 11 项缺陷 |
| 07-16 | RainyN0077 | `3afecfb7` `7a7cc3cc` | JSDoc 完善 + 接口冻结；8 项缺陷修复 |
| 07-16 | XChen446 | `ea62efed` | 删 executeReadOnly，createAdapter 工厂 |
| 07-19 | RainyN0077 | `4ff8aaa8` | engineType getter 同步 |
| 07-19 | XChen446 | `3a457262` | MySQL 前缀方案 + engineType |
| 07-22 | XChen446 | `0687cdba` | 修 merge 引入的重复类成员（merge 分支同步）|
| 07-25 | XChen446 | `26ee17fa` `7b306310` `f6f3e745` `ebfde6d4` `8b285699` `830c3e58` | 栈式事务上下文 + withTransaction + keepAlive |
| 07-26 | XChen446 | `35ab7f51` `6bf9a0f1` `762b8943` `86c9e52a` `8aa06768` `c08c62e1` `9dedc048` `9429cca8` | 连接池计数器 / GetPoolStats / async 语义 |
| 08-01 | XChen446 | `7272699a` | GetPoolStats 反射真值 |
| 08-02 | XChen446 | `80f07292` | 数据库变更订阅 |
| 08-08 | XChen446 | `d10b0cc0` | 仓库转移收尾（VRCX-K 品牌）|
| 08-18/19 | 1zyao | `b5486313` `1566485e` `f00fb9a2` `005791d3` | withTransaction 并发串行化 / 超时兜底 |

**合计**：37 follow 提交；作者分布 XChen446:29, 1zyao:4, RainyN0077:4 → **100% org 候选作者，无上游 merge 痕迹**。

### 5.2 `adapter/SQLiteAdapter.js`（作者时间线，`--follow` 全链，旧→新）

| 日期 | 作者 | 提交 | 主题 |
|---|---|---|---|
| 2026-07-05 | XChen446 | `746efa34` | **新建**：SQLiteAdapter 抽象层，收归硬编码 SQL |
| 07-09 | XChen446 | `ddf9fa17` `657156c7` | 全面抽象层 rollout；DDL 移入 adapter |
| 07-10 | XChen446 | `f36e2e0c` | EngineAdapter 基类（SQLiteAdapter 继承）|
| 07-11 | XChen446 | `c89d60f7` `68f02064` | 竞态修复；selectUnion/selectGroupBy |
| 07-13 | XChen446 | `0a3f0200` `89227780` | 交付层统一；表结构枚举 |
| 07-14 | XChen446 | `ec70aff7` `807144b3` `0b86c2c3` `fbd43ff4` `0aa954af` | @-前缀消除；execute 修复；createTable；列常量 |
| 07-14 | RainyN0077 | `cd9421bf` | 修复 Gito 审查 11 项缺陷 |
| 07-16 | RainyN0077 | `a37396f1` `3b4fa87e` | UNION ALL 语法 / avatar_history 修复 |
| 07-16 | RainyN0077 | `49c9f35f` | _buildConnectionString 修复 |
| 07-16 | XChen446 | `71a924a3` | **remove sqlite.js, inline into SQLiteAdapter**（inline 自 XChen446 自己的文件）|
| 07-16 | XChen446 | `ea62efed` | createAdapter 工厂 |
| 07-16 | RainyN0077 | `3afecfb7` | JSDoc + 接口冻结 |
| 07-19 | XChen446 | `3a457262` | userTable 前缀 |
| 07-19 | RainyN0077 | `4ff8aaa8` | engineType override |
| 07-22 | XChen446 | `0687cdba` | merge 分支同步修复 |
| 07-25 | XChen446 | `be475c9d` `1c645955` `830c3e58` `35ab7f51` | _doBegin/_doCommit/_doRollback；池化事务 API；keepAlive |
| 07-26 | XChen446 | `6bf9a0f1` `2f7fb9f0` `762b8943` `8aa06768` `9dedc048` | 池计数 / 健康检查 / 清空池 |
| 07-26 | RainyN0077 | `f9bfe6da` | pullEngine SQLite 目标事务原子性（qa-review HIGH-1）|
| 07-28 | XChen446 | `b540b0d4` | getPoolStats fallback |
| 07-30 | XChen446 | `5c30bc63` `9351b097` `648bd03c` `fd34f492` `f6dd6718` | CefSharp 重载规避 / cookies 解耦 / 执行优先级 |
| 07-31 | XChen446 | `9b4228ee` | BeginTransactionOnConnection 改名 |
| 08-01 | XChen446 | `7272699a` | GetPoolStats 反射 |
| 08-02 | XChen446 | `80f07292` | 变更订阅 |
| 08-07 | XChen446 | `bc0bdf6e` | isVrOverlay 守卫 |
| 08-08 | XChen446 | `d10b0cc0` | 仓库转移收尾 |

**合计**：44 follow 提交；作者分布 XChen446:37, RainyN0077:7 → **100% org 候选作者，无上游 merge 痕迹**。唯一需注意：`src/services/sqlite.js`（inline 源）在 2026-03-10 之前也有 **上游作者提交**（`ff152992 pa rename`、`4337bd57 copilot-swe-agent[bot]`、`dfa91e8d yixijun` 2026-06-15、`92b5faac` XChen446 2026-06-26）—— 但 XChen446 在 07-16 把该文件 **inline 进 SQLiteAdapter 时**已由 org 重写过；这条 inline 链意味着「SQLiteAdapter 的最终内容 = org 层 + 旧 sqlite.js 血统」——**是否完全 org 原创，属判断事项，此处仅补报事实**（见 §4 注）。

### 5.3 `migrations/index.js`（作者时间线，`--follow` 全链，旧→新）

| 日期 | 作者 | 提交 | 主题 |
|---|---|---|---|
| 2026-06-27 | mobaiQWQ | `677dd653` | **新建**：声明式 .map 迁移系统，替换 runFixes |
| 06-27 | XChen446 | `5c040a0b` `ca923b22` | 安全/健壮性修复；路径遗漏修复 |
| 07-05 | XChen446 | `7c855d54` | 数据库引擎限制功能 |
| 07-08 | XChen446 | `ec23d091` | 迁移服务改为适配器模式 |
| 07-13 | XChen446 | `0a3f0200` | 交付层统一 |
| 07-14 | XChen446 | `ec70aff7` | @-前缀消除 |
| 07-16 | XChen446 | `ea62efed` | createAdapter 工厂 |
| 07-16 | RainyN0077 | `22df5aa0` `0c3fb4d2` | import.meta.glob 打包；loadMapFile 错误日志 |
| 07-17 | RainyN0077 | `c91ceeb9` | 4 处 .map 等价性 + runner 幂等 + dump 测试 |
| 07-19 | XChen446 | `902cf849` `3a457262` | getDatabaseEngine() 运行时引擎检测 |
| 07-19 | RainyN0077 | `508d2b01` | v16 .map skip 机制 |
| 07-21 | RainyN0077 | `d14ff097` `212e6f53` `96c193d9` | adapter 对齐 / Electron interop / pgsql Gito 修复 |
| 07-22 | XChen446 | `7842abe8` | PR#6 Gito 评审采纳 |
| 07-25 | XChen446 | `4d99a089` | withTransaction 消费者切换 |

**合计**：19 follow 提交；作者分布 XChen446:11, RainyN0077:5, mobaiQWQ:1 → **100% org 候选作者，无上游 merge 痕迹**。

---

## 6. 关键交叉验证（事实）

1. **上游作者提交全部早于 org 工作起点**：`src/services/database/` 内最后一批上游作者提交 = 2026-04-20（`f5f37e6a` FuLu糖福禄 "typo"）；org 第一笔（`c6aac869` XChen446）= 2026-06-23。**两者无交叠**。
2. **org 提交可归因**：`git rev-list origin/old/main --not remotes/VRCX-jirai/master --author="XChen446"` = 203 → 这 203 笔**全部不在** jirai 上游可达集合里 —— 即 `pa`/`FuLu`/`copilot` 提交在数据库文件的出现**全部继承自上游共享祖先**，没有任何 org 作者在这些文件里做上游 merge。
3. **org merge 提交存在但不是上游 merge**：org 自己做过 15 个 merge 提交（`XChen446`/`RainyN0077` 系，如 `0eeb3150 Merge(database-refactor)`、`3045e486 Merge(master): 同步上游 v2026.07.18`）。它们**把上游快照同步进 org 分支**，但统计上 `--not VRCX-jirai/master` 显示上游提交仍全部在祖先链、不在 org 增量里；这些 merge 的**主题**确含「同步上游」，是「non-first-parent 里掺入上游改动」的信号 —— 已逐文件计入 §1（例如 SQLiteAdapter 的 `0eeb3150`、EngineAdapter 的 `4c3059d2` 就是 org 发起的 merge，但 merge 的**对象**是 org 自己的 refactor 分支或上游快照，merge 结果 = org 分支内继续工作）。
   - **精确口径（事实）**：§1 表格「上游 merge 痕迹」= **上游 fork 作者提交存在**（pa/FuLu/copilot/Natsumi 等）+ **FuLu 系 "Merge upstream/master" 提交存在**。`0eeb3150`/`3045e486`/`4c3059d2` 等 **org 发起的** merge 提交**不计**为「上游 merge 痕迹」—— 它们主题含「同步上游」但作者是 org；已在 §5/§6 分开列出。
4. **`rewrite` 分支对照**：当前活跃作者 XChen446(78)/1zyao(8)/CenFangyu=Dmao233(3)，无 RainyN0077/mobaiQWQ → 「谁是我们的人」名单以 XChen446/1zyao/Dmao233 为确定，RainyN0077/mobaiQWQ 为推测。
5. **remote 链**：org = `VRChatCN-Kipfel/VRCX-K`；fork 链 = `vrcx-team/VRCX`（官方）→ `yixijun/VRCX-Luo`（含 pa/copilot/Natsumi 主量）→ `FuLuTang/VRCX-jirai`（含 FuLu糖福禄 merge）→ `MiaobaiQWQ/VRCX-onkel`（上游 fork，作者 mobaiQWQ 名字重合，归属不明）。

---

## 7. 无法确定的事项

1. **`RainyN0077` / `mobaiQWQ` 是否真属 VRChatCN-Kipfel 组织**：就 git 内证据无法确定（无组织归属标识；mobaiQWQ 与 `MiaobaiQWQ/VRCX-onkel` 上游 fork 名字/关系不明，`VRCX-onkel` remote 指向 MiaobaiQWQ 仓库，说明这个 fork 属于一个叫 MiaobaiQWQ 的人，可能不是本 org）。**需要 captain/用户核实**。
2. **`mobaiQWQ` 与 `MiaobaiQWQ` 是否同一人**：无法从 git 确定。
3. **`configRepository.js`（pypy 2020 溯源）与 `SQLiteAdapter.js`（inline 自曾含上游作者提交的 `sqlite.js`）** 是否算「完全 org 编写」：**git 证据只给到渊源**，是否因 org 重写而「所有权转移」属于可用性判断，本台账不裁定。
4. **org 的 15 个 merge 提交（`0eeb3150` 等主题含「同步上游」）带入的代码内容边界**：git 只能证明「上游提交本身不在 org 增量」，但 merge 冲突解决时 XChen446 可能把上游快照代码手工并入 org 分支 —— 这属于 merge commit 的产物，逐文件无法纯靠 `git log` 拆分。若需精确到行级 provenance，需要逐文件 `git blame` + merge 差异分析（超出本台账范围）。
5. **`pa` 是否可能部分是 org 成员的别名**：就 email（`maplenagisa@gmail.com`）+ 提交日期（2024-12→2026-04，早于 org 起点）+ 提交语言（英文、上游 PR 编号 #1007-#1712）来看是上游作者；但「981 个提交里有没有个别其实是 org 人」无法排除 —— 仅作**推测**。
6. **`1zyao` 与 `rewrite` 的 8 个提交是否与本 org 有正式关系**：rewrite 上 1zyao 提交带 PR/issue 编号（#27/#30/#35/#36），说明其是活跃协作者；但 git 内无组织归属元数据，正式成员身份需 captain 确认。
