# 插件源、索引与 manifest 设计（M2-2 × M2-5 共同底座）

> 状态：**契约已收敛，实现未开始**（2026-09-16 定稿；决策由 #18 逐条拍板，实测见 `docs/probes/probe11`–`probe19`）。
> 本文同时约束三处，因为它们是同一个决策链：
> - **#18（M2-2）**：插件 manifest 契约 —— 「插件是什么」
> - **#21（M2-5）**：市场安装流程 —— 「去哪取、怎么取」
> - **#23（M2-7）/ ADR**：目录布局落盘 —— 「取到哪、怎么落」
>
> 若三处各做一半，必然返工。**核心红线：我们只登记，不托管。**

---

## 0. 三条不可动摇的原则

这三条是本文所有条款的推导起点；后续任何设计若与它们冲突，冲突方是设计而非原则。

| # | 原则 | 出处 |
|---|---|---|
| **P1** | **不托管**：官方源只存索引，**不含任何插件字节**；字节在作者仓库 | 用户拍板 |
| **P2** | **不拦截**：声明可见、差异可见，但**不替用户拒绝**；用户自决 | 架构 §1.4 + M2-8「声明 + warn，不做拒绝」 |
| **P3** | **不做重复真源**：同一事实只存一处；可推导的**不手写** | VS Code 1.74 删除冗余声明；本仓库 M1-1 `accelerator` 教训 |

> **P3 的判据形式**（本文反复使用）：*若某字段的值可由别处推导或查询得到，则它不得被存储。*

---

## 1. 结论速览

| # | 决定 | 依据 |
|---|---|---|
| 1 | **索引 = 指针 + 展示缓存**，不含任何会因发版失效的东西 | §2.1 |
| 2 | **发新版本零 PR**：版本由 `isomorphic-git` 实时发现 | §4.2 / probe14 |
| 3 | **依赖声明不含 source**（照 npm） | §3.3 |
| 4 | **来源永远取用户当前优先级配置**（不锁 source） | §2.3 |
| 5 | **身份 = `id` + `version` + `author`**（元组；sha256 非必需） | §3.5 |
| 6 | **版本权威 = `manifest.version`**，tag 仅为发现手段 | §4.1 |
| 7 | **tag 约定 = `v{SEMVER}` / `{id}--v{SEMVER}`**，后缀字符集 `[0-9A-Za-z-]` | §4.3 / probe17 |
| 8 | **一致性校验 O(1)**：只在安装那一个版本时校验 | §4.4 |
| 9 | **强制 `.git` 后缀**（兼作判别式，省掉 `source.type`） | §2.2 / probe16 |
| 10 | **manifest 位于 `<path>/.vrcxk/manifest.json`** | §5.1 |
| 11 | **`services.required` 派生 cordis `inject`**（manifest 为权威） | §5.4 |
| 12 | **`type` 保留为官方封闭枚举**（功能类别轴） | §2.4 |
| 13 | **不加 `tier`**：`dlopen` 进程内，JS 层约束不了原生代码 | §6.1 / probe18 |
| 14 | **删 `insecure`**：带官方色彩，而 manifest 不受我们监管 | §6.2 |
| 15 | **子插件无 manifest 字段**：`ctx.plugin()` 子插件继承外层 entry | §5.3 / probe19 |
| 16 | **严格 JSON，不用 JSONC** | §5.5 |

---

## 2. 市场与源模型

### 2.1 索引条目的职责（P1 + P3）

**索引只回答两件事**：这是谁、去哪取。其余全是**缓存**。

| 内容 | 进索引？ | 理由 |
|---|---|---|
| **取件地址**（`source`） | ✅ **必须** | 索引**唯一**的权威内容——没有它什么都取不到 |
| 展示字段（`name`/`description`…） | ⚠️ 缓存 | 浏览时不能去拉 N 个作者仓库，必须镜像一份；**允许过期** |
| **版本** | ❌ | `listServerRefs` 实时发现（probe14） |
| `permissions` | ❌ | 装的时候读真 manifest，展示的是**即将安装那版**的权限 |
| `sha256` | ❌ | git commit SHA 是更好的身份（§3.5） |
| `dependencies` | ❌ | 同上；且来源由用户配置实时解析（§2.3） |

**⇒ 索引很薄，且过期无害** —— 这意味着**索引刷新节奏根本不重要**，不需要为其设计同步机制。

**唯一需要重发 PR 的情况**：`source` 或 `id` 变更（换仓库 / 改名）。这是低频且值得审核的事件。**日常发版不在其中。**

### 2.2 `source` 形态：2 个字段

```jsonc
"source": {
  "url": "https://github.com/me/vrcxk-plugins.git",   // 必填，强制 .git 后缀
  "path": "packages/friend-presence"                  // 可选，monorepo 子目录；缺省 = 仓库根
}
```

**没有 `type` 判别式**：`.git` 后缀本身就是判别式（P3）。将来若要支持非 git 源（直链 zip），判别依据现成。

**⚠ 隐式规则（必须实现，否则静默 404）**：`codeload` 不接受 `.git`（probe16 实测 404）。任何从 `url` 派生的地址（codeload / raw）**必须先剥后缀**。这应当收敛到**唯一一处**规范化函数，并加测试钉住——它是那种"忘了就 404"的静默失效。

### 2.3 多源与优先级（P2）

**用户可添加任意软件源**；官方源是其中一个，**享有同等待遇（可被上移/下移），但不可删除**。

```
设置：源优先级列表（上移/下移，热生效并持久化）
   ↓
安装/更新：按【当前】优先级解析 → {来源}/{id}@{版本}
   ↓
展示（义务）：逐条列出解析结果及其来源；同 id 在多个源命中时【全部列出】
   ↓
用户自行判断：不满意 → 取消安装 → 改优先级 → 重装
```

**关键：来源永远取当前配置，不锁定。** 否则会出现用户抱怨的「我明明配了加速镜像源，怎么更新还是这么慢」。

**⇒ 锁身份，不锁来源**（§3.5）。

### 2.4 官方分类 `type`（封闭枚举）

| 轴 | 表达者 | 例 |
|---|---|---|
| **运行形态** | `restartClass`（+ 将来 T2 runner） | 进程内 / 前端 / 子进程 |
| **功能类别** | **`type`** | 好友 / 通知 / UI / 工具 / 集成 |

两者是**不同的轴，都保留**。

`type` 取值（用户拍板）：`core` / `library` / `feature` / `ui` / `integration` / `tool`

- `core` —— 官方核心能力（登录 / DB / 连接）
- `library` —— 为其他插件提供功能（对齐 NoneBot 的 `library` 语义）
- `feature` —— 用户可见功能（好友 / 通知 / Feed）
- `ui` —— 界面扩展
- `integration` —— 第三方平台桥（Discord 等）
- `tool` —— 工具 / 实用

**为什么必须封闭**：自由标签不可靠（`工具`/`tools`/`utility` 各写各的）。**`type` 是唯一机器可靠的筛选轴。** 代价是改了要回填所有条目——所以**值要少而稳定**。

### 2.5 官方源 = 登记 + 审核，不是托管

| | 谁存字节 | 我们做什么 |
|---|---|---|
| **官方源** | **作者** | 收录时审核（人工）+ CI 校验格式 |
| **第三方源** | 作者 | 用户自建、自审 |

**"不托管"≠"不审核"** —— 审核的是**收录**，不是**代发**。

**必须显式钉死的红线**（否则容易被"顺手托管一下"破坏）：

1. 官方源仓库**不含任何插件字节**，只含索引 + 校验信息；CI 若收到插件源码 PR，**拒绝**。
2. 索引条目**必须**指向外部取件点。
3. **官方源不做镜像**：将来若做加速，加速的是**索引**，不是字节（字节是作者的）。
4. **明确告知作者**：文件的可获得性、可用性、被删除风险**由作者承担**（我们不托管 ⇒ 作者删库就是真的没了）。

