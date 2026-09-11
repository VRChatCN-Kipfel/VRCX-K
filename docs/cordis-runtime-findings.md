# M2-1 前置验证报告：插件能力接口的调用者归因

> 目的：#13 评论提出的"早期接口方案"必须先答的问题——**能力服务能否知道"是哪个插件在调"、并读到它声明的能力**。
> 结论决定：护栏（透明审计）能否实现、`ctx.shell.*` 该用什么形状、以及 manifest 与运行时如何挂钩。
> 环境：`cordis 4.0.0-rc.9` + `@cordisjs/plugin-loader 1.0.0-rc.6`（锁定版本），bun 1.4.2。
> 探针：`docs/probes/probe{,2,3,4,5,6,7}.ts` + `docs/probes/fixtures/`（可直接 `bun run` 复跑；probe7 自建自清测试目录）。**全部结论均为实测**，非读源码推断。

---

## 0. 结论速查

| # | 结论 | 证据 |
|---|---|---|
| 1 | **只有 cordis `Service` 子类能识别调用者**；`ctx.provide` 的普通对象**不能** | §1.2 / §1.3 |
| 2 | 调用者身份 = `this[symbols.caller]`，是一个 Context，可取 `fiber.name` / `fiber.uid` | §1.3 |
| 3 | **归因跨越 await 仍然有效**（能力调用是异步 RPC，关键） | §1.6 |
| 4 | **方法必须是类方法**；写成箭头函数属性会**静默**丢失归因 | §1.8 |
| 5 | **命名空间的每个子对象也必须是 Service 实例**，普通对象字面量会丢归因 | §1.7 |
| 6 | per-caller 策略钩子（`inject` 配置 → 服务可读）**存在**，但**只对插件代码里声明的 `inject` 有效**；**Entry/manifest 声明的 `inject` 读不到** | §1.4 / §1.11 |
| 7 | **正确挂钩点是 `caller.fiber.entry`**：服务可沿调用者 ctx 走到 Entry，读到 `entry.id` / `options.inject` / `options.config` | §1.12 |
| 8 | **Entry options 没有放自定义 manifest 的位置**（只有 `id/name/inject/config/group/disabled`） | §1.12 |
| 9 | `Service[symbols.filter]` **不是访问门**，不能用来做允许/拒绝 | §1.9 |
| 10 | 服务必须**先 provide、后 attach**（否则注入它的插件卡在 PENDING） | §1.5 |
| 11 | 现有 `TrayService` / `ShortcutService` **是普通 class，今天零归因** | §1.13 |

---

## 1. 逐条实测

### 1.1 公开可用性（无私有路径依赖）

`symbols`、`Service`、`Context` 都从 `cordis` 公开入口可导入（`lib/index.d.ts` 的 `export * from './utils'`）。
`symbols` 全部键：`shadow, caller, receiver, original, metadata, initHooks, checkProto, effect, filter, isolate, intercept, init, check, config, invoke, extend, tracker, resolveConfig`。

### 1.2 普通对象 `ctx.provide(name, obj)` —— **无归因**

```
B_call_from_A: { "hostPlugin":"pluginA", "thisIsTarget":true, "thisIsContext":false,
                 "thisCtor":"Object", "hasShadow":false, "hasCaller":false,
                 "shadowName":null, "callerName":null }
B_call_from_B: 同上（无法区分）
```

方法内 `this` **就是那个对象本身**，无 `symbols.shadow`、无 `symbols.caller`。两个不同插件调用结果完全一致。

> 附带：`ctx.get(name,false)` 返回**原对象**（未包代理），`inner.plain === plain` 为 true。

### 1.3 `Service` 子类 —— **有归因，且 per-caller 实例化**

```
C_readIdentical: false                     // 每次读取返回不同对象
C_readSymbols: ["ctx","name","Symbol(cordis.tracker)"]
C_who_from_A: { "callerName":"svcPluginA", "ctxFiberName":"svcPluginA", "hasCaller":true }
C_who_from_B: { "callerName":"svcPluginB", "ctxFiberName":"svcPluginB", "hasCaller":true }
C_distinctSelfInstances: 2
C_readCaller: "root"                       // 宿主自身读取时 caller 是 root
```

`this[symbols.caller]` 是一个 Context，可用信息（`Q_identity`）：

```
{ present:true, isContext:true, fiberName:"identifiedPlugin", fiberUid:1,
  runtimeName:"identifiedPlugin", fiberState:1 }
```

**附带（迁移风险）**：per-caller 实例上读 `this.ctx` 得到的是**调用者的 ctx**，不是提供者的。迁移既有服务到 `Service` 时，凡依赖"`this.ctx` = 我自己的 ctx"的代码**必须审计**。

### 1.4 per-caller 策略钩子 —— **存在，但只对插件代码声明的 inject 有效**

