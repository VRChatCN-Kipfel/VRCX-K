# 手能力面提案（给 SDK 定版）

> **状态**：**提案，非实现**。不含生产代码改动。
> **目的**：在插件 SDK 定版**之前**，把「手（`src-tauri` / Rust 壳）可实现的能力」尽可能
> 收成 SDK 能直接消费的形状。SDK 一旦定版，形状再改就要付兼容成本；现在是唯一的
> 低成本窗口。
> **日期**：2026-09。
>
> **本文不是新建的事实来源**。每一条结论都有一个**实测主副本**，本文只做「实测 → 可消费
> 形状」的转换，并在每节标明来源。冲突时以主副本为准。

## 0. 一句话

手要向插件暴露 **4 个原语**（`stat` / `read` / `write` / `watch`），全部**无状态、可取消、
有背压**；**目录遍历、批量、重试、断点编排一律归脑**。

---

## 1. 为什么是这 4 个原语（而不是更多）

推导链，每一步都有实测依据：

| 步骤 | 结论 | 来源 |
|---|---|---|
| 手必须有文件能力 | 异机时宿主**够不着**那台机器的磁盘 —— `host/src/watcher.ts` 是**宿主自己**的文件监视，路径解析在宿主侧 | [`probes/hand-io/FINDINGS.md`](probes/hand-io/FINDINGS.md) §7.1 |
| 但**不要**给手「打包技能」 | 目录遍历 / 批大小 / 重试是**业务策略**；实测每文件成本 = 一个完整 RTT（5 ms 下逐文件比打包慢 **320x**），修法是**脑侧批量请求**，不是手侧变聪明 | transport-lab §6 |
| 故手的原子能力是**单文件** | 读一个文件、写一个文件、看一个文件 —— 再加一个查大小/存在性（批量与续传都要它来决定 offset） | 由上行推出 |
| 续传**不需要新原语** | `seek(SeekFrom::Start(n))` 就是全部机制（实测逐字节回读一致）；把 offset 作为**参数**，而非新方法 | [`rust-crates/FINDINGS.md`](probes/hand-io/rust-crates/FINDINGS.md) §3 |
| 监视**必须是手的**（不能复用宿主 watcher） | 同第一条：宿主看不见异机磁盘 | 同 §7.1 |

**⇒ 4 个原语，不是 40 个。**

---

## 2. 建议的形状（含 `ctx` 命名与类型）

按 [`host-sessions-design.md`](host-sessions-design.md) §6.1 的**写法基准**：`extends Service`、
**类方法**、**命名空间展平**。理由见 [`cordis-runtime-findings.md`](cordis-runtime-findings.md)
§1.2（普通对象零归因）、§1.3（`Service` 有归因且 per-caller）、§1.7（命名空间子对象也必须是
`Service`）、§1.8（**箭头函数方法静默丢归因**）。