### 2.6 已被否决的中间方案（防回归）

| 否决项 | 理由 |
|---|---|
| **官方托管插件** | 撞 P1 红线；且"我们发行的插件"与 base 插件无从区分 |
| **`source.type` 判别式** | `.git` 后缀已可判别（P3） |
| **`manifestPath` / 按主机猜 raw 路径** | 需要维护一张**永远不全**的主机适配表（GitHub/GitLab/Gitea 各不相同） |
| **`asset` 字段 + `/releases/latest/download/`** | `latest` 是**仓库级**解析（实测 302 到错版本，多资产必错配）；且它只覆盖 GitHub |
| **要求作者每次发版提 PR** | 撞 P3；且 §4.2 已解决版本发现 |
| **lockfile / 锁定 source** | 撞"加速镜像"场景（§2.3） |
| **jsDelivr 作为主路径** | GitHub-only；且版本列表**去掉 `v` 前缀**，与 git 不一致 |
| **要求用户安装 git / 捆绑 git 本体** | 前者不可接受；后者 git 是 **GPLv2**，撞许可证红线 |
| **Atom feed 作为版本来源** | 跨主机可用（✅）但**给不出 tag 的 commit SHA**（实测 0/5，里面是 release notes 的普通 commit 链接），且截断至 10 条 |
| **`git archive --remote`** | GitHub/GitLab **均 422/404**（服务端未开 `upload-archive`） |

---

## 3. 依赖与身份

### 3.1 依赖解析的三个阶段

```
声明（manifest，作者写）      解析（安装时，宿主做）        展示（义务）
"dependencies": {            按【当前】源优先级             {来源}/{id}@{版本}
  "audit-logger": "*",         取首个命中                   逐条列出 + 传递依赖
  "secrets-vault": "~2.1.0"   ↓                            ↓
}                             解析结果                    用户自行判断 → 取消 / 改优先级 / 重装
```

### 3.2 **依赖声明不含 source**（P3）

```jsonc
// ✅ 正确（照 npm：dependencies 只映射 名字 → 版本范围）
"dependencies": { "secrets-vault": "~2.1.0" }

// ❌ 错误：作者无从知道用户配了哪些源
"dependencies": [{ "name": "secrets-vault", "source": "some-source" }]
```

**先例**：
- **npm**：`dependencies` 只映射 name → version range；registry 由用户配置决定
- **Cargo**：`registry = "my-registry"` 引用的名字**必须在用户 `.cargo/config.toml` 里已定义**——作者引用的是"用户侧已存在的键名"，不是他能凭空发明的源

### 3.3 传递依赖也必须展示

Y 依赖 Z，Z 又依赖 W ⇒ 展示**完整安装计划**（所有将被拉进来的条目 + 各自来源）。否则用户批准的 `A/Z@1.2` 之下，**W 仍可能从别处来**。

### 3.4 歧义处理（P2）

同一 `id` 在多个源命中时：**全部列出**，不静默取一个。这不是拦截，是**展示义务**的一部分。

### 3.5 身份元组

**锁身份，不锁来源**：

| 字段 | 作用 | 缺失时 |
|---|---|---|
| `id` | 主键 | — |
| `version` | 版本 | — |
| `author` | **变更探测器** | **必填**（见下） |
| `repository` | 身份佐证 | 降级为无信号 |
| `sha256` | 精确比对 | **不要求**（非所有源类型都有） |

- **`author` 是变更探测器，不是认证器**——它自己声明、可被冒用。**在我们这里不构成问题**，因为按 P2 我们**不拦截**；它要扛的是常见情形（同名不同物 / 插件易主）。
- **`author` 因此必须必填**：否则"没有 author"会退化成说不清含义的状态（作者没写？还是源没这字段？），而我们不能用拦截解决。
- **`sha256` 非必需**：Claude Code 的 `archive` 源是 `sha256?`（可选），`github` 源是 `ref?, sha?`；Thunderstore / HA 的 manifest **压根没有校验和字段**。⇒ 有则用于精确比对，无则不要求。

**比对规则**：同 `id` 下，`author` / `repository` 变了 ⇒ **提示**；`sha256` 有则用（把提示变精确）。**一律展示，不拦截。**

### 3.6 ✅ 可替换性（第三方顶掉 base 的实现）

**目标**：让第三方插件能**顶掉** base 包里某个实现的位置。这是**架构属性**，不是功能——功能可以后加，架构属性后加的代价是重写。

**关键判断：今天要做的不是"实现替换机制"，而是"别让顺手的决定把路堵死"。**

替换机制本身**没有可测试对象**（第三方实现今天不存在）。而**会杀死可替换性的写法**今天都很自然，因此现在就要挡住：

| 会堵死可替换性的写法 | 为什么致命 |
|---|---|
| 依赖写**插件 id**（`base-storage`） | 第三方顶掉后，依赖方**找不到** |
| 直接 `ctx.plugin(storageImpl)` 硬装配 | 绕过服务层，**写死实现** |
| 服务名**暗示实现**（`storageImpl` / `baseStorage`） | 这种名字**只能被那一个实现满足** |
| `implements` 声明**与实际 `provide` 漂移** | 服务注册表不准 ⇒ 解析不到 |

### 3.6.1 已落地的三条约束（今天可验证）

**① `dependencies` 的键**：**插件 id 或服务名都接受**

```jsonc
"dependencies": {
  "base-storage": "^1.0",   // 插件 id（kebab-case）
  "storage": "^1.0"          // 服务名（camelCase）—— 可替换性靠这个写法
}
```

- v0 **解析仍按插件 id**（服务解析未实现）
- **但现在就放行服务名拼写** ⇒ 将来加第三方实现时，**不需要改任何已有 manifest**

**② 服务名不得暗示实现**（schema 硬约束）

拒绝：尾随 `Impl` / `Implementation`（`storageImpl`）、第一方前缀（`baseStorage` / `coreStorage` / `vrcxkStorage` / `officialStorage`）。
要求**首字母小写** —— 使 camelCase 服务名**永不与 kebab-case 插件 id 混淆**。

> 理由：`storage` 可被任意提供者满足；`baseStorage` 把某一个实现烙进每个依赖方的声明里。

**③ `implements` 必须真的被 provide**（契约测试）

服务清单**单一来源**于 `host/src/contracts/capabilityInventory.ts`，并由两个测试从两侧钉住：

```
capabilityInventory.ts  ──┬─→ swap-ability-contract.test.ts      断言 schema 枚举 == 清单
                          └─→ capability-surfaces.test.ts        断言清单 == 真实运行时
```

⇒ **清单本身不是第三份副本**：任一侧改动而另一侧没跟，测试立刻红。

**已实测的四个守卫**（都能在对应破坏下正确变红，非安慰剂）：

| 破坏 | 结果 |
|---|---|
| 清单里加一个宿主不提供的服务 | ✅ 变红 |
| schema 偷偷改一个 permission 键 | ✅ 变红 |
| schema 偷偷加一个 shell 子域 | ✅ 变红 |
| 清单里删一个 shell 子域 | ✅ 变红 |

### 3.6.2 今天的边界（诚实标注）

- **服务解析未实现**：写服务名**合法但不生效**，v0 仍按插件 id 解析
- **冲突语义未定**：两个插件都 `provide("storage")` 时怎么办（拒绝后者 / 警告并让后者生效 / 需显式配置）——**留到真有第二个实现时定**
- **"顶掉"的落点已在 ADR**：`base-state.json` 本就负责 base 的启停覆盖 ⇒ **停用 base 的实现 + 加载第三方的** = 替换。**不需要新的架构层**

> **这条为什么现在写**：典型的"不写就会在半年后返工"。将来有人加依赖时会顺手写插件 id，而**没人记得那会让第三方替换失效**。

---

## 4. 版本与 tag

### 4.1 权威归属（用户拍板修正）

