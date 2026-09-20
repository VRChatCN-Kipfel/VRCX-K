# 08 全仓「org 原创」普查：上游路径存在性判定（t8）

> 生成：2026 全仓只读普查（t8，补派）。
> 只读：未改动任何 tracked 文件。方法脚本：`.temp/legacy-recon/08-inventory.ps1`、`08-classify.ps1`；中间数据：`provenance-inventory.tsv` + `08-*-list.txt`。
> **本台账只上报事实，不做可用性判断** —— 「可不可以复制」由 captain / 用户裁定。
> 先前结论交叉印证：`05-provenance.md`（t5，数据库层）、`00-SUMMARY.md`（t6，含 cap-3「old/main 与 rewrite 无共同祖先」）。

> ## ⚠ 修正（2026-09 复核）：`docs/` 的 A 类判定有硬错误
>
> 本文件原判 **`docs/` 31 个全部 A 类（org 从零创建）**，**实测不成立**：
>
> - 实际为 **19 纯净 A + 12 rename/copy 自上游**
> - 成因：`d10b0cc0`（2026-08-08「仓库转移收尾」巨型提交）把**上游创建的文件**搬运进 `docs/`
> - 最强反例：`docs/features/LUO_FEATURES.md` 是 `README.md` 的 **COPY**，血统直达 pypy 2019
>
> ⇒ **全仓 A 类总数应为 87 − 12 = 75**（下文 §1 的 87 是**修正前**的数字，保留以见修正幅度）。
> ⇒ **根因是方法学缺口**：本普查只做「路径级存在性」，**对 rename/copy 掩盖的血统会漏**（§0 口径说明 L15 已标此风险，且 §5 已列 `configRepository`/`SQLiteAdapter` 两个已知例外 —— `docs/` 这 12 个是**同一缺口的更大一批**）。
> ⇒ **凡遇「一次性大规模目录/品牌重组」提交，必须补 `git show --find-copies-harder -C50% <commit>`**。
> 详见 §3.3（已改写）。

---

## 0. 方法（事实）

- **范围**：`origin/old/main` 全部 **1426 个文件**（git ls-tree -r）。
- **上游 refs**：`VRCX/master`（vrcx-team 官方，1288 文件）、`VRCX-Luo/master`（yixijun，1380）、`VRCX-jirai/master`（FuLuTang，1329）、`VRCX-onkel/main`（MiaobaiQWQ，1282）。
- **作者集合**：一次 `git log --name-only` 全量解析（4526 提交）→ 每文件「曾经碰过它的所有作者（去重）」。
  - ⚠ **口径说明（重要）**：本方法用 `git log origin/old/main --name-only`（**非 `--follow`**），即只看**当前路径**上发生的提交；**重命名前的旧路径提交不计入**该文件作者集。这与 t5/cap-3 的「`--follow` 溯源到旧路径」口径不同 —— 本方法对「路径级上游存在性」更强，但对「重命名掩盖的上游血统」会漏（见 §5 边界）。
- **原创判定（核心）**：文件在**任意上游 ref 的当前树里不存在** ⇒ org 从零创建（A 类，最强）。存在但提交作者全为 org ⇒ B 类（org 独占维护）。存在且被上游作者碰过 ⇒ C 类（共同历史）。
- **org 作者集合**：`XChen446`, `RainyN0077`, `mobaiQWQ`, `1zyao`, `CenFangyu(=Dmao233)`。**其余全部作者视为非 org（上游 fork 链）**：`pypy`, `Natsumi`, `pa`, `FuLu糖福禄/FuLuTang/Haochen TANG`, `copilot-swe-agent[bot]`, `yixijun`, `Teacup`, `dependabot[bot]` 等。

---

## 1. 全仓分类结果（事实）

| 类别 | 定义 | 文件数 | 占比 |
|---|---|---|---|
| **A 类｜org 从零创建** | 上游所有 ref 都没有该路径，且 old/main 该路径作者全为 org | **87** | 6.1% |
| A2 ｜org 创建但路径内出现分散 merge-created 提交 | 上游无路径，但作者集含 merge 提交产生的非 org 附加（见 §4） | 4 | 0.3% |
| B 类｜org 独占维护 | 上游有路径，但 old/main 该路径作者全为 org | **0** | 0% |
| C 类｜共同历史 | 上游有该路径，且被上游作者碰过 | **1335** | 93.6% |
| 无提交历史 | — | 0 | 0% |
| **合计** | | **1426** | |