```ts
declare module "cordis" {
  interface Context {
    hands: HandsService
  }
}

/** 一个文件的身份与大小。批量与续传都靠它决定 offset。 */
export type HandsStat = {
  /** 逻辑大小。可能与物理占用不同（稀疏/压缩）。 */
  size: number
  /** 单调递增的文件身份。**跨 rename 稳定**，用于检测轮转。 */
  id: string
  /** 最后修改时刻（epoch ms）。仅作提示，不用于正确性判断。 */
  mtimeMs: number
  /** 是否为目录。`stat` 对目录也有效，便于调用方决定后续动作。 */
  kind: "file" | "dir" | "other"
}

export type HandsReadOptions = {
  /** 从该字节偏移开始读。续传即传上次的 offset。默认 0。 */
  offset?: number
  /** 单块上限（字节）。手的实现据此分配缓冲；调用方不应假设块边界。 */
  chunkSize?: number
  /**
   * 期望的文件身份。若与实际不符 ⇒ 立刻以 `ESTALE` 失败，**不要**继续读。
   * 这是轮转检测的**调用方**一侧：手不替调用方猜语义。
   */
  ifId?: string
}

export type HandsWriteOptions = {
  /** 起始偏移。默认 0（覆盖）；传 offset 即续写。 */
  offset?: number
  /** 打开模式。`truncate` 与 `offset>0` 互斥。 */
  mode?: "create" | "truncate" | "append"
}

export type HandsWatchOptions = {
  /** 目录递归。默认 false。 */
  recursive?: boolean
  /**
   * 从既有内容的该偏移开始投递（`tail -f` 语义）。省略 = 只看新增。
   * 这让「先读历史、再跟进」不需要两次握手。
   */
  fromOffset?: number
}

export type HandsChange = {
  kind: "create" | "modify" | "remove" | "replace"
  path: string
  /** 该文件当时的身份，便于与 `stat` 的结果比对。 */
  id?: string
}

/** 错误面：手只报这几种，调用方不需要解析字符串。 */
export type HandsErrorCode =
  | "ENOENT"      // 不存在
  | "EACCES"      // 无权限 / 授权失效
  | "EISDIR"      // 期望文件却是目录
  | "ESTALE"      // 身份已变（轮转）或偏移超出
  | "ENOSPC"      // 目标盘无空间
  | "ECANCEL"     // 调用方取消
  | "EUNSUPPORTED" // 该平台不支持（例如移动端的某些路径）

export class HandsService extends Service {
  // 构造期捕获自身依赖：Service 的 per-caller 代理上 `this.ctx` 是【调用者的 ctx】，
  // 不是提供者的（findings §1.3）—— 故方法内不要用 `this.ctx` 取 logger/配置/设备表。
  constructor(ctx: Context, deps: HandsDeps) {
    super(ctx, "hands")
    this.deps = deps
  }

  // ⚠ 全部写成类方法。写成箭头函数属性会【静默】丢归因（findings §1.8）。

  /** 查一个路径的身份与大小。**不抛**「不存在」，而是返回 null（见 §2.2 的错误约定）。 */
  async stat(path: string): Promise<HandsStat | null>

  /**
   * 读一个文件，返回**异步可迭代的字节块**。
   *
   * 背压由 credit 窗口保证：消费者不取，生产者就停（实测停在 32 块）。详见 §3。
   * 取消 = 退出 `for await` / 调 `.return()`，实现必须立即停读并关闭句柄。
   */
  read(path: string, opts?: HandsReadOptions): AsyncIterable<Uint8Array>

  /** 写一个文件。返回实际写入字节数与**结束偏移**（续传的下一个 offset）。 */
  write(path: string, data: AsyncIterable<Uint8Array>, opts?: HandsWriteOptions):
    Promise<{ bytes: number; endOffset: number }>

  /**
   * 订阅一个路径的变化。
   *
   * 返回的迭代器结束即取消订阅；实现必须保证**取消后不再投递**。
   * ⚠ 轮转语义：见 §4 —— 这是本提案里**唯一**有平台陷阱的原语。
   */
  watch(path: string, opts?: HandsWatchOptions): AsyncIterable<HandsChange>

  /** 取消某个进行中的操作（也可用迭代器的 return/throw）。 */
  cancel(handle: HandsHandle): Promise<void>
}
```

### 2.1 为什么把 `stat` 单列

不是为了「方便」，是两个**必需**用途：

1. **批量上传**要预先知道每个文件的大小，才能算 batch size 与进度（transport-lab §6 的批量法）。
2. **续传**必须先知道当前远端大小，才能算 `offset`；而**只有身份 + 大小一起**才能判断
   「该续写，还是文件已被轮转、必须重来」（见 §4）。

### 2.2 错误约定：三种「失败」必须可区分

插件的代码要能**分支处理**，而不是解析错误字符串。三种情形语义不同：

| 情形 | 约定 | 为什么不能合并 |
|---|---|---|
| **查询类**（`stat`）目标不存在 | 返回 **`null`**，不抛 | 「不存在」对 `stat` 是**正常答案**；抛异常会逼调用方用 try/catch 做流程控制 |
| **操作类**（`read`/`write`/`watch`）失败 | 抛 **`HandsError`**，带 `code: HandsErrorCode` | 调用方必须区分 `ESTALE`（该重来）与 `EACCES`（该提示用户） |
| **取消** | 抛 **`ECANCEL`**（或迭代器正常结束） | 「用户取消」不是故障，**不应**被上报为错误告警 |