| 职责 | 归属 | 依据 |
|---|---|---|
| **权威版本号** | `manifest.version`（semver） | Claude Code 解析顺序：`plugin.json` **优先于** marketplace 条目，commit SHA 只是兜底 |
| **发现 / 排序 / 范围匹配** | **tag 名（semver）** | 一次 `listServerRefs`，零解包（probe14） |
| **可复现 pin** | **commit SHA** | tag 可变（可 force-push），SHA 不可变 |

**⚠ 重要修正（本轮）**：早期方案要求"每个 tag 都校验与 manifest 一致"，那会导致 **O(tags) 次读取**——要么读 206 次 manifest，要么解包 206 次。

⇒ **tag 名本身就是 semver** 之后，排序/比对/范围匹配**无需读任何文件**；一致性校验**推迟到安装那一个版本时做（O(1)）**。

### 4.2 版本发现（P3）

**一次调用，零下载，零解包**：

```ts
const refs = await git.listServerRefs({
  http,
  url,
  prefix: "refs/tags/",
  protocolVersion: 1,        // ⚠ 见 §4.5
})
// → [{ ref: "refs/tags/v9.9.0", oid: "26d121ea…" }, ...]
```

实测：GitHub **206** tags / GitLab **162** / Codeberg **300**，**全部带 40 位 commit SHA**（probe14）。

### 4.3 tag 命名约定

```
v{SEMVER}                    # 单插件仓库        例: v1.2.0
{id}--v{SEMVER}              # monorepo 多插件    例: friend-presence--v1.2.0
```

- `{id}` 前缀使**一个仓库可承载多个插件、各自独立版本线**（Claude Code 同款设计）
- **解析**：取最后一个 `--v` 之后的部分

**`{SEMVER}` 的约束（probe17 实测）**：

| 规则 | 值 |
|---|---|
| 预发布标识符字符集 | **`[0-9A-Za-z-]`** |
| **下划线 `_`** | ❌ **不合法**（semver 规范不允许） |
| 预发布段长度上限 | **24**（本仓库**约定**，非规范；semver 本身不限长） |
| 允许示例 | `alpha` / `beta` / `muggle` / `rc.1` / `alpha-1` / `ALPHA` |

**为什么必须用标准 semver**：允许 `_` 就等于"tag 里的版本段不是标准 semver"，于是**任何 semver 库都不能用**，必须自写比较器——而手写 semver 排序是经典 bug 温床（数字段按数值比、字母段按字典序、数字<字母、段数少者优先）。**为一个下划线放弃整个成熟生态不划算。**

**两条必须写明**：

1. **不符合约定的 tag 一律忽略**（如 `stable` / `nightly`）——实测 lazy.nvim 就有个 `stable` tag，**它不是版本**。不忽略会让排序炸掉。
2. **大小写敏感且反直觉**：`1.2.0-ALPHA` < `1.2.0-alpha`（大写 ASCII 值更小）。⇒ **契约规定：预发布标识一律小写**。
   **不是"建议"而是**：**契约层不强制**（强制会拒绝合法 semver，而合法 tag 不该被无理由拒），但 **#19 的脚手架与校验 CLI 应在生成/校验时提示并自动转小写**。
   ⇒ 作用点：**契约放行、工具规劝** —— 这样既不拒绝合法输入，又能让绝大多数 tag 落在同一个可预测的排序上。

**预发布语义（实测，语言层保证，无需自实现）**：

| 行为 | 结果 |
|---|---|
| 预发布 **先于**正式版 | `1.2.0-muggle < 1.2.0` ✅ |
| 预发布之间按字典序 | `alpha < beta < muggle` ✅ |
| **默认范围排除预发布** | `satisfies("2.0.0-beta.1", "^2.0.0")` → **false** ✅ |

⇒ **默认用户不会收到 beta**，除非显式 opt-in（`^2.0.0-0`）。**这正是"预发布通道"的正确语义，且是免费的。**

### 4.4 一致性校验（O(1)）

**不变量**：`tag v1.2.0` ⇔ `manifest.version === "1.2.0"` ⇔ `plugins/<id>/1.2.0/`

**校验时机**：**仅安装/更新那一个版本时**，读一次 `<path>/.vrcxk/manifest.json`，比对 tag 的 semver。不符 = **硬错误**。

**好处**：作者忘了 bump 版本就发 tag ⇒ **立刻暴露**，而不是静默装上错版本。

**⚠ 副作用（必须处理）**：错误会以"安装报错"的形式落到**用户**身上，而非作者。⇒ **版本一致性校验必须成为 CLI 的一部分**（对应 Claude Code 的 `claude plugin tag`）——这是 **#19 脚手架的职责**，也是 #18 与 #19 的握手点之一。

### 4.5 ⚠ `protocolVersion: 1` 是必须的（probe14）

```
listServerRefs 默认 protocolVersion v2:
  GitHub  → OK
  GitLab  → 422 Unprocessable Entity      ← 默认值下"跨主机"是【假的】
protocolVersion: 1:
  GitHub  → OK (206)
  GitLab  → OK (162)
  Codeberg→ OK (300)
```

**⇒ 必须显式 pin `protocolVersion: 1`。** 否则 GitHub 上测试全绿、一上 GitLab 就炸——典型的"只在部分主机暴露"的坑。

### 4.5.1 ⚠ `isomorphic-git` 的其余静默陷阱（probe15 / probe16 / probe17）

同一类错误：**传错参数不报错，只是结果为空或语义变了**。

| 陷阱 | 症状 | 正确做法 |
|---|---|---|
| `listFiles({ oid })` | **静默返回 `[]`** ——让人误以为仓库是空的 | `listFiles` 要的是 **`ref`**；`readBlob` 要的才是 **`oid`**（probe15） |
| `codeload` 地址 | **404** | codeload **不接受 `.git` 后缀**，而 `source.url` 强制以 `.git` 结尾 ⇒ 任何从 url 派生的地址必须先剥后缀，**收敛到唯一一处规范化函数**（probe16） |
| `_` 作 semver 预发布字符 | 任意 semver 库都用不了 | **`_` 不是合法 semver 字符**，字符集是 `[0-9A-Za-z-]`。若允许下划线就必须自写比较器（probe17） |


### 4.6 取件与落盘（摘要）

| 场景 | 手段 |
|---|---|
| 列 tag / 拿 SHA | `listServerRefs`（§4.2） |
| 预览 manifest | 取该版本的树 → 读 `<path>/.vrcxk/manifest.json`（**单次**） |
| 安装 | 取整包或**仅子目录**（probe15：138 文件仓库只落盘 28 个） |
| 落盘 | ADR 布局 `plugins/<id>/<version>/`；**`<version>` 来源 = `manifest.version`**（已被 §4.4 校验） |

**monorepo 支持已实测**（probe15，`cordiverse/cordis`）：一次 clone 枚举 **9 个包** → 读深层 manifest **无需 checkout** → **仅落盘子目录**。

---

## 5. manifest 契约（#18 主体）

### 5.1 位置

```
<source.path>/.vrcxk/manifest.json
```

- `source.path` 缺省 = 仓库根
- **专属目录**而非 `<path>/manifest.json`：我们读的是**别人仓库**里的文件，而 `manifest.json` 被 **Chrome / Home Assistant / Thunderstore / VS Code** 占用——**撞名时我们无法区分**。Claude Code 用 `.claude-plugin/plugin.json` 正是同一考虑。
- 目录名留宽（将来可放签名、子资源声明）
- 位置**可推导** ⇒ **不需要 `manifestPath` 字段**

### 5.1.1 base 插件的位置：`packages/base-*/`

base 包（我们自己的插件）**与第三方插件同形**：

```
packages/base-heartbeat/
├── package.json                workspace 成员
├── .vrcxk/manifest.json        同一份契约
├── src/index.ts
└── test/*.test.ts              自带的测试
```

**为什么不是 `host/plugins/`**：那里的一个 `.ts` 文件**没地方放 manifest**，于是宿主就得对 base 包**特判**——而特判正是让规则漂移的起点。放 `packages/base-*` 后，base 与第三方走**完全相同的契约与校验**。