```
plugin A: inject = { policySvc: { mode:"A", limit:3 } }
  ctx[Context.intercept].policySvc               ==> {"mode":"A","limit":3}
  fiber.inject                                   ==> {"policySvc":{"mode":"A","limit":3}}
  服务方法内 this.ctx[Context.intercept].policySvc ==> {"mode":"A","limit":3}
  this[symbols.resolveConfig]()                  ==> {"mode":"A","limit":3}
plugin B: inject = { policySvc: { mode:"B" } }   ==> {"mode":"B"}   （互不串扰）
```

⇒ 上游文档说的"授权逻辑类似服务拦截、**由服务提供者定义**"，机制在 rc.9 **已可用**——但见 §1.11 的重要限定。

### 1.5 `inject` 是**就绪门**，不是**访问门**

| 问题 | 实测 |
|---|---|
| 未 inject 的插件能否读服务？ | **能**（`E.readWithoutInject:"hi"`） |
| 注入未提供服务的插件状态？ | provide 前 `0(PENDING)`、插件体未执行（`started:0`） |
| provide 之后？ | `2(ACTIVE)`、插件体执行一次（`started:1`） |

⇒ 证实既有设计：**服务必须"先 provide、后 attachShell"**，否则注入它的插件一直卡 PENDING。`host/src/index.ts` 的 tray/shortcut 正是这个模式。

### 1.6 异步方法：调用者**跨越 await 仍然有效**

```
J_A_async: { "syncCaller":"pluginA", "lateCaller":"pluginA", "survivedAwait":true }
M_A_capture: { "captured":"pluginA", "afterAwait":"pluginA" }
```

⇒ 能力调用是异步 RPC，这一点关键：**无需在方法入口手动捕获调用者**。

### 1.7 嵌套：**Service 实例可以，普通对象不行**

| 形状 | 结果 |
|---|---|
| Service 的**普通对象**属性：`shell.window.show()`（v3 `K_nested`） | ❌ `hasCaller:false`、`callerName:null` |
| Service 的**Service 实例**属性：`shell.window.show()`（v4 `N_nestedService`） | ✅ `caller:"nestedSvcPlugin"` |
| Service 类方法：`shell.notify()`（v4 `N_flatMethod`） | ✅ `caller:"nestedSvcPlugin"` |

⇒ **`ctx.shell.window.show()` 这种命名空间形状可以保住归因——前提是每个命名空间都是 Service 实例。**

### 1.8 箭头函数方法 —— **静默丢掉归因**

```
P_method: { "kind":"method", "caller":"arrowPlugin" }   ✅
P_arrow:  { "kind":"arrow",  "caller":null }            ❌
```

实现纪律：能力服务的方法必须是类方法（原型上的方法）。箭头函数属性在构造时绑定词法 `this`，归因丢失且**不报错**。

### 1.9 `Service[symbols.filter]` **不是**访问门

服务读取与事件发送过程中 `filter` **一次都没被调用**（`O_calls: []`），且 `Service` 实例无 `emit`。
⇒ 它是**事件作用域/隔离**用的默认过滤器（`ReflectService.notify(names, filter)` 的默认实现按 `symbols.isolate` 匹配），**不是 per-caller 准入判定**。将来若做硬拒绝，只能在方法体内判定。

### 1.10 `ctx.reflect.bind` 不携带调用者（本用法下）

```
G_call_from_plugin: { "thisIsContext":false, "callerName":null, "shadowName":null }
```

### 1.11 ⚠ **Entry 级 `inject` 不会进入 `ctx[Context.intercept]`**

实测（probe4）：

```
entryOptionsInject:  {"entrySvc":{"mode":"entry","limit":7}}    // Entry 上有
fiberInject:         {"entrySvc":{"mode":"entry","limit":7}}    // fiber 上有
interceptKeys:       []                                          // 但 intercept 里没有！
interceptEntrySvc:   null
```

**根因（源码定位）**：

- `cordis/lib/index.js:1370`：`new Fiber(this.ctx, config, Inject.resolve(plugin.inject), ...)` —— fiber 构造时用的 inject 来自**插件函数自身的 `inject`**；
- `Fiber` 构造函数在此时把非空 inject 写入 `ctx[Context.intercept]`（`index.js:702-709`）；
- 而 Entry 的 inject 是在**之后**由 loader 的 `internal/plugin` 钩子合并的：`plugin-loader/lib/index.js:577-581`
  ```js
  ctx.on("internal/plugin", (fiber) => {
    if (fiber.parent[Entry.key] && !fiber.entry) {
      fiber.entry = fiber.parent[Entry.key];
      Inject.resolve(fiber.entry.options.inject, fiber.inject);   // 只进 fiber.inject
    }
  ```
  ⇒ **Entry/manifest 声明的配置进 `fiber.inject`，但 intercept 表已经建好了，所以服务读不到。**