⚠ 关键的一条：**`ESTALE` 必须与 `ENOENT` 分开**。轮转后的「文件换了」与「文件没了」
需要**完全相反**的处置 —— 前者重来并重置 offset，后者通常该放弃。合并成一个错误码，
会逼调用方去读错误消息文本，而那是**不稳定的接口**。

`HandsErrorCode` 的完整集合见 §2 的类型定义；**新增错误码是破坏性变更**，
SDK 定版后要按版本走。

---

## 3. 背压：为什么不是可选项

**实测**：消费者取 1 块后停手，生产者**精确停在 32 块**（= kkrpc 的初始 credit 常数）；
无流控的对照组跑了 2048 块。来源：transport-lab §4。

⇒ **形态必须是 `AsyncIterable` + credit 窗口**，不能是「一次调用返回全部字节」。
内存占用是 `credit × chunkSize`，**不是文件大小** —— 这正是「流式」名副其实之处。

⚠ 一个实现约束（实测）：`Buffer.alloc(N)` 是**同步 CPU**，1 GiB 冻结事件循环约 0.25 s
⇒ 手与脑**都必须分块分配**，禁止 `Buffer.alloc(fileSize)`。来源：transport-lab §5。

---

## 4. ⚠ 每个原语的平台陷阱（**本节是提案里最需要 SDK 作者读的部分**）

### 4.1 `watch`：轮转是**免费**的，但「不存在的路径」不是

| 情形 | 实测行为 | 对 SDK 的含义 |
|---|---|---|
| 日志轮转（rename + 新建同名） | **投递继续** —— Windows 下 `notify` 靠监视父目录实现 | 调用方**不需要**重订阅 |
| 轮转**检测** | `file_id` 变化（Windows u128 HighRes，优于 `same-file` 的低位索引） | 由调用方比对 `HandsStat.id`，手只提供 `id` |
| 截断（原地变小） | 身份**不变**，只是 size 变小 | 调用方比对 `size < offset` |
| **路径尚不存在** | **无法预挂 watch**（实测：报错且 0 事件） | ⚠ **手必须在内部改为「监视父目录 + 按路径过滤」**，否则「应用启动时 tail 一个还没建的日志」直接失败 |

来源：[`rust-crates/FINDINGS.md`](probes/hand-io/rust-crates/FINDINGS.md) §4.1–4.3。

### 4.2 `watch` 在**网络/异机路径上不可靠**

`notify` 自己的文档与 issue #254 都写明：NFS/SMB 可能**完全不投递事件**，且
**WSL 程序监视 Windows 路径**是典型受害者。

⇒ **手必须站在文件所在的那台机器上**。这不是性能建议，是正确性前提——
它也是「为什么监视必须是手的原语」的根本理由（§1）。

### 4.3 `read`/`write`：Android 的 `content://` 不是路径

Android 上用户选择返回的是 `content://` URI，**不是文件路径**：

- `into_path()` 对它**必然失败**（by design）—— 别先转路径。
- 取得可 seek 的真 `File` 的**唯一**途径是 `tauri-plugin-fs` 的 `Fs<R>::open`
  （SAF fd 桥）。来源：[`rust-crates/FINDINGS.md`](probes/hand-io/rust-crates/FINDINGS.md) §8.1。
- ⚠ **已知上游缺陷**：该路径在 provider 显式 `return null` 时会 `unimplemented!()`
  **abort 进程**，且**无法从我们侧捕获**（`panic="abort"` + Cargo 拒绝 per-package 覆盖
  + 跨 FFI 展开是 UB）。判据与上游 PR #3236 见同节 §8.2。
  **裁定：轻微缺陷，通过不修**（最坏崩溃重启、触发路径窄；复现需真机 + SDK）。

### 4.4 `write` 的追加语义

`append` 模式**忽略被移动的游标**（实测）—— 这是**多写者下滚动日志唯一正确**的写法，
因为 `seek(End)` 后 `write` 之间存在竞态。来源：`rust-crates/FINDINGS.md` §3。