**接线**（已落地）：`workspaces` 加 `packages/*`；`test:packages` 接入 `bun run test`；`tsconfig.packages.json` 接入 `typecheck`。

> ⚠ **已知的临时重复（必须记账）**：`host/plugins/heartbeat.ts`（宿主启动实际依赖，`cordis.yml` 指向它）与新样板 `packages/base-heartbeat` **当前同时存在**。
> **切换是 #23 的工作**，因为它需要 ADR R3 的「base 条目由宿主按 `base-state.json` 装配」——而那个还没实现。
> `packages/base-heartbeat` 现在的角色是**建立包形态的样板**，**不是接管启动**。谁要删其中一份，先读 #23。

### 5.1.2 `platforms` 与 `arch` 是**两条轴**

```jsonc
"platforms": ["windows", "linux"],   // OS：三值，粗
"arch": ["x64", "arm64"]             // 架构：可选，缺省 = 全架构
```

**为什么不合并成六值**（`win32-x64` 那种）：一个值里塞两件事，于是**每条 manifest 都得把两者一起重复**。

**为什么必须有 `arch`**：`platforms: ["windows"]` **区分不了 x64 与 arm64**。带 x64 原生库的插件在 arm64 Windows 上会被判为兼容 ⇒ **装上、加载时才崩**。这正是本字段要防的事。

**判定已实现**：`host/src/contracts/platform.ts` 的 `checkPlatformCompatibility()`，规则：
- 未声明 ⇒ 纯 JS ⇒ 全平台兼容
- 不认识的宿主（`freebsd` / `ia32`）⇒ **判定为不兼容**（而非默认匹配——那会掩盖打包错误）

> ⚠ **值域与宿主矩阵的落差**：`build-host.ts` 定义 6 个编译目标，CI **只验证 3 个**（windows-x64 / linux-x64 / macos-arm64）。`win32-arm64` / `linux-arm64` / `darwin-x64` **造得出但没测过**。声明了这三个的插件今天**没有验证过的宿主**。

### 5.2 字段全表

**必填 4 个**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | string | `^[a-z0-9][a-z0-9-]*$`，≤64 | **必须与索引条目一致** |
| `version` | string | **semver.org 官方正则**，≤128 | **权威版本**；须等于对应 tag 的版本段（§4.4） |
| `author` | string | 1–64 | 身份元组（§3.5） |
| `name` | string | 1–128 | 展示名（权威值；索引那份是缓存） |

**可选 —— 展示**：`description`(≤512) / `repository` / `homepage` / `license`(≤64)

**可选 —— 运行语义**：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `platforms` | `enum[]`（≤6） | 全平台 | **封闭枚举，Node 语义**（见下） |
| `restartClass` | `enum` | `restartable` | **变更如何生效**（见 §5.6） |

⚠ **`platforms` 必须是 Node 语义，不是 Rust triple、不是 bun target**：

```
✅ win32-x64 / win32-arm64 / linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64
❌ windows-x64          （bun compile target 拼法）
❌ x86_64-pc-windows-msvc  （Rust triple）
❌ macos-arm64
```

因为运行时检查就是 `process.platform + '-' + process.arch`。**写错就永远匹配不上**——契约测试已钉住这四种拼法。

**可选 —— 依赖与服务**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `dependencies` | `{id: range}`（≤64 项） | **不含 source**（§3.2） |
| `services.required` | `ServiceName[]` | **就绪门**：未满足则不自加载 |
| `services.optional` | `ServiceName[]` | 有则用，无则降级 |
| `services.implements` | `ServiceName[]` | 我**提供**的服务名（暂仅展示） |

**可选 —— 能力声明**：`permissions`（§9.1）

**可选 —— 前端（M3）**：`frontend.entry` / `frontend.slots`

**最小合法 manifest**：
```json
{ "id": "x", "version": "1.0.0", "author": "me", "name": "X" }
```

**完整示例**：

```jsonc
{
  "id": "friend-presence",
  "version": "1.2.0",
  "author": "me",
  "name": "好友在线状态",
  "description": "追踪好友上下线与位置变化",
  "repository": "https://github.com/me/vrcxk-plugins",
  "homepage": "https://github.com/me/vrcxk-plugins#readme",
  "license": "MIT",
  "platforms": ["win32-x64", "linux-x64", "darwin-arm64"],
  "restartClass": "restartable",
  "dependencies": { "audit-logger": "*", "secrets-vault": "~2.1.0" },
  "services": { "required": ["notify"], "optional": ["dialog"], "implements": ["friendPresence"] },
  "permissions": { "shell": ["window", "path"], "notify": true, "dialog": true },
  "frontend": { "entry": "ui/index.js", "slots": ["dashboard.widget"] }
}
```

**契约文件**：`contracts/plugin-manifest/v1/plugin-manifest.schema.json`
**TS 镜像**：`host/src/contracts/pluginManifest.generated.ts`（json2ts）
**校验/注册表**：`host/src/contracts/pluginContract.ts` / `pluginRegistry.ts`
**契约测试**：`host/tests/plugin-manifest-contract.test.ts`（24 项）

**索引条目示例**：

```jsonc
{
  "id": "friend-presence",
  "type": "feature",
  "source": {
    "url": "https://github.com/me/vrcxk-plugins.git",
    "path": "packages/friend-presence"
  },
  "name": "好友在线状态",
  "description": "追踪好友上下线与位置变化，支持位置历史查询",
  "author": "me",
  "repository": "https://github.com/me/vrcxk-plugins",
  "homepage": "https://github.com/me/vrcxk-plugins#readme",
  "license": "MIT",
  "tags": [{ "label": "好友", "color": "#ea5252" }, { "label": "状态" }]
}
```

**契约文件**：`contracts/plugin-index/v1/plugin-index-entry.schema.json`
**TS 镜像**：`host/src/contracts/pluginIndexEntry.generated.ts`

### 5.2.1 ⚠ 路径正则的**已知边界**（不能只靠正则）

`source.path` 与 `frontend.entry` 共用一个防逃逸正则：

```
^(?!/)(?!.*(^|/)\.\.(/|$)).+$
```

它挡住了全部字面 `..` 形态（**含尾随 `..`**——早期版本漏了这一种，由 `probe20.ts` 抓出：`..` 与 `ui/..` 曾能通过）。

**但它挡不住这些**（`probe20.ts` 明确记录为 known limitation）：

| 形态 | 例 |
|---|---|
| 百分号编码 | `ui/%2e%2e/x.js`、`..%2foutside.js` |
| Windows 盘符 | `C:/abs.js` |
| UNC 路径 | `\\server\share\x.js` |

⇒ **正则只是第一道**。真正落实containment 的是**解析之后**再检查结果是否仍在插件目录内（Claude Code 同款：报 `path escapes plugin directory`）。
**不要把 schema 校验当成 containment 保证。**

### 5.3 子插件：**manifest 无任何相关字段**（probe19）

**实测**（probe19）：

```
nested(父)      entryId = "65b4ad00:nested"
├ namedSub      entryId = "65b4ad00:nested"   ← 继承，无独立 id
├ anonArrow     entryId = "65b4ad00:nested"
└ objectLiteral entryId = "65b4ad00:nested"
```

⇒ **`ctx.plugin()` 的子插件继承外层 entry，没有自己的 entry。** 而 manifest 是**按 `entry.id` 建注册表**的 ⇒ **子插件不可能有自己的 manifest**。

**因此**：

- 包内 `ctx.plugin()` 装配的**是"子模块"，不是"子插件"** —— 共享主包身份、同一份 manifest、同一个启停开关
- **需要独立性的拆分，用 `source.path` + 独立 tag 表达**（§4.3）—— 那是**多个插件**，不是子插件

**⇒ manifest 不需要"子插件入口清单"**：那会是**双真源**（`ctx.plugin()` 已写一遍），且**要改造 loader** 才能让子插件拿到 entry，且**无收益**（用户看不到独立开关）。