> **B 类 = 0 的事实说明**：上游 refs 覆盖了绝大部分代码树；一旦某路径在上游 refs 存在，其历史里几乎必然包含上游作者（`pa`/`Natsumi`/`pypy` 等）的提交。**「上游有路径 + 全部提交为 org」在本仓库几乎不存在** —— 唯一的例外形式是被重命名掩盖的（见 §5 configRepository/SQLiteAdapter 边界，本方法未能捕获，t5 已用 `--follow` 捕获）。

---

## 2. 按顶层目录汇总（事实）

| 目录 | 文件数 | A（org 从零） | A2 | B | C | 说明 |
|---|---|---|---|---|---|---|
| `src/` | 1192 | 34 | 1 | 0 | 1157 | A 全部集中在 `src/services/database/`（34 个） |
| `Dotnet/` | 118 | 17 | 0 | 0 | 101 | A = 三引擎 + VRCX.Tests 全套 |
| `docs/` | 31 | ~~31~~ **19** | 0 | 0 | ~~0~~ **12** | ⚠ **原判"全部 A"有误**，见 §3.3 修正 |
| `build-scripts/` | 11 | 0 | 0 | 0 | 11 | — |
| `src-electron/` | 12 | 0 | 0 | 0 | 12 | — |
| `Installer/` | 7 | 0 | 0 | 0 | 7 | — |
| `README/` | 9 | 0 | 0 | 0 | 9 | — |
| `images/` | 4 | 0 | 0 | 0 | 4 | — |
| `.github/` | 8 | 2 | 0 | 0 | 6 | A = gito-code-review.yml + qodana_code_quality.yml |
| `.gito/` | 1 | 1 | 0 | 0 | 0 | config.toml |
| `.vscode/` `.zed/` | 2+2 | 0 | 0 | 0 | 4 | — |
| `Dotnet.Tests/` | 2 | 0 | 0 | 0 | 2 | — |
| `test/` | 1 | 1 | 0 | 0 | 0 | `test/contract/adapter-contract.js` |
| `(root)` | 26 | 1 | 3 | 0 | 22 | A = AGENTS.md；A2 = JIRAI/LUO/ROOT _Version |
| **合计** | **1426** | **87** | **4** | **0** | **1335** | |

### src/ 二级目录（事实）

| 二级目录 | 文件数 | A | C |
|---|---|---|---|
| `src/services/` | 70 | **34** | 36 |
| `src/components/` | 532 | 0 | 532 |
| `src/views/` | 220 | 0 | 220 |
| `src/shared/` | 119 | 0 | 119 |
| `src/stores/` | 62 | 0 | 62 |
| `src/public/` | 39 | 0 | 39 |
| `src/coordinators/` | 30 | 0 | 29(+1 A2) |
| `src/api/` | 26 | 0 | 26 |
| `src/localization/` | 17 | 0 | 17 |
| `src/styles/` | 15 | 0 | 15 |
| `src/types/` | 13 | 0 | 13 |
| `src/composables/` | 13 | 0 | 13 |
| `src/plugins/` | 10 | 0 | 10 |
| `src/queries/` | 9 | 0 | 9 |
| `src/lib/` | 5 | 0 | 5 |
| `src/ipc-electron/` | 1 | 0 | 1 |
| `src/workers/` | 2 | 0 | 2 |
| `src/vr/` | 4 | 0 | 4 |

---

## 3. A 类清单（87 个，org 从零创建 —— 最强）

### 3.1 `Dotnet/` org 原创（17 个）