⚠ Windows：以 append-only 打开的文件**无法加锁**（std 文档）；若需既可锁又可追加，
用 `.read(true).append(true)`。

---

## 5. ⚠ 单管道队头阻塞：**一个尚未写进任何文档的推论**

**这是本提案发现的新问题，不是复述。**

事实：

- 手⇄脑今天**只有一条 stdin/stdout 管道**（`src-tauri/src/host.rs:1217-1219`）。
- 手侧的写入是**单锁串行**（`kkrpc_peer.rs` 的 `write()` 持 `writer.lock()` 后
  `write_all`）。
- 而实测过：**大流量与交互 RPC 共用一条通道会让交互调用 p50 从 0.66 ms 涨到 321 ms**
  （transport-lab §3，那条测的是 ws；机制同源 —— 单一有序字节流）。

⇒ 若 `hands.read` 的块与 `shell.notify`、托盘点击回执**共用这条管道**，
**用户会感到托盘/通知卡住**。这不是吞吐问题，是**交互可用性**问题。

**三条出路（提案不替 SDK 决定，但必须让它知道这个取舍存在）**：

| 出路 | 代价 | 何时合适 |
|---|---|---|
| **(a) 给手⇄脑加第二条通道**（大流量专用） | 壳要开第二个 fd / socket；生命周期与现管道一并管 | 若文件传输是**一等功能** |
| **(b) 脑侧限流**：一次只挂一个 bulk 流，且实现**分片让出** | 无需改协议；但交互延迟仍会恶化，只是有上界 | 若文件传输是**偶发功能** |
| **(c) 不解决**，接受传输期间交互劣化 | 零成本 | 若手主要用于**单文件、小文件** |

⚠ 实测的另一半：共享隧道里那 75 ms 的残留在**独立连接**下依然存在，
说明**发送端必须分片让出**是**无论选哪条出路都要做的**（transport-lab §3）。

**这项必须进 SDK 决策**：它决定 `ctx.hands` 是「挂在现有通道上的普通服务」，
还是「需要一条独立通道的传输服务」。

---

## 6. ⚠ 审计插针：`ctx.hands` 必须可归因

`#17`（M2-1）把**透明调用记录**列为随决定一起采取的 4 条护栏之一，并明示理由：

> 领域服务可能被绕过……raw 路径的 warn 归因需额外做工（对象方法不读 `this`）

`#24`（M2-8）进一步定了落点与要求：

> `this[symbols.caller]` → `.fiber.entry` → `.options`；**两条路径都要覆盖**；
> 越权检测 + **warn 日志**；**不做硬拒绝**

⇒ **`ctx.hands` 不能只是「能跑」，它必须能被审计。** 因为它是**流式**服务，
实现时有两个具体的落点要注意：**审计记几次**（§6.2）与 **`this` 是什么**（§6.2a）。

### 6.1 照抄现有形状

现有唯一的正确实现是 [`host/src/capability.ts`](../host/src/capability.ts)：
`buildNode` 把每个方法包成**普通函数**（**不能是箭头函数** —— 见 findings §1.8），
在调用时同步 `handle.record(this, "<ns>.<method>", args)`，再由 `ShellHandle.record`
经 `callerName(this)` 解析 `symbols.caller` → `fiber.entry.id`。

`ctx.hands` 必须**同一形状**，且同样落在 `HOST_SERVICES` / `REQUESTABLE_CAPABILITIES`
（[`host/src/contracts/capabilityInventory.ts`](../host/src/contracts/capabilityInventory.ts)）
—— 那是**单一真源**，由 `capability-surfaces.test.ts` 与 `swap-ability-contract.test.ts` 钉住。
**新增能力必须同时登记，否则契约测试会红。**

### 6.2 流式方法：审计**记一次**，不要每块记