**⚠ 已知代价（必须记档）**：probe8/probe19 实测子插件身份会**塌缩到外层 entry** ⇒ 越权 warn **只能报到主包，报不出是哪个子插件**。这是"不暴露子插件"的代价。

### 5.4 `services.required` 派生 cordis `inject`（用户拍板 = 选项 A）

**问题**：同一事实存两处（cordis `inject` 与 manifest `services.required`）—— 撞 P3。

**决定**：**manifest 为权威**；宿主读 `services.required` **代为**设置 Entry `inject`（**单向派生，无漂移**）。

**可行性已取证**：`EntryOptions` **含 `inject` 字段**（`plugin-loader/lib/config/entry.d.ts`），而 `host/src/index.ts:193` 正是用 `ctx.loader.create({...})` 装载 ⇒ **宿主能在装载时注入**。

**为什么是 A 而非 B**：我们已决定 **manifest 是权威**（版本、依赖、权限都从它来）。若 `services` 例外，就出现"一部分权威在文件、一部分在代码"的分裂。且 **VS Code 1.74 已公开删除同类冗余声明**（原文 *"tedious and error-prone"*）。

### 5.5 严格 JSON，不用 JSONC（用户拍板）

**实测**：`Bun.JSONC.parse` 存在、支持注释与尾随逗号、**compile 态可用**、**零依赖**（probe 记录见下）。

**仍然决议不用**：

| 理由 | 说明 |
|---|---|
| **1. 契约已是严格 JSON** | `contracts/*.schema.json` 全部严格 JSON；两种方言并存会分裂工具链 |
| **2. 工具链默认严格 JSON** | `JSON.parse` / AJV / `json-schema-to-typescript` / 编辑器；用 JSONC ⇒ 每条读取路径都要记得换解析器 |
| **3. 读取点有四处** | 索引 CI / 宿主装载 / #19 脚手架 / 将来市场 —— **每处都要用 `Bun.JSONC`** |
| **4. `Bun.` 是 bun 专属** | 架构 §3.3 保留 **Node 24 备降路径** ⇒ 用它会让备降路径失效或需另找解析器 |

**分界线 = 配置文件 vs 契约文件**：

- **用户手写配置** → YAML（`cordis.yml` 已是；注释在那里是真需求）
- **机器交换契约** → **严格 JSON**

**若将来真需要注释**：严格 JSON 是 JSONC 的**子集** ⇒ **先严格后放宽是安全的方向**（反过来不行）。

**⚠ 于是"给字段加说明"只有两条合法路径**（都实测过）：

| 手段 | 说明 |
|---|---|
| ✅ **`$schema` 字段** | manifest 允许一个 `$schema`，指向契约的 `$id`。**仅供编辑器补全/校验，加载时忽略**（Claude Code 同款）。字段解释由 schema 的 `description` 提供 |
| ✅ **文档逐字段解释** | 放在示例插件旁边的 `README.md` 里 |

**❌ 不要用约定键绕过**：实测 `{"//": "注释"}` 与 `{"_comment": "x"}` **都会被 schema 拒绝**——契约是 `additionalProperties: false`，约定键就是非法字段。这看起来像"给 JSON 加注释的土办法"，但在这里它是**错误**。

> 实测：`validatePluginManifest({...base, "$schema": "…"})` → `true`；同形下 `{"//": …}` 与 `{"_comment": …}` → `false`。

### 5.6 `restartClass`：变更如何生效（用户强调其重要性）

| 值 | 宿主动作 | **作者义务（SDK 硬约束）** |
|---|---|---|
| `restartable`（默认） | sidecar 重启 + 自动重连 | 无 |
| `frontend` | entry 广播 + WebView 重载，**不重启后端** | 前端资源须可独立重载 |
| `background` | 插件级 refresh（配置变更）/ 滚动替换（升级） | **必须实现 refresh 契约 + 断线重连 + 状态可恢复** |

**它不是"分类标签"，而是"告诉宿主这次变更怎么才能生效"** —— 没有它，宿主装完一个 UI 插件也会去重启整个 sidecar，**用户白等一次重启**。

**关键**：后两档都**给作者施加了义务**，而不只是声明一个类别 ⇒ **义务必须写进 #19 的脚手架与文档**，否则字段会被当成随手填的标签。

**风险**：作者声明 `background` 但**没有真的实现 refresh 契约** ⇒ 宿主不重启它 ⇒ **配置变更静默不生效**（用户会以为宿主坏了）。

**v0 收敛**：架构 §2.2 类别三的滚动替换**要 M4 的 C 类子进程 runner**。⇒ **v0 只接受 `restartable`**，其余值**报错**（而**不是静默降级**——降级是静默行为，撞"失败必须可归因"）。M3 开 `frontend`，M4 开 `background`。**schema 不用改，只是校验放宽。**

### 5.7 `platforms`：为什么它可留而 `tier` 不可

| | 可验证？ | 结论 |
|---|---|---|
| **`platforms`** | ✅ 装载时**真能检查**当前平台在不在列表里 | **留** |
| **`tier`** | ❌ **无法执行**（§6.1） | **不加** |

`platforms` **不涉及信任分级**，是**唯一一个我们既能验证、又不承诺做不到的事**的技术约束。

**缺省 = 全平台**（纯 JS，绝大多数不用写）。**用允许列表而非排除列表**：原生库**默认不信任能跨平台**。

**⚠ 它表达的是"插件的原生部分能在哪些宿主平台上加载"，不是"插件能跑在哪些端"。** **手机不在其中**——`mobile-feasibility.md` 已定案：手机 = **脸 + 手**，**脑留在桌面/服务器** ⇒ **手机上不跑插件**。

**宿主平台矩阵现状**：`build-host.ts` 定义 **6 个**，CI **实际验证 3 个**（windows-x64 / linux-x64 / **macos-arm64**）⇒ `darwin-x64` / `win32-arm64` / `linux-arm64` **编得出来但没人测过**。

### 5.8 前端扩展协议（分层已定；**能力形状待确认**）

> **为什么现在就定**：issue 的任务**不是按时间线隔离的**——前端要早写，协议就得早定。
> 此事原被误判为"M3 的事、以后再说"，**该判断是错的**。
>
> **⚠ 本节成熟度标注（诚实交代）**：下面区分**用户已拍板**与**captain 起草待确认**两部分。
> 起草原意是给出一个可讨论的具体形状，**不是替用户做决定**。

**三层职责**（**已认同**）——前端**不直接**接触数据库；数据库**不知道**前端存在：

```
① storage 插件   提供「某表变了」的原始信号          ← 数据层，引擎相关，可替换
② 业务插件       订阅①，决定「这对业务意味着什么」    ← 插件回调（不是前端订阅数据库）
③ 前端订阅       按 topic 收事件，自己决定怎么重绘    ← 经已有 kkrpc/ws 通道
```

**核心判断**：**不该由数据层直接通知前端**。数据层只说"变了"，**别人怎么用与它无关**。由此：
- `storage` 换实现（如将来接 PG 后端）时，②③**完全不用改**
- 前端**不需要知道**数据库结构

**✅ 用户已拍板的两条**：

| 决策 | 内容 |
|---|---|
| **topic 支持通配** | `subscribe("friend:*")` 可收 `friend:changed` / `friend:online`。**实现不难，故直接支持**（用户语）；不因为"可以后加"而先砍掉 |
| **不积压，断开即丢** | **无订阅者时不缓存、不补发**。事件是"提示"而非"数据"，前端重连后**自己重拉一次**即可 |

> **要在代码里留两行注释说明"为什么不积压"**（用户明确要求）：读者看到"丢了"会以为是 bug，注释须说明这是**有意的**——事件可重放（重拉即可），而缓存会引入"该丢哪些、丢多少"的策略问题，**收益不抵复杂度**。

**⚠ 以下为 captain 起草、待用户确认**（形状可按需改，不影响上面两条决策）：

