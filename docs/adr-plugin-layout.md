# ADR：插件与运行时目录布局（M1 packaged 收口 × M2-7 合并）

> 状态：**布局决策已定，实现未开始**（2026-09-11 拍板；剩余待定项见 §5.2）。
> 本文同时解两个已拍板事项，因为它们是**同一个决策**：
> - **M1 收口补项**：安装态目前在安装后**起不来**（安装包不含宿主运行文件）；
> - **M2-7**：装/卸/升级需要"装在哪 / 版本目录 / 原子替换暂存区"。
>
> 若两边各做一半，必然返工。本文定后，两边各自落地并互相记账。
> **跟踪 issue**：[#16](https://github.com/VRChatCN-Kipfel/VRCX-K/issues/16)（M2 总览，M2-7 为其中一项）。
> 实测证据：`docs/probes/probe6.ts`（Include 语义）、`docs/probes/probe7.ts`（junction 加载）。

---

## 1. 现状（全部实证，非推测）

### 1.1 打包态今天必然失败

| 事实 | 位置 |
|---|---|
| `bundle` 只有 `externalBin`，**没有任何 `resources` 键** | `src-tauri/tauri.conf.json` |
| `build-host.ts` 只产 `host-<triple>[.exe]`，**不携带 `cordis.yml` 与 `plugins/`** | `scripts/build-host.ts` |
| 打包态把 **cwd 设为 `resource_dir()`**，并要求那里同时有 sidecar 与 `cordis.yml` | `host.rs:1362-1372`、`HostLaunch::compiled` |
| 缺 `cordis.yml` 时**响亮报错**（M1 修复，不再静默重启循环） | `host.rs:1299`、`1362-1371` |

⇒ 安装态的失败是**必然**且**可诊断**的。M1 修的是"可诊断"，不是"能用"。

### 1.2 今天两态的实际布局

| 态 | 宿主 cwd | `cordis.yml` | 解析规则 |
|---|---|---|---|
| dev | `<repo>/host`（`HostLaunch::source()`，`VRCXK_HOST_DIR` 可覆盖） | 仓库内，**可写** | `host.rs:1237-1248` |
| packaged | `resource_dir()` | **不存在** | `host.rs:1362-1372` |

`host/src/index.ts:154` 设 `ctx.baseUrl = pathToFileURL(process.cwd())`，随后 **Include 把它改写为 yml 所在目录**（见 §1.3）。

### 1.3 ⚠ 核心约束：`cordis.yml` **既是读源、又是写目标**

`@cordisjs/plugin-include/lib/index.js` 实测：

| 行 | 行为 | 后果 |
|---|---|---|
| `:30` | `filename = fileURLToPath(new URL(config.path, ctx.baseUrl))` | yml 路径在构造时解析一次 |
| `:37` | `ctx.baseUrl = <yml 所在目录>` | **相对插件路径全部以 yml 所在目录为根**——移动 yml 即移动解析根 |
| `:56-60` | `access(filename, W_OK)` 失败 ⇒ `readonly = true`（**静默**） | 只读目录不会立刻报错——**且见下方实测：失败会变成异步未捕获异常** |
| `:161-163` | 只读时 `_writeFile` **抛** `cannot overwrite readonly config` | ⇒ 只读位置放 yml = **M2 的装/卸/启停全部硬失败** |
| `:169-170` | 写盘 = `.tmp` + `rename`（原子） | 单文件原子性是**已有**的，不用自建 |
| `:172-178` | `writeFile` 经 `setTimeout(0)` **延迟**执行，**不返回 promise** | ⇒ 写失败**无法被调用方 catch**（见 §1.5 实测） |
| `:179-181` | `write()` 把**整棵活树** `root.data` 落盘 | ⇒ **读进去什么、就写回什么**：没有"随包只读层 / 用户可写层"的天然分离 |
| `:138-147` | 文件不存在时，若给了 `config.initial` 则由它**播种**，否则报 `config file not found` | ⇒ **首次运行播种**是内置能力（⚠ 类型见 §1.5） |
| `:80-137` | `config.patches`：`insert`（可指定 group id）或按 `id` 覆盖键，`name` 不匹配则 warn+跳过 | ⇒ **声明式覆盖层**是内置能力，且**在内存中应用、不改原文件**（但写入时会烘焙，见 §1.5） |

> 注：`patches` 在内存应用，但 `write()` 落盘的是**已合并的活树** ⇒ 一旦触发任何写入，**patch 结果会被烘焙进用户文件**。

### 1.4 宿主本身对目录一无所知

宿主只用 `process.cwd()` 与 `ctx.baseUrl`；**没有任何** app 目录概念（`app_config_dir` / `app_data_dir` 都只在 Rust 侧可达）。⇒ 布局若要跨目录，**壳必须把目录告诉宿主**。

### 1.5 Include 行为实测（探针 `probe6.ts`，本轮；**逐条实测，非推断**）

**U1 — `config.initial` 可用，但类型是「数据」不是「文本」** ⚠ **本条推翻按源码的推断**

```
输入 initial = "- id: seeded\n  name: ./plugins/seeded.ts\n"   (字符串)
生成的文件内容 = "|\n  - id: seeded\n    name: ./plugins/seeded.ts\n"
```

原因：`:143` 的 `writeFile(this.config.initial)` 最终走 `_writeFile` → `yaml.dump(config)`。传字符串 ⇒ **yaml 把它当成标量，序列化成块字面量 `|`**，产出一个**语法正确但语义完全错误**的文件。

⇒ **`initial` 必须传已解析的数据结构**（条目数组），不能传 yml 文本。

**U2 — 只读 yml 的失败模式比预想更糟**

```
U2_loadedOk: true          // 装载成功
U2_readonlyFlag: true      // 静默置位
U2_writeThrew: false       // write() 同步不抛
// 随后异步抛出（未捕获）：
error: cannot overwrite readonly config
  at _writeFile (plugin-include/lib/index.js:162)
```

⇒ `writeFile` 经 `setTimeout(0)` 延迟且**不返回 promise**，所以**写失败无法被调用方 catch**，只会变成未捕获异步异常。**M2 的装/卸/启停错误提示不能依赖 catch**——必须在写入前自查可写性并给出明确错误。

**U3 — `patches` 会被烘焙进文件（推断已证实）**

```
patch = [{ id: "base", disabled: true }]
内存树 = [{"id":"base","name":"./plugins/base.ts","disabled":true}]   // patch 生效
write() 后的文件 = "- id: base\n  name: ./plugins/base.ts\n  disabled: true\n"  // ★ 已烘焙
```

⇒ **方案 B（base 走 patch 层）必须继承并改写 `write()` 做过滤**，否则首次写入就把随包 base 永久写进用户文件。

---

## 2. 关键张力

```
        随包资源（resource_dir）                用户目录（config/data）
    ┌──────────────────────────┐        ┌──────────────────────────┐
    │ 更新时整包替换             │        │ 更新必须不动              │
    │ 可能只读（macOS .app、     │        │ 必须可写（Include 要写）   │
    │ Linux 包、Program Files） │        │ 装/卸/升级的暂存区在这里   │
    └──────────────────────────┘        └──────────────────────────┘
              ▲                                      ▲
              │            base 插件                  │   用户插件 + 状态
              └───────────────┬──────────────────────┘
                              │
                    ❗ 但 Include 只有一个 `path`，
                       且读的是它、写的也是它
```

**一句话**：base 插件要跟包更新（只读、路径稳定），用户状态与用户插件要持久可写；而 Include 的单一 `path` + 读即写模型**不天然支持这个二分**。

---

## 3. 候选方案

### 方案 A：单 yml 在用户配置目录 + `initial` 播种（base 用稳定路径）

```
<resource_dir>/                    # 随包，更新时替换；可能只读
  host.exe                         # sidecar
  base/cordis.yml                  # base 定义（播种源，不直接读）
  base/plugins/<name>/             # base 插件——路径稳定，不含版本号
<app_config_dir>/                  # 可写；更新不动
  cordis.yml                       # ★ 唯一真源（首次由 initial 播种）
<app_data_dir>/                    # 可写；用户装的插件
  plugins/<id>/<version>/
  plugins/.staging/                # 原子替换暂存区
```

- Include：`{ path: "<app_config_dir>/cordis.yml", initial: <已解析的 base 条目数组> }`
  - ⚠ **`initial` 必须传数据结构，不能传 yml 文本**（§1.5 U1 实测）⇒ 建议随包 base 用 **JSON**（`base/cordis.json`），宿主 `JSON.parse` 后传入，避免在宿主里引入 YAML 依赖
- base 条目在播种数据里写成**绝对路径**指向 `resource_dir/base/plugins/<name>`（路径稳定 ⇒ 更新后仍有效）
- 用户插件条目写绝对路径指向 `app_data_dir/plugins/...`

| 维度 | 评价 |
|---|---|
| 实现量 | **最小**——纯用内置 `initial`，无需自建层 |
| 更新行为 | base 路径稳定 ⇒ 用户 yml 不做废；新 base 插件版本需"路径稳定 + 版本清单"配合 |
| dev 同构 | ✅ dev 的 yml 在 `<repo>/host`，packaged 的在 config dir，**同一套解析规则**（都由 Include 定 baseUrl） |
| 缺点 | 用户 yml 含**绝对路径**（换机/换安装位置即失效）；base 的启停/配置状态与用户条目混在同一棵树，**难以区分"哪些是随包、哪些是用户加的"** |
| 风险 | 用户改坏 yml ⇒ 需要 schema 校验 + 回退（当前无） |

### 方案 B：base 由宿主装配（不进用户 yml）+ 用户 yml 只存用户层

- 宿主启动时：先按 `resource_dir/base/plugins` **用代码装配 base 条目**（同 `index.ts:184` 现有 `ctx.loader.create` 手法），再 create Include（`path` = 用户 yml）
- 用户 yml 只含用户条目 + 对 base 的覆盖（`disabled` / `config`）

| 维度 | 评价 |
|---|---|
| 优点 | base 随包更新**完全自由**（路径可变）；用户 yml **不含绝对路径**；两类条目**天然可区分** |
| 缺点 | **base 的启停/配置不再由 EntryTree 统一表达** ⇒ M2 的"启停即时生效"要对两个来源分别实现；需要自建一层"用户态覆盖 base"的合并逻辑 |
| 额外风险 | 若让 Include 写整棵树，**base 会被烘焙进用户文件**——需继承并改写 `write()` 做过滤（自建，但小而可控） |
| 实现量 | 中（M2 的管理面本来就要做，可顺带） |

### 方案 C：首次运行把 base **拷贝**进用户目录，之后只看用户目录

| 维度 | 评价 |
|---|---|
| 优点 | **单一路径、无跨目录引用**，Include 原生语义最顺；dev/packaged 同构最容易（都只是"一个用户目录"）；`resource_dir` 只读/被更新替换完全不影响运行 |
| 缺点 | **更新需要处理 base 变更**（旧 base / 新 base / 用户当前），否则要么覆盖用户改动、要么丢更新；磁盘冗余 |
| 前提 | 必须配一个**版本迁移机制**（见 §4.0）——这是"拷贝"形态的固有代价，不是可选项 |

---

## 4. 定案：**方案 C + 版本目录**（本轮拍板），及其必须解决的张力

### 4.0 ⚠ 先说张力：C + 版本目录 ⇒ yml 里的版本路径会过期

拍板组合是 **方案 C（拷入用户目录）+ base 带版本目录**。这两个放在一起会产生一个**必须显式解决**的问题：

```
播种时：cordis.yml 里写死  base/1.0.0/plugins/<name>
应用升级：拷入 base/1.1.0/ ，但 cordis.yml 仍指向 1.0.0
结果：   base 插件实际上没更新 —— 版本目录反而把 C 的「base 随包」意义抹掉了
```

⇒ **版本化路径与"真源 yml 静态持有路径"天然冲突**。这不是风格问题，是必须选一种机制来化解。三个候选：

| 方案 | 机制 | 优点 | 代价 |
|---|---|---|---|
| **R1 稳定入口指针**（推荐） | `<data>/base/<version>/` 存真实内容；`<data>/base/current` 指向当前版本（Windows 用 **junction** `mklink /J`——本地目录不需要管理员；macOS/Linux 用 symlink）。**yml 播种时写 `base/current/plugins/<name>`** | **路径永远稳定 ⇒ 升级只切指针，完全不改写 yml**；旧版本目录保留 ⇒ **可回滚**；无用户文件被改写的风险 | 多一层链接机制；三平台行为需各自验证；链接被误删需自愈 |
| **R2 启动期确定性迁移** | yml 写死版本路径；启动时宿主读 base 清单，若 yml 内 base 条目版本 ≠ 随包版本 ⇒ **改写这些条目路径并落盘** | 无链接机制，纯文件，实现直白 | **每次升级都改用户文件**（有损坏风险）；需要在 yml 里标记"哪些条目属于 base"（id 前缀或 group 约定）；回滚需反向迁移 |
| **R3 base 不进 yml**（纯方案 B） | base 由宿主代码装配；yml 只存用户层 | 最干净；版本路径不进用户文件 | 与"单一路径、yml 单一真源"的初衷部分冲突；base 启停需另走一层 |

**原倾向 R1，但实测后已下调** —— 见 §4.0.1。

### 4.0.1 ⚠ R1 的实测缺陷：junction 会在插件路径里再插一个"键空间"

**实测（`probe7.ts`）**：

| 检查 | 结果 |
|---|---|
| Windows 建 junction 是否需要管理员 | ❌ **不需要**（`mklink /J` 成功，`IsInRole(Administrator)` = False）✅ |
| 通过 junction 读文件 | ✅ 正常 |
| 通过 junction **动态 import 模块** | ✅ 加载成功 |
| **模块内部的 `import.meta.url`** | ❌ **realpath 到真实路径**：`.../junction-test/v1/probe-mod.ts`，**不是** `.../current/probe-mod.ts` |
| `fs.realpathSync(junction 路径)` | 同样收敛到真实路径 |

**为什么这是硬伤**：本仓库**已经**为这个类别的分叉付出过代价，现有代码里有两套专门机制：

- `host/src/dev-watch.ts:169-171`：`// Realpath key space ... Without this, macOS (process.cwd() → /private/var realpath, mkdtemp → /var lexical) splits bindings and events into two keys`
- `host/src/dev-watch.ts:350-351`：`// Mixed lexical (chokidar event) vs realpath (binding root) keys are exactly the [bug]`
- `host/src/dev-reload.ts:123`：`// Both sides are matched in the realpath key space AND the lexical key space`
- `host/src/watch-path.ts:45-52`：`canonicalExistingPath`——"两个拼写指向同一目录"的统一键空间

⇒ R1 会让 **Entry 声明的路径**（`base/current/...`）与 **模块实际 URL**（`base/<version>/...`）永远处于两个空间，而 dev-reload 的 `require.cache` 失效、dev-watch 的 URL→Entry 映射都建立在这两个空间之上。**这是再把一个已知 bug 类别请回来**，代价远高于它省下的"改写 yml"。

### 4.0.2 修订推荐：**R3（base 不进 yml，由宿主按版本装配）**

| | R1 稳定入口指针 | R2 启动期迁移 | **R3 base 不进 yml**（改推） |
|---|---|---|---|
| 版本目录与回滚 | ✅ | ✅ | ✅ |
| 改写用户文件 | ❌ 不需要 | ✅ **每次升级都改** | ❌ 不需要 |
| 引入第二路径键空间 | ✅ **会（已实测）** | ❌ 不会 | ❌ **不会** |
| yml 里出现版本路径 | ✅ 会 | ✅ 会 | ❌ **不会** |
| 与 M2 管理面的契合 | 中 | 低 | ✅ **高**（M2-4 本来就要做 `ctx.plugins`） |

R3 下：`<用户目录>/base/<version>/` 由宿主代码直接装配条目（沿用 `index.ts:184` 现有的 `ctx.loader.create` 手法），**选哪个版本由宿主的一处状态决定**；**用户 yml 只存用户条目**。

代价（诚实记录）：base 的启停/配置不能靠改 yml 表达，需要一层"用户态覆盖 base"的机制——**但这层 M2 本来就要做**（`ctx.plugins` 管理面 + 启停即时生效），所以是复用而非新增。

> 注：R3 与"方案 C（拷入用户目录）"完全兼容——base 仍在用户目录、仍带版本、仍可回滚，只是**它的条目不由 yml 描述**。

### 4.1 定案布局（R3 形态）

```
<resource_dir>/                          # 随包；更新替换；可能只读
  host.exe                               # sidecar
  seed/
    cordis.json                          # ★ 用户层播种源（JSON；宿主 JSON.parse 后作 initial）
    base/<version>/plugins/<name>/       # 随包 base 内容（拷贝来源）

<用户目录>/                                # = config_dir()/VRCX-K
  cordis.yml                             # ★ 只存**用户条目**（首次由 seed/cordis.json 播种）
  base-state.json                        # ★ 宿主所有：当前 base 版本 + 对 base 的覆盖（启停/配置）
  base/<version>/plugins/<name>/         # 拷进来的 base（带版本，可回滚；**没有 current 指针**）
  plugins/<id>/<version>/                # 用户插件（M2-5）
  plugins/.staging/                      # 原子替换暂存区（M2-5）
```

- **base 条目由宿主代码装配**，路径用**真实的版本路径**（`base/<version>/plugins/<name>`）——因为 yml 里没有它，所以**路径过期问题不存在**
- **不需要 `current` 指针**（R3 的根本好处：不引入第二路径键空间）
- 首次运行：拷 `seed/base/<version>/` → `base/<version>/`，写 `base-state.json`，用 `seed/cordis.json` 作 `initial` 播种用户 yml
- 升级流程：拷 `base/<new>` → 校验 → **改 `base-state.json` 里的版本** → 重启宿主；旧版本目录保留 ⇒ 回滚 = 改回版本号
- base 的启停/配置：写在 `base-state.json`，由 `ctx.plugins` 表达（不是改 yml）

### 4.2 目录命名（本轮附加决定）

你要的形式是 `%APPDATA%/VRCX-K`。**这与 Tauri 默认不一致，必须显式偏离**：

| 事实 | 值 |
|---|---|
| Tauri `app_config_dir()` | `config_dir()/${bundle_identifier}`（`tauri-2.11.5/src/path/desktop.rs:238-242`） |
| 本仓库 `identifier` | `com.vrcxk.app`（`tauri.conf.json`） |
| 默认结果 | `%APPDATA%/com.vrcxk.app` —— **不是** `VRCX-K` |
| 取 `%APPDATA%/VRCX-K` 的做法 | 用 `config_dir().join("VRCX-K")`（**不用** `app_config_dir()`） |

**代价（必须记账）**：任何走 Tauri 默认的插件（如 `tauri-plugin-store`、日志类）会写到 `%APPDATA%/com.vrcxk.app`，与我们自建的目录**分叉**。⇒ 要么全项目统一禁用默认目录、一律走我们的解析器，**要么**接受两处目录并存并写进文档。

**另注**：`identifier` 同时是**通知 AUMID** 的来源（M1 #6 待复验项之一），**不能为了目录好看去改**。

**定案（本轮拍板）**：**接受分叉，但要求全项目统一走自建解析**。

⇒ 执行后果（写进约定，否则会漂移）：

1. 项目内**一律不调用** `app_config_dir()` / `app_data_dir()` / `app_local_data_dir()`；统一走一处解析器（`config_dir()/VRCX-K`、`local_data_dir()/VRCX-K` 等）。
2. 将来引入任何**自带存储**的 Tauri 插件（`tauri-plugin-store`、日志类等）时，**必须改它或包一层**，否则它会静默写到 `%APPDATA%/com.vrcxk.app`，形成第二处状态目录。
3. 建议加一条**测试/CI 守卫**：断言仓库源码中不出现 `app_config_dir|app_data_dir|app_local_data_dir` 的调用（照本项目已有的"源码扫描式守卫"习惯）。

### 4.3 壳与宿主的契约（新增）

宿主对 app 目录一无所知（§1.4），因此**壳在 spawn 时注入**（沿用现有 `VRCXK_*` 惯例）：

| 变量 | 含义 | dev 值 | packaged 值 |
|---|---|---|---|
| `VRCXK_SEED_DIR` | 随包**播种源**（`cordis.json` + `base/<version>/`） | `<repo>/host` | `resource_dir()/seed` |
| `VRCXK_USER_DIR` | **用户目录根**（真源 yml + `base/` + `plugins/`） | `<repo>/.temp/dev-user` | `config_dir()/VRCX-K` |
| `VRCXK_BASE_VERSION` | 随包 base 版本（决定拷哪个版本、切哪个指针） | 由仓库版本决定 | 打包时注入 |

宿主据此：

1. `Include.path = $VRCXK_USER_DIR/cordis.yml`（**只装用户条目**）
2. 首次运行：拷 `$VRCXK_SEED_DIR/base/<version>/` → `$VRCXK_USER_DIR/base/<version>/`，写 `base-state.json`（版本 + 覆盖），再用 `$VRCXK_SEED_DIR/cordis.json`（`JSON.parse` 后）作为 `initial` 播种用户 yml
3. **base 条目由宿主装配**：读 `base-state.json` 的版本 → 以 `<用户目录>/base/<version>/plugins/<name>` 的真实路径 `ctx.loader.create()`
4. 版本变化：拷新版本 → 校验 → **改 `base-state.json` 的版本** → 重启宿主；**不改写 yml、不建指针**

### 4.4 dev 态的同构

- dev 用上表的环境变量指到仓库内，**但仍走同一套"解析 + 拷贝 + 切指针"逻辑**
- ⚠ 若 dev 图省事改成"直接用仓库目录、跳过拷贝"，则 **M1 验收项"两态同一套解析"名存实亡**，且 base 版本装配与拷贝路径在 dev 下**完全不被覆盖**。ADR 要求 dev 也执行拷贝路径（哪怕源与目标都在本机）

### 4.5 与既有机制的衔接（不破坏）

- `VRCXK_HOST_BIN` / `VRCXK_HOST_DIR` 语义不变（仍是调试覆盖，优先级最高）；
- 现有 `bundled sidecar` 分支要求 `resource_dir/cordis.yml` ⇒ **改为要求 `resource_dir/seed/cordis.json`**（否则安装态依旧报错）；
- dev 分支（`HostLaunch::source()`）保持不变，只是多注入上面三个变量。

---

## 5. 已定与待定

### 5.1 本轮已定

| 项 | 决定 |
|---|---|
| 布局方案 | **方案 C**：首次运行把 base 拷进用户目录，之后只看用户目录 |
| base 版本化 | **带版本目录**（可回滚） |
| 版本路径过期机制 | **R3**：base **不进 yml**，由宿主按版本装配（R1 因引入第二路径键空间被**实测否决**，见 §4.0.1） |
| base 覆盖层位置 | **独立文件 `base-state.json`**（宿主所有；避免被 `Include.write()` 的整树写回污染） |
| 用户目录命名 | `%APPDATA%/VRCX-K`（`config_dir().join("VRCX-K")`，**非** Tauri 默认的 `app_config_dir()`） |
| 与 Tauri 默认目录的分叉 | **接受**，但**全项目统一走自建解析**（含禁用清单 + CI 守卫，见 §4.2） |
| Windows junction 可用性 | ✅ 实测无需管理员（**R3 已不需要它**，仅存档） |

### 5.2 仍需拍板

1. **`base/<version>/` 的保留策略**：永久保留所有版本，还是只留最近 N 个（磁盘 vs 回滚能力）。默认建议留最近 2 个 + 当前。
2. **`base-state.json` 的 schema**：版本号 + base 条目的启停/配置覆盖的具体形状——这块与 **M2-2 的 manifest 契约**高度相关，建议合并到 M2-2 一起定，不在此 ADR 预锁。
3. **Android 是否纳入本 ADR**：移动端 `externalBin: []`、宿主不本地运行（`mobile-feasibility.md`）。建议**显式声明移动端不适用**，避免布局规则被误推广。
4. **拷贝的原子性方案**（见 §7 第 7 条）：首次运行与升级的"半拷贝"如何检测与回滚，需在 M2-7 落地前定。

> 相关文档：[`cordis-runtime-findings.md`](cordis-runtime-findings.md)（Cordis 实测结论，本 ADR 的 §1.5 依赖其探针）、[`host-sessions.md`](host-sessions.md)（会话/设备管理需求）。


---

## 6. 对下游的影响

| 事项 | 影响 |
|---|---|
| **M1 packaged 收口** | 本 ADR 定了才能动 `tauri.conf.json` 的 `resources` 与 `build-host.ts` 产物布局（随包目录从"根下平铺"改为 `seed/`） |
| **M1 packaged 的安装态验证** | 新增一条必须覆盖的场景：**首次运行播种 + 拷贝 base + 装配 base 条目**（不只是"能 ready"） |
| **M2-7** | 使用 §4.1 的 `$VRCXK_USER_DIR/plugins/<id>/<version>/` 与 `.staging/`；并要**与 base 的版本机制共用一套原子替换原语** |
| **M2-5 市场 mock** | 暂存区落在 `$VRCXK_USER_DIR/plugins/.staging/` |
| **M2-8 manifest** | manifest 注册表按 `entry.id`；方案 C 下 base 与用户插件同在用户目录，**区分靠注册表而非路径**，与 ADR 一致 |
| **M5 分发与更新** | **升级流程直接由本 ADR 决定**：拷 `base/<new>` → 校验 → 改 `base-state.json` 版本 → 重启；旧版本目录保留供回滚。**这是 M5 的必经步骤，不是可选项** |
| **#6 复验** | AUMID/图标复验依赖安装态可用，即依赖本 ADR |
| **壳侧新增职责** | 壳要在 spawn 时注入 §4.3 的环境变量；**首次运行与版本升级时，拷 base 的动作由壳在 spawn 前完成**（否则宿主启动时用户目录还不完整）→ **壳与宿主的启动序要重新排** |
| **路径键空间** | R3 **不引入**第二个键空间（R1 会，已实测）——`dev-reload.ts` 的双键空间匹配、`watch-path.ts` 的 `canonicalExistingPath` **无需扩展** |

---

## 7. 未验证 / 遗留

**本轮已由探针关闭**（原列为未验证，现为实测，见 §1.5）：

- ~~`config.initial` 的确切类型~~ → **实测：数据结构，不是文本**（U1；原按源码推断的"字符串（yml 文本）"**是错的**）
- ~~`patches` 与 `write()` 的交互~~ → **实测：会被烘焙**（U3）
- ~~只读目录的静默 `readonly`~~ → **实测：静默置位，且写失败是未捕获异步异常**（U2）

**仍未验证**：

1. **`config_dir()`（平台基础目录）在各平台的实际值**未在本仓库实测；`%APPDATA%/VRCX-K` 的具体落点需在 Windows 上确认。
2. ~~Windows 上创建目录 junction 是否需要特殊权限~~ → **实测：不需要管理员**（§4.0.1）。**但 R3 已不使用指针，此项仅作存档**。macOS/Linux 的 symlink 未测（R3 亦不需要）。
3. **Windows 安装目录（含空格/非 ASCII 路径）下的 `resource_dir()` 行为**未实测。
4. **`ctx.baseUrl` 被 Include 改写**（`:37`）与宿主启动时设的 `process.cwd()` baseUrl（`index.ts:154`）之间的相互作用——在"yml 在用户目录、base 由宿主用真实版本路径装配"时是否符合预期，**未实测**。R3 下这一条尤其要紧：**base 条目不在 yml 里，所以它们不受 baseUrl 影响**，但用户条目仍受——需确认两类条目的解析互不干扰。
5. **同一套布局在 dev 态跑通**：环境变量注入 + 拷贝路径（§4.3/§4.4）未实现验证。
6. **`initial` 的边界**：文件存在但为空 / 内容非法时的行为未测（只测了"不存在"）。
7. **拷贝的原子性**：拷 `base/<version>/` 过程中断电/崩溃的半成品处理未设计（首次运行与升级都要考虑；`base-state.json` 的版本切换应在拷贝完成后才写）。