**设计后果**：**不能**用"manifest 里写 `inject: { svc: <policy> }`、服务读 intercept"来实施声明。见 §1.12 的正确做法。

### 1.12 ✅ **正确挂钩点：`caller.fiber.entry`**

`fiber.entry` 由上面同一个钩子设置（`plugin-loader/lib/index.js:579`）。probe5 实测从服务方法内走通：

```jsonc
// 调用者是 loader Entry 时
{ "callerFiberName":"auditPlugin", "callerFiberUid":3,
  "hasEntry": true,
  "entryId": "5473620f",
  "entryName": "./auditPlugin.ts",
  "entryInject": "{\"auditor\":{\"declared\":[\"notify\",\"dialog\"]}}",  // ✅ 可读
  "entryConfig": "{\"someOption\":\"hello\"}",                            // ✅ 可读
  "entryExtraKeys": ["id","name","inject","config"],
  "interceptKeys": [] }

// 调用者是裸 ctx.plugin()（宿主内部插件）时
{ "callerFiberName":"barePlugin", "callerFiberUid":4, "hasEntry": false }
```

**两条结论**：

1. ✅ 服务**可以**沿 `this[symbols.caller] → .fiber.entry → .options` 读到调用插件的身份与声明——**这是 M2-8 的落点**。
2. ⚠ **Entry options 没有放自定义 manifest 的位置**：实测 own keys 只有 `["id","name","inject","config"]`（另有 `group`/`disabled`）。
   ⇒ manifest **不能**挂在 `EntryOptions` 上；应由宿主**按 `entry.id` 建注册表**（或在 `config` 里约定一个保留键）。前者更干净，且与 M2-5 的市场清单天然同源。
3. ⚠ **裸 `ctx.plugin()` 没有 Entry**（`hasEntry:false`）——服务必须处理"无 entry 的调用者"（宿主内部插件）。

### 1.13 现有服务零归因（直接后果）

```
host/src/tray.ts:109      export class TrayService {          // 普通 class
host/src/shortcut.ts:72   export class ShortcutService {      // 普通 class
```

两者都由 `ctx.provide("tray"/"shortcut", ...)` 提供（`host/src/index.ts:165/173`）⇒ **今天任何插件通过 `ctx.tray` / `ctx.shortcut` 的调用都无法归因**。
要获得归因，必须迁移为 `Service` 子类（并审计 §1.3 的 `this.ctx` 语义变化）。

---

## 2. 对 M2 的直接结论

| M2 任务 | 由本次验证确定的事实 |
|---|---|
| **M2-1 能力接口面** | `ctx.shell.*` raw 直出**可以**做审计，但：必须用 `Service` 子类；**每个命名空间也要是 Service 实例**；**方法一律类方法**；无 entry 的调用者要单独处理 |
| **M2-2 manifest 契约** | manifest **不能**挂在 `EntryOptions`；改为**宿主按 `entry.id` 建注册表**（与 M2-5 市场清单同源） |
| **M2-4 / M2-5 管理面与市场** | Entry 是**可枚举、可寻址**的（`entry.id`、`entry.options`、`entry.fiber`）——管理面有实证落点 |
| **M2-8 access 声明 + warn** | 落点 = `caller.fiber.entry.options` + 宿主 manifest 注册表；**只做观测不做拒绝**；拒绝将来也不能用 `filter`（§1.9） |
| **迁移既有服务** | `TrayService`/`ShortcutService` **决定迁到 `Service`**（本轮拍板）——否则 `ctx.tray`/`ctx.shortcut` 永久零归因；**须审计 `this.ctx` 语义变化**（§1.3） |

> 相关文档：[`adr-plugin-layout.md`](adr-plugin-layout.md)（目录布局 ADR，其 §1.5 的三条实测由 `probe6.ts` 提供）、[`poc-m0.md`](poc-m0.md)（M0 PoC）。

---

## 3. 未验证 / 遗留

1. **`Service` 迁移对既有服务代码的实际影响面**：只测到"per-caller 代理上读 `.ctx` 得调用者 ctx"，`TrayService`/`ShortcutService` 迁移后的具体改动量未评估。
2. **kkrpc 异步链路上的归因**：只测同进程调用；跨 stdio RPC 往返后再读 `symbols.caller` 未测（§1.6 的 await 存活结果使其低风险，但未实测）。
3. **`entry.options.config` 能否承载 manifest**：`config` 是插件自己的配置，塞 manifest 属滥用；按 §1.12 的建议走独立注册表，但**未实现验证**。
4. **Entry 的 `group` / 子树的 identity 语义**：M2-4 管理插件组时需要，本轮未测。