| 文件 | 路径内提交数 | 作者 | add 提交 |
|---|---|---|---|
| `Dotnet/MySQL.cs` | 38 | XChen446(35) RainyN0077(1) 1zyao(1) | `d1bb45f7` 2026-07-18 XChen446 |
| `Dotnet/PostgreSQL.cs` | 28 | XChen446(26) RainyN0077(2) | `2904d1c4` 2026-07-18 XChen446 |
| `Dotnet/IAuthStore.cs` | 1 | XChen446 | — |
| `Dotnet/VRCX.Tests/BridgeTestHelper.cs` | — | XChen446/RainyN0077 | — |
| `Dotnet/VRCX.Tests/MySqlBridgeTests.cs` | — | org | — |
| `Dotnet/VRCX.Tests/MySqlPoolStatsTests.cs` | — | org | — |
| `Dotnet/VRCX.Tests/PostgreSqlBridgeTests.cs` | — | org | — |
| `Dotnet/VRCX.Tests/PostgreSqlPoolStatsTests.cs` | — | org | — |
| `Dotnet/VRCX.Tests/SQLiteBridgeTests.cs` | — | org | — |
| `Dotnet/VRCX.Tests/SQLitePoolStatsTests.cs` | — | org | — |
| `Dotnet/VRCX.Tests/SQLiteRetryTests.cs` | — | org | — |
| `Dotnet/VRCX.Tests/SQLiteSecurityTests.cs` | — | org | — |
| `Dotnet/VRCX.Tests/SQLiteTestCollection.cs` | — | org | — |
| `Dotnet/VRCX.Tests/Stubs/ProgramStub.cs` | — | org | — |
| `Dotnet/VRCX.Tests/Stubs/VRCXStorageStub.cs` | — | org | — |
| `Dotnet/VRCX.Tests/Usings.cs` | — | org | — |
| `Dotnet/VRCX.Tests/VRCX.Tests.csproj` | — | org | — |