> ⚠ **本节初稿断言「在 generator 体内 record 会丢归因」—— 该断言已被探针推翻。**
> 实测（[`probes/probe-hand-attribution.ts`](probes/probe-hand-attribution.ts)）：
> **三种形状都保留了归因**，包括「记录写进 async generator 体内」。
> 我原先是把 findings §1.8 的「箭头函数丢归因」**外推**到了 generator，没有实测 ——
> 记录在此，避免后人重犯。

实测结果（A/B/C 由同一个 plugin 调用，走真实 Service per-caller 代理）：

```
A sync method                      when=at call      who=namedPlugin
B record inside generator          when=first next() who=namedPlugin
C record at call, return gen       when=at call      who=namedPlugin
```

⇒ **归因本身不是问题**。真正要守的是**另外两条**：

| 规则 | 为什么 |
|---|---|
| **一个流只记一条审计行** | 每块都记 ⇒ 一个 GB 文件上万行，**日志被淹没**，真正的越权调用反而看不见。审计的语义是「**这个插件申请读这个路径**」，不是「读了多少块」 |
| 块数/字节数/耗时属于 **metrics**，不属于审计 | 不要塞进 `[cap]` 行；观测需求走另一条路 |

两种写法**都能归因**，所以选哪种是**日志量**的问题，不是正确性问题：

```ts
// ✅ 推荐：调用时记一次。「申请读」是审计事件，「读了多少」是指标。
read(path: string, opts?: HandsReadOptions): AsyncIterable<Uint8Array> {
  this.handle.record(this, "hands.read", [path, opts])
  return this.impl.readStream(path, opts)
}

// ⚠ 可行但不推荐：generator 体内记 —— 归因正常（已实测），但若放在循环里
//    就会按块刷审计
async *read(path: string, opts?: HandsReadOptions) {
  this.handle.record(this, "hands.read", [path, opts])   // 只记一次，仍在 next() 时才执行
  ...
}
```

⚠ 第二条写法还有一个**延迟**差异：generator 体内那句要等**首次 `next()`** 才执行。
若调用方「拿到迭代器但不消费」，审计就**不会**记 —— 于是「申请了但没用」不留痕。
**这是选第一种写法的实际理由**，而不是归因。

### 6.2a ⚠ `this` 在 Service 方法里**不是实例**（实测踩到）

写探针时发现的**实现约束**，与归因同理但更硬：

cordis 的 `createShadowMethod` 会把 `thisArg` 换成 per-caller 的 **shadow 对象**
（`host/node_modules/cordis/lib/index.js:136-143`），所以 Service 方法里的 `this`
只**原型链地**看得见公开成员。

⇒ **`this.#privateField` / `this.#privateMethod()` 会直接抛**
`TypeError: Cannot access private method`（实测）。实现 `HandsService` 时：

- ✅ 用公开字段/方法，或**模块作用域的闭包**持有内部状态
- ✅ 构造期捕获 `deps`（findings §1.3 已要求 —— `this.ctx` 也是调用者的）
- ❌ 不要用 `#private`，也不要假设 `this === 服务实例`

### 6.3 流式方法与 M2-8 的交互

`#24` 的落点是 `this[symbols.caller] → .fiber.entry → .options`。流式的麻烦是：
**长流可能活得比调用者的关注点更久**（例如插件已卸载，流还在跑）。

⇒ 两条要求：

1. **归因在调用时定死**（§6.2），这样即使之后 fiber 变化，审计行仍指向发起者。
2. **流的生命周期必须绑 `ctx.effect`** —— 插件卸载即断流。这条**今天未实现、未测**
   （§8 第 4 项），但它是 `ctx.hands` 能被安全授予的前提：**一个卸载后仍在读盘的服务，
   审计也救不了它。**

---

## 7. 多机维度：现在钉「本机/主手」，但**给 SDK 留形状**

`#17`（M2-1，已 closed）已钉死：

> `ctx.shell` 的语义钉为**本机 / 主手**……**多设备定向（「推给哪台设备」）归 `#13`**

⇒ 本提案**遵守**该边界：`ctx.hands` 同样是**本机/主手**。

但 SDK 定版时要预留一件事——**别把「本机」写进类型签名**：