```ts
// 插件侧（形如 ctx.notify 的领域服务）
ctx.frontend.emit(topic: string, payload: unknown): void

// 前端侧（经已有 kkrpc/ws；宿主在 hostWsAPI 上 expose）
subscribe(topic: string): Promise<{ ok: boolean }>
unsubscribe(topic: string): Promise<{ ok: boolean }>
```

```jsonc
// 推送报文
{
  "topic": "friend:changed",   // 订阅时用的同一个
  "plugin": "friend-presence", // 哪个插件发的（归因；只展示，不拦）
  "payload": { },              // 插件自定义，结构自由
  "at": 1737000000000          // 时间戳
}
```

**为什么这是"只差定义"**：机制全在——

| 需要的东西 | 现状 |
|---|---|
| 双向通道 | ✅ `kkrpc/ws`（架构已定"双向"），`host/src/ws.ts` 已跑 |
| 宿主暴露面 | ✅ `hostWsAPI` + `expose()` 已存在，加两个方法即可 |
| 插件能力面 | ✅ `ctx.*` 领域服务模式已就绪（`capability.ts`） |
| 声明 | ✅ manifest 的 `frontend` 字段（现为 M3 占位） |

**与旧工程的关系**（勘察结论已转正至 [`docs/legacy-recon/`](legacy-recon/)，先读其 [README](legacy-recon/README.md) 的两条红线）：

| | 旧工程 `onTableChange` | **我们** |
|---|---|---|
| 粒度 | **表级**（`onTableChange(表名, cb)`） | **topic 级**（插件自定义，可细到 id） |
| 消费方 | 状态层（`stores/*`）—— **单体应用，无插件边界** | **插件** + 前端（**有边界**） |
| 订阅即启停 | ✅ 有（为省数据库轮询开销） | ❌ **不需要**（插件 emit 是主动行为，非轮询） |

⇒ **旧工程没有"插件边界"这个问题**（状态层与数据库同进程，直接 import）。**我们的分层是新的**，所以协议也是新的——但**两者结论一致：数据层不该直接通知 UI**。

> 出处：`docs/legacy-recon/01-interface-contract.md`（`onTableChange` 详述）与 `00-SUMMARY.md`。

**⚠ 前端代码注入：记录三条事实差异（不拦截）**

本设计**不限制**插件能力（P2：声明 + 展示，**不拦截**——这是既定设计目标，不是疏漏）。但若将来做"插件往前端注入代码"，有三条**事实**值得记档：

| # | 事实 | 影响面 |
|---|---|---|
| 1 | 后端插件经 `ctx.*` ⇒ **可归因**（`Service` + `symbols.caller`）；**前端注入的代码**直接调 Tauri IPC ⇒ **不可归因** | M2-8（#24）的越权 warn 对前端插件失效 |
| 2 | **爆炸半径不同**：后端插件崩了不拖垮宿主（已做隔离）；**前端注入的代码崩了会拖垮 UI** | 架构 §1.4 的隔离覆盖不到这个向量 |
| 3 | 插件 API 会有**两个面**（`ctx.*` 与裸 `invoke()`） | 纯 DX 问题 |

⇒ **不拦**（那是设计目标）。但这三条应写进**作者文档**——让作者与用户**知情**，而不是靠我们设卡。

---

## 6. 两条被否决的字段（含实测依据）

### 6.1 不加 `tier`（T0/T1/T2）—— probe18

架构 §1.4 的三级信任把「带 dll/原生」等同于「需独立受管子进程」。**但 `dlopen` 是进程内的**：

```
probe18 实测（bun:ffi dlopen kernel32.dll）：
  nativePid = 8432
  jsPid     = 8432
  sameProcess = true
```

**⇒ 插件内嵌 dll 直接调用，根本不需要子进程。** 由此：

1. **`access` 白名单是 JS 层的，约束不了原生代码**
2. 禁止 `spawn` 挡不住 dll 自己调 `CreateProcess`
3. M2-8 已定「不做模块级拦截」（`import fs` 拦不住）

**⇒ `tier` 承诺不了它看起来承诺的东西。** 它能诚实表达的最多是"**我们建议这个插件跑在子进程里**"，而这只有 M4 的 runner 存在时才有意义。

**⚠ 对架构的修正建议（重要）**：T2 的判据**不应是"带 dll"，而应是"需要崩溃隔离 / 独立生命周期"**。因为：
- 带 dll ⇒ **进程内也跑得了**（实测），只是崩了会拖垮宿主
- 真正需要子进程的是 **"不能因为它的崩溃影响别人"**

⇒ **这个区分决定 M4 的 runner 为谁而做**：不是"为了关住 dll"，而是"**为了让 dll 崩了不拖垮宿主**"（可靠性），以及给 Overlay 这类**本就独立**的东西一个受管形态。

### 6.2 删 `insecure`（用户拍板）

**它是 koishi 的自我申报字段**（`ecosystem-research.md:287`）：市场**红标「不安全」+ 官方群不支持**，**零技术约束**。

koishi 能用它，是因为**它的 manifest 在 npm 上**（有发布记录、有版本冻结）。**我们的 manifest 在作者仓库里，随时可变。**

**删除理由（用户原话的展开）**：

1. **「官方意味」** —— 承载的是**官方背书/不背书**的判断权，那是**索引侧**的（verified 绿标 vs insecure 红标是**市场页**的显示），不是插件自己文件里的一句话
2. **「manifest 不受我们监管」** —— 装完后作者随时能改。**一个我们无法实时看到、无法核实的字段，却带着官方色彩，是自相矛盾的**

⇒ **若将来真需要这个信号，它应该是索引侧字段**（我们审核后打标），而非 manifest 字段。**这一点必须记档，否则将来会有人从 koishi 照搬回 manifest。**

**顺带确立的通用判据**（P3 的扩展）：

> **凡是"需要官方核实"或"承诺了什么"的字段，都不该放在我们看不到的 manifest 里。**

---

## 7. 不做的字段（汇总）

| 不做 | 理由 |
|---|---|
| **`tier`** | §6.1 |
| **`insecure`** | §6.2 |
| **`category`** | 索引的 `type` 已是权威 ⇒ 重复 = 双真源 |
| **`locales`** | 索引已是展示缓存层，第三处没必要 |
| **`config` schema 声明** | `Entry.options.config` 已是权威，重复会与加载器冲突 |
| **`requires`（宿主版本范围）** | 我们还在 `0.0.1`，现在定范围等于定了个立刻要改的数 |
| **`checksum` / `files` 清单** | git commit SHA 已覆盖完整性；文件清单属打包工具 |
| **子插件入口清单** | §5.3（撞 P3 + 需改造 loader + 无收益） |
| **`source.type`** | `.git` 后缀已可判别 |

---

## 8. 与既有决定的衔接

| 既有决定 | 本文关系 |
|---|---|
| **架构 §1.1/§1.2「核心 ctx 只含机制，业务一律是插件」** | 本文的 `dependencies` / `services` 就是插件间协作的声明面 |
| **架构 §2.2 三类服务承诺** | `restartClass` 是其**声明面**（§5.6） |
| **架构 §1.4 信任分级** | `tier` **不加**（§6.1）；T2 判据建议改为"需崩溃隔离" |
| **M2-8「声明 + warn，不做拒绝」** | `permissions` 的定位即此（P2） |
| **ADR §4.1 布局 `plugins/<id>/<version>/`** | `<version>` 来源确定为 `manifest.version`（§4.4） |
| **ADR §5.2-2 `base-state.json` schema 指派给 M2-2** | **本文未吸收**，见 §9 缺口 |
| **ADR §6「用户插件替换与 base 版本机制共用原子替换原语」** | 不动；本文只定"取什么、落到哪" |
| **`mobile-feasibility.md`「脑留在桌面」** | `platforms` **不含 android/ios**（§5.7） |

---

## 7.5 TS 镜像与漂移闸门（决定 D3）