> 核验（事实）：`VRCX-Luo/master` 的 `Dotnet/*.cs` 共 88 个，**其中 MySQL/PostgreSQL/IAuthStore = 0 个**；官方 `VRCX/master` 也没有这三个文件。`Dotnet/` 目录本身上游存在（98/104 个文件），但**这三个文件 + 测试套件是 org 在 2026-07-18 加进既有 Dotnet/ 壳里的**（XChen446「feat(C#MySQL/PgSQL): 添加数据库初版前置集」）。

### 3.2 `src/services/database/` org 原创（34 个 —— 与 t5/cap-3 的 34 全绿一致）

```
src/services/database/__tests__/configRepository.test.js
src/services/database/__tests__/feed.test.js
src/services/database/adapter/__tests__/adapterContract.test.js
src/services/database/adapter/__tests__/changeNotification.test.js
src/services/database/adapter/__tests__/connectionStringRouting.test.js
src/services/database/adapter/__tests__/SQLiteAdapter.test.js
src/services/database/adapter/__tests__/SQLiteConcurrentWrite.test.js
src/services/database/adapter/__tests__/transaction.test.js
src/services/database/adapter/EngineAdapter.js
src/services/database/adapter/index.js
src/services/database/adapter/index.test.js
src/services/database/adapter/MySQLAdapter.js
src/services/database/adapter/MySQLAdapter.mysql.test.js
src/services/database/adapter/MySQLAdapter.unit.test.js
src/services/database/adapter/PgSQLAdapter.js
src/services/database/adapter/PgSQLAdapter.pgsql.test.js
src/services/database/adapter/PgSQLAdapter.unit.test.js
src/services/database/adapter/SQLiteAdapter.js
src/services/database/configRepository.js        ⚠ 见 §5 边界
src/services/database/migrations/__tests__/__fixtures__/v16-expected.dump
src/services/database/migrations/__tests__/dumpNormalizer.js
src/services/database/migrations/__tests__/memoryAdapter.js
src/services/database/migrations/__tests__/migrationEquivalence.test.js
src/services/database/migrations/__tests__/migrationTransactionProtection.test.js
src/services/database/migrations/__tests__/preV16Fixture.js
src/services/database/migrations/_template.map
src/services/database/migrations/16/data.map
src/services/database/migrations/16/schema.map
src/services/database/migrations/index.js
src/services/database/migrations/migrations.js
src/services/database/pullEngine.js
src/services/database/pullEngine.test.js
src/services/database/pushEngine.js
src/services/database/pushEngine.test.js
```

### 3.3 `docs/` org 原创（~~31 个~~ → **19 个**）⚠ 本节已于 2026-09 修正

> **原判错误（已更正）**：本节原先称 `docs/` **31 个全部 A 类（org 自建）**。**实测不成立。**
>
> `d10b0cc0`（2026-08-08「仓库转移收尾」大提交）**把 12 个文件 rename/copy 进 `docs/`，而它们由上游作者创建**。用 `git show --find-copies-harder -C50% d10b0cc0` 可复现 **11 条 `=>` 记录**：
>
> ```
> docs/{ => architecture}/CONFIG_REFACTOR.md
> docs/{ => architecture}/DATA_REFRESH.md
> docs/{ => architecture}/TRANSACTION_DESIGN.md
> docs/{ => architecture/models}/vrcx_erd.dbml
> docs/{ => architecture/models}/vrcx_erd.mmd
> docs/{ => architecture/models}/vrcx_mcd.mcd
> docs/{ => architecture/models}/vrcx_mcd_erd_crow.gv
> docs/{ => architecture/models}/vrcx_mcd_mld.md
> docs/{ => architecture/models}/vrcx_sr.mcd
> docs/{ => features}/JIRAI_FEATURES.md
> README.md => docs/features/LUO_FEATURES.md        ← 最强反例
> ```
>
> **最强反例 `LUO_FEATURES.md` 是 `README.md` 的 `C050` COPY** —— 血统直达 **pypy 2019-08-16 Initial commit** 与 24 位上游作者。**copy 与 rename 同样搬运上游内容，而且更隐蔽**（比 `configRepository.js` 那条 rename 链更难发现）。
>
> 另：由 ERD 源（`.dbml` / `.mcd`）派生的图与 DDL（`svg` / `ddl` / `mld` / `geo`）**同源**，不能算 org 原创。
>
> **⇒ 修正后的构成：19 纯净 A + 12 rename/copy 自上游。**

**19 个纯净 A**：`docs/README.md`、`docs/SKILL.md`，加 `docs/architecture/` 中与上表 `=>` 清单**不相交**的文档（`ADAPTER_API` / `ADAPTER_GUIDE` / `ENGINE_CONTRIBUTOR_GUIDE` / `ENGINE_MIGRATION_GUIDE` / `MULTI_ACCOUNT_V4_DETAIL_DESIGN` / `PGSQL_DESIGN` / `SECURITY_NOTES`，以及 `models/` 中未被搬运的派生件）。

**⚠ 方法学教训（本节的真正价值）**：「路径由 org 创建」**不等于**「内容由 org 创作」。`d10b0cc0` 这类**一次性大规模品牌/目录重组提交**最容易掩盖 rename 与 copy，**只看路径级分类会系统性高估 A 类**。凡遇到此类"巨型提交"，必须补一次 `--find-copies-harder` 扫描。

### 3.4 其他 org 原创（5 个）

- `AGENTS.md`（根）
- `.gito/config.toml`
- `.github/workflows/gito-code-review.yml`
- `.github/workflows/qodana_code_quality.yml`
- `test/contract/adapter-contract.js`

---

## 4. A2 边缘类（4 个，org 创建但路径内出现 merge 产物）

| 文件 | 说明 |
|---|---|
| `JIRAI_Version` | 由 org merge 提交 `ef8d3632`（2026-08-05 XChen446 "Merge(master)"）创建 |
| `LUO_Version` | 由 org merge 提交 `3045e486`（2026-08-07）创建 |
| `ROOT_Version` | 由 org merge 提交 `f25a75ff`（2026-08-04 XChen446 "Merge(VRCX/master) ... 新建 ROOT_Version 跟踪文件"）+ `3045e486` 创建 |
| `src/coordinators/__tests__/userEventCoordinator.test.js` | ⚠ 实为 **C 类**：`1zyao` 2026-08-10 在 pa 2026-03-10 已创建路径上加测试（作者集含 pa）—— 我的首个分类器把它误标 A2；修正后它是共同历史 |

---

## 5. 方法边界（重要事实，非可用性判断）

1. **B 类在本方法下为 0，但 t5 用 `--follow` 找到两个「类 B」文件**：
   - `src/services/database/configRepository.js`：上游 refs 无此路径（A）、路径内作者全 org，但 `--follow` 溯源链最老节点 = **2020-11-02 pypy**（原名 `html/src/repository/config.js` → `src/service/config.js` → `src/services/config.js` → `src/services/database/configRepository.js`，R100/R098/R096 rename）。即它是 **org 从上游 rename 来的文件继续维护**，不是「从零创建」。
   - `src/services/database/adapter/SQLiteAdapter.js`：上游无该路径，但 **inline 自 `src/services/sqlite.js`**，而 sqlite.js 曾含上游作者提交（`ff152992` pa rename / `4337bd57` copilot-swe-agent[bot] / `dfa91e8d` yixijun）。
   - ⇒ **「路径不存在于上游」能证明「该路径是 org 建的」，但不能证明「文件内容无上游血统」**（rename/inline 会把上游内容搬进新路径）。这两例的最终内容归属，git 证据只给到渊源，**不裁定**。
2. **`git log --name-only`（非 follow）不追踪重命名历史** —— 例：`src/services/database/memos.js`（A 判定为 C，正确，因为 pa rename 提交 `ff152992` 在路径历史里）；而 rename 前的旧路径提交会被漏。
3. **上游 refs 是「当前快照」判据**：某路径现在不在上游 refs ≠ 曾经不在（上游可能删过文件）。对 1426 个文件逐一做「曾经存在性」需遍历上游历史，未做（见 §7）。

---

## 6. 佐证 org 成员名单（事实 + 推测分开）

| 作者 | 是否 org | 证据 |
|---|---|---|
| `XChen446 <xchen446@outlook.com>` | **事实** | 项目负责人；old/main 203 提交全部不在上游可达集合；rewrite 78 提交 |
| `CenFangyu <164994318+Dmao233@users.noreply.github.com>` | **事实** | GitHub id = Dmao233（M1 PR 作者）；rewrite 3 提交 |
| `1zyao <107829654+1zyao@users.noreply.github.com>` | **事实（本次升级）** | **rewrite 8 提交（M2 PR #31/#32/#15 + 5 个 build/UI fix，2026-09-11~13）**，与 XChen446 同仓协作；old/main 12 提交全部在 org 期（2026-08-07~24）|
| `RainyN0077 <gotiyu0407@gmail.com>` | **推测（强）** | old/main 54 提交**全部在 merge-base（2026-05-20）之后**（2026-07-14~07-31）；提交风格 = 中文 + task 编号（task 9.x/10.x），与 XChen446 同批次文件协作（EngineAdapter/PgSQLAdapter/migrations 同文件交替提交）；**未在 rewrite 出现** |
| `mobaiQWQ <2748376556@qq.com>` | **推测（弱）** | old/main 2 提交（2026-06-27、07-04，创建 .map 迁移系统）；仅出现在 org 期；**未在 rewrite 出现**；与上游 fork 名 `MiaobaiQWQ/VRCX-onkel` 重合但该 fork 是上游 ref（非本 org）——同一账号的可能性无法排除也无法确认 |
| `pa <maplenagisa@gmail.com>` | **事实非 org** | 981 提交全部在上游继承链（0 个在 org 增量）；2024-12→2026-04，早于 org 起点 |
| `FuLu糖福禄/FuLuTang/Haochen TANG` | **事实非 org** | 同一 email `tanghaochen0506@hotmail.com`；上游 jirai fork 作者；old/main 100 提交全在 2026-03~05（上游期）|
| `copilot-swe-agent[bot]` | **事实非 org（也不是人工）** | GitHub Copilot agent 身份；90 提交全在上游继承链 |
| `Natsumi`/`pypy`/`yixijun`/`Teacup`/`dependabot[bot]` | **事实非 org** | 上游官方/链作者，提交全在上游继承链 |

**「只出现在 merge-base 之后」核验（事实）**：
- `RainyN0077`：old/main 提交日期范围 2026-07-14 → 2026-07-31，**全部在 2026-05-20 merge-base 之后** ✓
- `mobaiQWQ`：2026-06-27、2026-07-04，**全部在 merge-base 之后** ✓
- `1zyao`：2026-08-07 → 2026-08-24，**全部在 merge-base 之后** ✓
- `XChen446`：2026-06-23 → 2026-08-24，全部在 merge-base 之后 ✓（首笔 `c6aac869` 还进入了 VRCX-Luo 链）
- 对照：`pa` 2024-12→2026-04、`FuLu糖福禄` 2026-03~05 —— **全部在 merge-base 之前** ✓

---

## 7. 无法确定的事项

1. **文件的「曾经上游存在性」**：当前快照判据下 87 个 A 文件「现在不存在于任何上游 ref」。但上游**历史**中这些路径是否曾存在（后被上游删除），未做全历史遍历 —— 需要按文件跑 `git log --all -- <path>` 才能排除。
2. **`configRepository.js` / `SQLiteAdapter.js` 的内容血统**：路径是 org 建的，但 rename/inline 链把上游内容带进来。最终内容「是否完全 org 编写」git 证据不裁定（t5 §7 同）。
3. **`RainyN0077` / `mobaiQWQ` 的正式成员身份**：git 内无组织归属元数据；未出现在 rewrite。只能凭「时间在 merge-base 后 + 风格 + 与 XChen446 协作」推测。
4. **`mobaiQWQ` 与 `MiaobaiQWQ/VRCX-onkel` 是否同一人**：无法从 git 确定（若同一人，则其同时也是上游 fork 作者，身份跨 org/上游两侧）。
5. **A 类 87 个文件里，是否有内容「整体从上游同路径/近路径复制」的**：路径判据只证明「org 创建了这个路径」，不能证明「内容没抄」。行级等价性需要 `git diff` 对拍（超出本台账）。
6. **`1zyao` 是否还有另一 GitHub 账号/是否 team 外协作者**：rewrite 提交带 PR/issue 编号说明是活跃协作者，git 内无正式成员标识。

---

## 8. 值得进一步勘察的候选（只列，不判断价值）

**A 类且提交数较多 / 位于关键子系统**：

| 文件 | 路径内提交数 | 子系统 | 备注 |
|---|---|---|---|
| `Dotnet/PostgreSQL.cs` | 28 | 数据库（PG 引擎） | org 原创，PG 池化/事务/trigger 推送 |
| `Dotnet/MySQL.cs` | 38 | 数据库（MySQL 引擎） | org 原创，MySQL 方言/池化 |
| `src/services/database/adapter/SQLiteAdapter.js` | 46 | 数据库（SQLite 引擎） | ⚠ inline 自 sqlite.js（上游血统），见 §5 |
| `src/services/database/adapter/EngineAdapter.js` | 38 | 数据库（抽象基类） | 接口契约 + 事务抽象 |
| `src/services/database/pushEngine.js` | 17 | 迁移引擎 | pull/push 分组事务 |
| `src/services/database/migrations/index.js` | 17 | 迁移系统 | .map 声明式运行器 |
| `src/services/database/pullEngine.js` | 14 | 迁移引擎 | 游标分页 copyTable |
| `src/services/database/configRepository.js` | 4 | 配置 | ⚠ pypy rename 链 |
| `docs/architecture/TRANSACTION_DESIGN.md` | 3 | 设计文档 | org 自写事务设计 |
| `docs/architecture/ADAPTER_API.md` | 1 | 契约文档 | org 自写接口冻结基线 |
| `Dotnet/VRCX.Tests/*`（15 个） | 1+ | 测试 | VRCX.Tests 全套 org 创建 |
| `docs/architecture/models/*`（17 个） | 1+ | 数据模型文档 | Mocodo/dbml/mermaid 全链 org 自建 |

**C 类中值得单独看（上游共同历史但 org 大改）**：`src/services/database/feed.js`、`gameLog.js`、`index.js`（上游文件 + org 2026-07 起重写）—— 血统混杂，归属判断需行级分析。

---

## 附：与 t5/cap-3 的交叉印证

- t5/cap-3 数据库层「34 个从未出现非 org 作者」= 本方法 **A 类 34 个数据库文件** ✓ 完全一致。
- t5 的「configRepository / SQLiteAdapter 例外」= 本方法 §5 边界 ✓ 一致（路径级判据看是 A，follow 溯源看是上游血统）。
- t5 的 18 个「上游污染」数据库文件 = 本方法 C 类 18 个 ✓ 一致。
- cap-3「old/main 与 rewrite 无共同祖先」= 本台账所有「取用即显式复制」的前提，未重复核验（队长已核）。
- **新增事实**：`1zyao` 升级为「事实 org」（rewrite M2 提交实证）；`RainyN0077`/`mobaiQWQ`/`1zyao` 全部提交都在 merge-base 之后（org 期），`pa`/`FuLu` 全部在 merge-base 之前（上游期）—— 时间线二分法为「谁是我们的人」提供第三独立证据。