```ts
// ✅ 形状可扩展（未来 #13 落地时加可选 device 参数，不破坏调用方）
read(path: string, opts?: HandsReadOptions): AsyncIterable<Uint8Array>

// ❌ 把「本机」焊进名字/类型，将来要改签名
readLocalFile(path: string): ...
```

理由：**「多机」≠「移动端」**——桌面→桌面、桌面→Web、第二窗口同样成立。
把本机写进类型，会让 #13 落地时变成一次**破坏性**变更。

---

## 8. 反模式（**别做**，每条都有实测代价）

| 反模式 | 代价 | 来源 |
|---|---|---|
| 给手加「打包/遍历技能」 | 策略进错层；实测每文件成本 = 一个 RTT，修法是脑侧批量 | transport-lab §6 |
| 用 kkrpc 出厂的 JSON 载体传二进制 | `Uint8Array` → `{"0":12,…}`，膨胀 11.4x、慢 29.7x，≥1 MiB **基本传不动** | transport-lab §2 |
| 为文件 I/O 上线程池 | 不需要：所有异步文件 API 都不阻塞事件循环（1 GiB 下 ≤3.2 ms） | transport-lab §5 |
| 一次 `Buffer.alloc(fileSize)` | 同步 CPU，1 GiB 冻结循环 ~0.25 s | transport-lab §5 |
| 把 bulk 与 RPC 混在一条带优先级语义的通道 | **kkrpc 没有优先级/QoS**；共享隧道交互 p50 0.66→321 ms | transport-lab §3 + 本次核实 |
| 让手解析 `content://` 为路径 | `into_path()` 对它必然失败 | `rust-crates` §8.1 |

---

## 9. 未解 / 未验证（**SDK 不应假设这些已定**）

1. **单管道队头阻塞的取舍**（§5）—— 三条出路选哪条，**未决**，且需要 SDK 参与。
2. **断点续传的编排**：机制（`seek`）已实测，但**「谁记 offset、何时校验身份、失败如何回退」**
   是脑侧协议，**未设计**。
3. **进度上报的粒度与开销**：**未测**。
4. **流生命周期绑定 `ctx.effect`**：插件卸载时流要自动断 —— **未实现、未测**。
   这是 §6.3 的前提：**卸载后仍在读盘的服务，审计也救不了它。**
5. **审计插针的落地**（§6）：形状已由 `host/src/capability.ts` 给出，但 `ctx.hands`
   尚未实现；**流式方法的「调用时记录一次」需要实测确认**归因落点正确
   （不能只在文档里断言 —— 这正是 findings §1.8 那类**静默**失效）。
   同时 `hands` 必须登记进 `capabilityInventory.ts`，否则契约测试会红。
6. **Android 真机**：文件访问的 SAF fd 桥与 `notify` 的 inotify 后端**都只经过源码阅读**；
   上游 `notify` 的 Android CI **只交叉编译、无设备测试**（比它的 FreeBSD job 验证还少）。
7. **手的文件能力归属哪个里程碑**：**未定**。本提案只提供输入，不主张排期。

---

## 10. 与既有文档的关系

| 本文内容 | 主副本（冲突以它为准） |
|---|---|
| 背压 / 编码 / 队头阻塞 / 批量 / 反模式 | [`probes/transport-lab/FINDINGS.md`](probes/transport-lab/FINDINGS.md) |
| 手侧传输 / 跨机 / Android 授权 | [`probes/hand-io/FINDINGS.md`](probes/hand-io/FINDINGS.md) |
| 用哪些 crate / 文件访问层 / 上游缺陷 | [`probes/hand-io/rust-crates/FINDINGS.md`](probes/hand-io/rust-crates/FINDINGS.md) |
| `notify` 版本 A/B | [`probes/hand-io/notify-version/`](probes/hand-io/notify-version/) |
| 服务写法基准（`extends Service` / 类方法 / 展平） | [`host-sessions-design.md`](host-sessions-design.md) §6.1 |
| Cordis 归因与 inject 纪律 | [`cordis-runtime-findings.md`](cordis-runtime-findings.md) §0/§1 |
| `ctx.shell` 语义与多机边界 | GitHub `#17`（M2-1）、`#13` |