**问题**：同一个「schema → TS」动作在仓库里曾有**两种做法**，且**都不完整**：

| 契约 | TS 镜像 | 生成方式 | 校验 |
|---|---|---|---|
| `tray-menu` | `tray-contract.generated.ts` | ✅ json2ts（有脚本） | ✅ AJV 编译 |
| `host-lifecycle` | `contracts/hostLifecycle.ts` | ❌ 无生成脚本 | ❌ 手写 guard |

而**仓库里没有任何机制**能发现"镜像与 schema 不一致"——代价**已经发生**：`hostLifecycle.ts` 头部写着「Generated … Do not hand-edit」，却从来没有脚本或 CI 步骤生成过它。

**决定**：**统一到 json2ts 生成 + AJV 校验**（tray 那套，因为它是**真的**在生成），并加**漂移闸门**。

### 7.5.1 闸门（已落地）

```
scripts/check-contract-drift.ts
  重新生成每个镜像 → 与仓库内的版本比对 → 有差异即失败

接入：
  · bun run check:contracts（已并入 bun run verify）
  · .github/workflows/build.yml 的 desktop job（三平台）
```

**它必须真的能抓到漂移**——已双向验证：干净树通过；故意改坏一个枚举值后报 `DRIFT` 并给修复命令；还原后再次通过。

**行尾归一化是有意的**：生成物不该依赖平台，但工作区会（Windows `core.autocrlf` 把 checkout 改写成 CRLF，而生成器输出 LF）。逐字节比对会把 checkout 副作用误报成漂移，那样的闸门噪音大到会被忽略——**比没有更糟**。

### 7.5.2 为什么 `hostLifecycle.ts` **不在**闸门里

它不是"标签说谎"，而是**两类内容混居**：

```
~31 行  生成得出（类型）
~30 行  生成不出（isHostSnapshot / isHostExitSummary 手写运行时 guard）
```

⇒ 逐字节比对**永远会误报**。它在文件头与闸门里**双向写明了原因**，以免被当成遗漏。

**它的 schema↔类型一致性**由 `host/tests/host-lifecycle-contract.test.ts` 在运行时读 schema 钉住。**若将来拆成「生成模块 + guard 模块」两个文件，应把它加进闸门。**

---

## 9. 未决 / 待办（诚实清点）

| # | 缺口 | 阻塞 | 状态 |
|---|---|---|---|
| **1** | **`base-state.json` 的 schema** | ADR §5.2-2 指派给 M2-2 | ✅ **已拍：本文吸收**（见 §9.3） |
| **2** | `permissions` 键集与运行时对齐的**契约测试** | schema 枚举 ≠ 运行时实际键时会静默漂移 | ✅ **已完成**：`capabilityInventory.ts` 两侧钉住 |
| **3** | **`.vrcxk` 目录名** | 已拍（§5.1），但**需与将来可能放的东西一起复核** | 暂定 |
| **4** | **索引条目 schema 的落点** | ✅ **已写**：`contracts/plugin-index/v1/` | ✅ 完成 |
| **5** | **多源的启用时机** | ✅ **已拍：现在开放**（见 §9.4，含风险敞口标注） | ✅ 决定 |
| **6** | **本地缓存策略**（作者删库后仍可用） | ✅ **已记**（见 §9.5） | ✅ 决定 |
| **7** | **取件实现** | 本文定**规则**（§4），`isomorphic-git` 已验证（probe14）但**生产代码零引用** | #21 落地时做 |
| **8** | **manifest 注册表接入装载路径** | ✅ **已接**（`host/src/manifests.ts` + `manifest-wiring.test.ts` 5 项） | ✅ 完成 |
| **9** | **base 包切换** | `host/plugins/heartbeat.ts` 与 `packages/base-heartbeat` **暂时并存** | **#23**（需 R3 的 `base-state.json` 装配） |

> **已关闭**（本轮补）：TS 镜像范式与漂移闸门 → §7.5；`$schema` 与"禁 `//` 约定键" → §5.5；索引条目 schema → `contracts/plugin-index/v1/`；manifest 注册表接线 → §9.2。

### 9.3 `base-state.json` 的 schema（决定：**本文吸收**）

ADR §5.2-2 把它指派给 M2-2，**现在明确由本文吸收**（而非退回 #23）。它管理的是 base 包的持久状态：

```jsonc
{
  "schemaVersion": 1,
  "baseVersion": "0.0.1",              // 当前生效的 base 版本（决定拷哪个版本目录）
  "entries": {
    "base-heartbeat": { "enabled": true, "config": { } }   // 键 = base 包的 manifest.id
  }
}
```

**三条约束**（⚠ **第 2 条已被 §9.3.1 的实测推翻，见下**）：

1. **键用 `manifest.id`，不用 `entry.id`** —— probe11 实测 entry id 带每次运行随机的随机前缀，持久化必然失效；而 `manifest.id` 是稳定身份。这与注册表"按后缀建键"是同一个理由的两个面。
2. ~~**只存覆盖，不存全量**~~ ⇒ **整条 `entries` 已删除**，理由见 §9.3.1：启停/配置是 cordis 原生能力，存两份即第二份真源。
3. **写入时机**：版本切换**必须在拷贝完成后**才写（ADR §7 遗留第 7 条的原子性要求）。

> **与替换机制的关系**（**修正**）：~~`entries.<id>.enabled = false` 就是停用 base 那个实现~~
> ⇒ **落点改为主机装配时的 `ctx.plugin` 参数**（`disabled` / `config` 由 cordis 原生表达），而不是另存一个状态文件。可替换性本身不变（§3.6），**变的是"停用"这个动作的记录位置**。

### 9.3.0 最终形状（`entries` 已删）

```jsonc
{
  "schemaVersion": 1,
  "baseVersion": "0.0.1"      // 当前生效的 base 版本（决定拷哪个版本目录）
}
```

**它不再是"启停/配置门户"**，只是**宿主装配 base 条目的输入**——因为 `cordis.yml` 里**根本没有 base 条目**（那正是 R3 要的干净）。

### 9.3.1 ⚠ `cordis.patch.yml` 方案：实测否决（probe24/26/28）

**设想**：宿主自带一份 patch，用户也编辑 patch，让 `cordis.yml` **永远干净**。

**机制上可行，但有一个硬阻塞**：**`write()` 会把 patch 结果烘焙进 `cordis.yml`。**

```js
// plugin-include/lib/index.js
async *[Service.init]() {
  const data = this.applyPatches([...this.data])   // 补丁应用到【浅拷贝】
  await this.root.update(data)                      // tree 接管这个数组
}
write() {
  return this.writeFile(this.root.data)             // ← 写的是含补丁结果的树
}
```

**三次独立复现**（probe26 / probe28）：

```
写之前：  "[]"                                        ← 空
写之后：  "- id: base\n  name: ./plugins/base.ts"     ← 注入的 base 条目落进去了
```

**而且 `write()` 几乎必然发生** —— Loader 在 fiber dispose 时会把 entry 翻成 `disabled` **并写回**（`host/src/lifecycle.ts` 的 write-suppression 注释即为此而写）。

**实测出的其它语义**：

| 发现 | 证据 |
|---|---|
| `patches` **是数组**，**按顺序应用**（后者覆盖前者） | 源码 `for (const patch of patches)` |
| `insert` 支持**根级**（不带 `id`）与 **group 级**（带 `id`，目标必须是 group） | probe26 / probe30 |
| **`name` 不是可覆盖字段**，而是**断言字段**（mismatch 则 skip） | 源码 `if (name && name !== target.name)` —— **防 patch 把条目劫持到别的模块**的安全设计 |
| **`entryMap` 只在循环前建一次** ⇒ **同批 patch 里 `insert` 进去的条目，后续 patch 覆盖不到** | 源码 L83-93 + probe28 |
| **烘焙是幂等的** —— 重启后条目不重复 | probe28 |

