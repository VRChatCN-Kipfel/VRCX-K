# PR #31 / #32 评审记录（M2-1 能力面 + M1 收尾）

> 日期：2026-09-12 ｜ `#31` 四轮、`#32` 三轮，全部以 `kipfel-bot[bot]` 身份提交 ｜ 作者：1zyao
> 范围：`#31 feat(host): expose a plugin-facing capability surface (M2-1)`、`#32 fix(ui,build): M1 review cleanups`
> 收口：`#32` squash → `35d8c2ac`（17:45）、`#31` squash → `d20c2b94`（17:53）。合并后 `rewrite` 实测 typecheck 0 error / host 141 pass / UI 80 pass。
> 技术结论另见 `cordis-runtime-findings.md` §1.13 / §1.14；本文只记评审过程与判定依据。

---

## 0. 结论速查

| # | 事项 | 结果 |
|---|---|---|
| 1 | `#31` 首轮判定 | 阻塞：归因在**生产路径**上错误 |
| 2 | `#31` 迭代轮次 | 4 轮（3 红 1 绿），每轮发现均在下一提交修正 |
| 3 | `#32` 迭代轮次 | 3 轮（1 comment 2 绿），无阻塞项 |
| 4 | 合并顺序 | `#32` 先、`#31` 后（两 PR 文件零重叠，顺序不影响可行性） |
| 5 | 合并策略 | 均为 squash（仓库既有惯例，`#14`/`#15` 同此） |
| 6 | 遗留跟踪项 | 见 §4 |

---

## 1. 方法论

评审采用三种独立取证手段，均要求可复现：

**变异测试**。对被测逻辑注入定向改动，确认测试套件会失败。仅"测试通过"不足以证明护栏有效——`#32` 的 disposer 半区在第二轮有 8 个变异存活，说明当时测试并未覆盖该路径。

**独立复现**。关键论断不采信提交信息或代码注释，由评审侧单独跑探针验证。`#31` 首轮的归因缺陷即以此确认：照 `host/src/index.ts:183-198` 的装配方式加载两个 `apply`-only 插件，实测两者审计身份相同。

**边界枚举**。对同一机制列举所有形态，而非只测夹具覆盖的那种。`#31` 第三轮的文档缺陷正是这样发现的——probe8 只用了具名函数表达式，而该形态**恰好是唯一**能让修补生效的。

---

## 2. `#31` 各轮发现

### 轮 1（阻塞）

`callerName` 取 `fiber.name`。该 getter 沿父链上溯（`cordis/lib/index.js:789-796`），且 loader 丢弃 `apply` 名（`:1365-1366`），因此只导出 `apply` 的插件——含仓库唯一实际插件 `host/plugins/heartbeat.ts`——解析到外层 `Include`。两个不同插件在审计中不可区分。

同轮另记三项：`record` 把归因丢失记为 `<host>`（真实宿主调用经同一代理得 `"root"`，属错误归因）；raw 镜像缺编译期完整性护栏；`ctx.shell` 声明与无壳时的 `null` 返回不符。

### 轮 2（阻塞）

改用以 `entry.id` 为主键后，新增的回归测试把修订前的行为固化为期望。

```ts
expect(senders.filter((s) => s.includes("alpha"))).toHaveLength(2)
```

该计数**仅当**嵌套插件与所属 entry 同身份时成立。任何区分二者的改动都会使断言失败——测试名却是"audit as distinct identities"。改法为断言性质（互不相同）而非计数，保留 `not.toContain("Include")` 这一原始回归。

### 轮 3（两项 MAJOR）

**适用范围被过度声明**。文档与注释把"复合修法使嵌套不再塌缩"写成通用结论。实测五种嵌套形态：仅具名函数表达式有 `runtime.name`，匿名箭头（`runtime.name === ""`）、对象字面量 `{ apply() {} }`、apply-only 命名空间都落回裸 `entry.id`。五调用者得三个身份。probe8 夹具恰只含具名形态。

**根级插件的行为描述有误**。文档称无 entry 仅发生在"完全没有 loader"时。实测在活动 Loader 下根级裸插件的 `fiber.entry` 仍为 `null`——判定依据是 `parent[Entry.key]` 是否存在（`plugin-loader:578`）。后果：匿名根级插件审计为 `"root"`，与宿主自身身份相同。

同轮三项次要项：§1.13 仍称两个服务"零归因"（`#31` 自身已迁移）；`apply` 名被丢弃的机制归因于 loader 而非 cordis；probe8 无错误路径，坏输入仍输出成功形状的 JSON 且 exit 0。

### 轮 4（两项 NIT）

probe8 的 `r2_entryId` 在无 entry 时回退到 `fiber.name`，字段名与语义不符（`rootBare.named.entryId` 打印回退名而非 `null`）；一处列表计数文案。均在 `b963356d` 修正。

---

## 3. `#32` 各轮发现

### 轮 1（comment）

两项修复经实测确为承重：`.bun-cache` 忽略项使 Vite watcher 实际监视目录由 2 降至 0；watcher 错误守卫机制端到端成立（无守卫 exit 1、有守卫 exit 0，node 与 bun 一致）。生产产物与基线逐字节相同。

次要项集中在验证声明的准确性：`bun run build` 不能证明插件生效（`configureServer` 为 dev-only）；A2 声称的测试覆盖不成立（该轮未改动任何测试文件）。

### 轮 2（绿）

抽出的 `subscribeHostLifecycle` 经差分执行验证与旧内联实现等价（9 个时序场景 + 4 个 disposer 场景动作序列一致）。同一轮指出 disposer/取消半区未被测试钉住，其中"被取消的挂载不再释放 listener"经隔离对比确认为真实泄漏。

### 轮 3（绿）

`seed()` 改用两参数 `.then`，双读消失（`apply` 抛错时 `seedCalls` 由 2 降至 1）。存活变异由 8 降至 2，前轮指出的泄漏已被捕获。行为保持再次确认。残留一项：正常卸载路径（订阅建立后 dispose）仍无覆盖。

---

## 4. 遗留跟踪项

| 项 | 来源 | 说明 |
|---|---|---|
| 归因对嵌套形态的覆盖不完整 | `#31` 轮 3 | 非具名嵌套形态仍塌缩至所属 entry。可作为设计接受（entry 是可安装单元），但若将来需要更细粒度，需另择分隔机制。M2-8 以 `entry.id` 建注册表不受影响。 |
| 正常卸载路径无测试覆盖 | `#32` 轮 3 | `dispose()` 在订阅建立后调用这一路径未被断言。当前实现正确（差分验证过），仅缺回归保护。 |

另记：`ShellHandle.detach()` 自引入起无调用点。

---

## 5. 评审的可复现性

`#31` 的 `docs/probes/probe8.ts` 随 PR 转正，可直接 `bun run` 复跑（自建自清测试目录），并在 `cordis-runtime-findings.md` §1.14 记录三种命名策略的实测对比。`#32` 的等价性验证依赖临时差分脚本，未转正——若将来重构 `subscribeHostLifecycle`，需重做该项验证。