**⇒ 结论：base 条目必须"根本不进 Include 的树"**，即 **R3 的宿主装配**（`ctx.plugin()`）。**这样 `cordis.yml` 才真的永远只有用户条目。**

### 9.3.2 两条状态文件**不重复**（消除先前的混乱）

先前我一度认为二者是"两份真源"。**实测后修正**：

| | `cordis.yml` | `base-state.json` |
|---|---|---|
| 管谁 | **用户的插件** | **宿主的 base**（`baseVersion`） |
| 谁写 | Include（cordis 原生） | 宿主代码 |
| 条目来源 | 用户编辑 | **不在 yml 里**（R3） |

⇒ **两者管的是两拨不同的东西，没有重叠 ⇒ 不是重复。** 真源冲突只在**同一批条目有两处状态**时发生，而 base 条目**只在宿主装配时存在**。

**这也是 `entries` 该删的根据**：覆盖应落在 **cordis 的 entry 上**（装配时传入），而不是另存一个文件。

### 9.4 多源：**现在开放**（含风险敞口）

**决定**：v0 即开放「用户添加第三方源」（§2.3 的模型）。

**⚠ 必须记账的风险敞口**：多源开放后，**任何第三方源都能触发依赖安装**（B 方案：宿主替插件跑安装），而**签名体系要到 M4 才存在**。

⇒ 今天能提供的保护**只有展示**（§2.2 的展示义务：逐条列出解析结果与来源、同 id 多源全部列出）。这与 P2「不拦截」一致，但要**明确写下来**：**现在是"开着门、护栏后补"**，不是"已经有护栏"。

**配套要求**（否则敞口更大）：
- 安装前展示**完整安装计划**（含传递依赖与各自来源）
- 同 id 多源命中时**全部列出**，不静默取一个
- 用户改优先级**不影响已装插件**（锁身份，§3.5）

### 9.5 本地缓存策略（**已记，未实现**）

**动机**：我们不托管 ⇒ **作者删库/撤 release 就是真的没了**。本地缓存让已装插件在作者消失后仍可用。

**形态**：`plugins/<id>/<version>/` 本身就是缓存（ADR 布局），**保留策略是这里要定的**：

| 选项 | 取舍 |
|---|---|
| 永久保留所有版本 | 磁盘无限增长 |
| 只留最近 N 个 | 省磁盘，但旧版本回滚能力受限 |
| **留当前 + 上一版（推荐）** | 保证回滚一格，磁盘可控 |

**与 ADR「base 保留最近 N 个」是同一个决定**——两处应共用同一策略，避免两套保留逻辑。**实现随 #21/#23 落地。**

### 9.2 已交付（对照 #18 验收）

| #18 验收项 | 状态 |
|---|---|
| 契约测试通过（schema ↔ TS 镜像双向一致） | ✅ `host/tests/plugin-manifest-contract.test.ts`（**24 项**，含对抗性用例） |
| 一份真实 manifest 往返成功 | ✅ `readFrom` 从临时目录读回并校验 |
| 注册表可经 `entry.id` 查到该插件的声明 | ✅ `PluginManifestRegistry`（按**后缀**键，probe11） |
| `contracts/plugin-manifest/v1/*.schema.json` | ✅ |
| host 侧 TS 镜像 | ✅ json2ts 生成（D3 决定：统一到 tray 那套） |
| 宿主按 `entry.id` 的 manifest 注册表 | ✅（含 `injectFor` 派生） |

### 9.1 `permissions` 粒度与键集（用户拍板 + schema 已定）

**原则：提倡最小权限，但不强制。允许列方法，也允许直接申请一个域。**

```jsonc
"permissions": {
  "shell": ["window", "path"],   // shell 只能按【子域】放行
  "notify": true,                // 领域服务：true = 申请整域
  "dialog": true
}
```

**键集（schema 已固化为封闭枚举）**：

| 键 | 允许的值 |
|---|---|
| `shell` | `boolean` 或**子域数组**（`notify` / `openUrl` / `openPath` / `reveal` / `dialog` / `window` / `shortcut` / `app` / `path` / `devWatchEvent` / `tray`，与 `capability.ts` 的 `RAW_SHELL` 一一对应） |
| `notify` / `dialog` / `window` / `os` / `tray` / `shortcut` | `boolean` 或**方法名数组** |

- **`shell` 是万能逃逸口**：只能按子域放行，**做不到方法级细粒度**（技术限制，非设计选择）
- **其余服务尽量细**：允许列方法，也允许直接申请整个域
- **不强制最小权限**：作者可粗可细

**⚠ 实现注意（防止第三次复制）**：能力清单目前散在三处（`capability.ts` 的 5 处 `buildNode`、`tray.ts`、`shortcut.ts`）。
⇒ schema 里的枚举是**第二处**。必须加**契约测试**钉住 schema 与**运行时实际 provide 的键**对齐（照 `host/tests/capability.test.ts` 已有的 key-completeness 打法），否则新能力加进运行时而 schema 没跟上 ⇒ **插件无法声明它**。

---

## 10. 证据索引

| 结论 | 探针 | 关键实测 |
|---|---|---|
| `entry.id` 跨重启不稳定，持久化键只能取后缀 | `probe11.ts` | `<随机>:<yaml-id>`；`fullIdStable=false`、`suffixStable=true` |
| 坏插件爆炸半径：Fiber 层隔离，进程层升级为致命 | `probe12.ts` | 坏 entry=FAILED，兄弟=ACTIVE，但 `unhandledRejection` + 宿主 exit 1 |
| **外置插件不能裸 import** | `probe13.ts` | `NO_FIBER`；直接运行报 `Cannot find package` |
| **isomorphic-git 跨三主机 + compile 态可用** | `probe14.ts` | GH 206 / GL 162 / CB 300，全带 SHA；`protocolVersion:1` 必需 |
| **monorepo 子目录支持** | `probe15.ts` | 9 包 / 138 文件 → 仅落盘 28；`listFiles({oid})` 静默返回 `[]` |
| **`.git` 后缀安全但 codeload 404** | `probe16.ts` | 四家 git 主机全通过；`codeload…/b.git/tar.gz` → 404 |
| **`_` 不是合法 semver 预发布字符** | `probe17.ts` | semver.org 正则；预发布默认被范围排除 |
| **`dlopen` 是进程内的** | `probe18.ts` | `nativePid === jsPid === 8432` |
| **`ctx.plugin()` 子插件继承外层 entry** | `probe19.ts` | 三个子形态 `entryId` 全同父 |
| **路径防逃逸正则的边界** | `probe20.ts` | 尾随 `..` 曾漏过（`..`/`ui/..`）；百分号编码/盘符/UNC 正则抓不到 |

**复跑**：`bun run docs/probes/probe11.ts`（编号 11–20 同理；probe14/15/16 需网络，可经 `HTTPS_PROXY`；probe20 无需网络）。

---

## 相关

- 架构方案：[`architecture-proposal.md`](architecture-proposal.md)（§1.4 信任分级 / §2.2 三类承诺 / §4.4 前端契约）
- 目录布局 ADR：[`adr-plugin-layout.md`](adr-plugin-layout.md)（§4.1 布局 / §5.2 待定项）
- Cordis 运行时实测：[`cordis-runtime-findings.md`](cordis-runtime-findings.md)（§1.14 `entry.id` / §1.15 爆炸半径）
- 生态调研：[`../ecosystem-research.md`](../ecosystem-research.md)（§4.2 koishi manifest 字段）
- 移动端：[`mobile-feasibility.md`](mobile-feasibility.md)（脑不搬过去）
- 探针：[`probes/`](probes/)（probe11–probe19）
- 跟踪 issue：[#18](https://github.com/VRChatCN-Kipfel/VRCX-K/issues/18)（M2-2）/ [#21](https://github.com/VRChatCN-Kipfel/VRCX-K/issues/21)（M2-5）/ [#23](https://github.com/VRChatCN-Kipfel/VRCX-K/issues/23)（M2-7）