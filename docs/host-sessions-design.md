# 宿主：会话与设备管理（实现设计稿 · v0.1）

> 状态：**设计稿（供评审），未实现**。承接需求记录 [`host-sessions.md`](host-sessions.md) 与 issue [#13](https://github.com/VRChatCN-Kipfel/VRCX-K/issues/13)，回答其 §5 的五个待决问题，并给出凭据 / 配对 / 存储 / 接口 / 分级 / 传输的实现设计。
> 日期：2026-09-11。上位：[`architecture-proposal.md`](architecture-proposal.md) §4.8、[`mobile-feasibility.md`](mobile-feasibility.md) §2.1/§2.3/§7、[`adr-plugin-layout.md`](adr-plugin-layout.md)、[`ROADMAP.md`](ROADMAP.md) §4.1。
> 本文**不改动** §4.8「当前决策：不实现」——它只是把该决策落地时需要的东西先设计出来，供立项评审。
> **v0.1 修订**（评审回复）：B1 服务改为 `extends Service`（否则零归因）；B2 状态目录改走 ADR 的 `$VRCXK_USER_DIR`（不走 `shell.path.resolve("data")`）；B3 §4 配对图不再向未认证连接下发配对码；并处理 N1–N17 与未覆盖项（见各节 `▸ 评审` 标注）。

## 0. 一句话

**本机脸（ephemeral token）现状不动；新增一层「持久设备凭据 + 会话服务」，把 `host/src/ws.ts:32` 的唯一 choke point 从「比对一次启动 token」换成「问 `ctx.sessions` 要一个会话授权」。** 现有代码里已经具备全部落点，本设计只是把它们串起来。

## 1. 设计原则

1. **本机脸零改动（P0）**：`ready{port,token}` 经本地 IPC 交付、localhost + 一次性 token 这条路**保留**，它是「本机即信任」的 bootstrap，不需要变复杂。
2. **两类凭据，职责正交**：会话票据（ephemeral，服务本机脸）与设备密钥（persistent，服务跨设备）分开，后者**独立于每次启动的 token**（需求记录 §1.1 的推论）。
3. **认证在核心、授权在政策**：核心只回答「你是谁、信任几级」；「你能调什么」由可插拔的政策回答。
4. **凭据跟脑走**：宿主是最终鉴权方。凭据存宿主侧，不存壳、不存脸——脑将来可能跑在服务器上（`mobile-feasibility.md` §1）。
5. **默认最安全**：非 loopback 绑定必须 TLS + 设备凭据，拒绝明文暴露；配对只在可信面显示。
6. **安全边界服务必须可归因**：`ctx.sessions` 是传输层安全边界，调用者身份（哪个插件吊销了设备 / 广播了什么）必须可回答 ⇒ 必须是 cordis `Service` 子类（`cordis-runtime-findings.md` §0 / §1.2）。

---

## 2. 回答 §5 五个待决问题

| # | 问题 | 决定 | 理由 |
|---|---|---|---|
| 1 | **凭据模型** | **两把钥匙**：① 会话票据（ephemeral，保留现状，只服务本机脸）；② 设备密钥（每设备一对 `{deviceId, secret}`，宿主只存哈希）。**与 VRCX 账号体系解耦** | 两者回答不同问题：票据 = "本机这次启动"，密钥 = "这台设备长期"。VRCX 账号是"访问 VRChat 的能力"，设备密钥是"访问宿主的能力"，正交——换 VRCX 账号不该重配设备 |
| 2 | **配对状态存哪** | **宿主磁盘**（单文件，原子写），路径 = **`$VRCXK_USER_DIR/sessions.json`**（壳 spawn 时注入，ADR [`adr-plugin-layout.md`](adr-plugin-layout.md) §4.3；与宿主另一处持久状态 `base-state.json` **同目录同来源**）；**pending 配对只存内存** | 脑是最终鉴权方且将来可能上服务器，凭据必须跟脑；pending 短命，重启即失效更安全。**不存壳/脸**。▸ 评审 B2：**不走 `shell.path.resolve("data")`**——那条走 stdio 桥、仅在 `VRCXK_SHELL=1` 时可用（`dev:host`/headless 拿不到，见 `host/src/index.ts:241-243`），且该 kind 就是 `app_data_dir()`（`src-tauri/src/shell_sys.rs`），正是 ADR 明令禁止的「第二处状态目录」 |
| 3 | **核心服务还是插件** | **拆两半**：`ctx.sessions`（核心，**`extends Service`**：认证 + 会话表 + 广播）＋ 授权政策（插件，注册为**独立服务 `ctx.sessionPolicy`**，**不挂在 `ctx.sessions` 上**） | 认证是传输层安全边界，必须始终存在、不依赖插件加载顺序；授权规则随业务演化，适合插件化。**必须 `extends Service`**：`ctx.provide` 的普通对象**零归因**（findings §0/§1.2），而这是特权面服务，将来做 §8 授权判定 / §11 审计时无法回答"哪个插件做了动作" |
| 4 | **信任分级** | **三档** `local` / `trusted` / `limited`；**手机 = `trusted`（同一用户，业务同权）**，但**设备管理权默认仅 `local`** | 手机是可丢失设备：业务上该同权，但让一台可能被盗的设备能吊销/接管其他设备会自我锁死 |
| 5 | **与 51 重启 / generation** | 设备密钥**跨重启不变**（设计目标）；**活会话是每进程的，重启即清空**，对端重连 = **新会话**；宿主每次启动生成 **`bootId`**，在握手帧里告知对端"换代" | 壳的 `generation` 是"壳第几次拉起"（`src-tauri/src/host.rs`），**随 `host-lifecycle` 快照事件**到脸（`src-tauri/src/lib.rs`）——**不是 `host-ready`**（该 DTO 只有 `{port,token}`）；`bootId` 是宿主自己的进程身份。两者分层，不合并（详见 §9） |

---

## 3. 凭据模型

### 3.1 会话票据（ephemeral，保留）

- 生成：`randomBytes(32).toString("hex")`（`host/src/ws.ts:15`），**每次启动重新生成**。
- 交付：`ready{port,token}` → stdio → 壳 → Tauri IPC → 脸（`host/src/index.ts:238-243`、`src/App.tsx:120,126`）。
- 校验：连接 query 里的 `?token=`，命中即 `local` 档（`host/src/ws.ts:32`）。
- 安全边界：只经**本机 IPC** 交付 + 只监听 loopback，故明文 `ws://` 可接受（`architecture-proposal.md` §1.3）。

### 3.2 设备密钥（persistent，新增）

- 形态：每设备 `{ deviceId, secret }`；`secret` = 32 字节随机（高熵）。
- **宿主只存 `sha256(secret)`**（每设备独立 salt 可选）。高熵随机 key 不需要慢哈希（argon2 用于低熵口令，这里不是口令）。
- 校验：哈希比较用**恒定时间比较**（`crypto.timingSafeEqual`），避免时序侧信道。▸ 评审 N15。
- 编码：`secret` 线上/落盘编码定为 **hex**（与票据一致），文档写死，避免 hex/base64 漂移。
- 传输：**首帧认证**，不进 URL（见 §6.3）。查询串会进日志/代理，设备凭据不应出现在 URL。
- 生命周期：配对签发 → 使用 → 轮换（重签）→ 吊销（标记 `revokedAt`，校验时拒绝；**并立即关闭该设备的活连接**，见 §12）。
- 与 VRCX 账号：**无耦合**。将来的服务器（L2/L3）可在上层把 `deviceId` 关联到账号，但宿主只认设备密钥。

---

## 4. 配对流程（带外确认 / device-code）

标准「电视配对码」式：**码只显示在可信面，密钥只下发给出示了码的对端**。

```
手机(未认证连接)                宿主                        可信面(本机脸/托盘)
    │  connect                      │                              │
    │─────────────────────────────►│  生成 6 位码(TTL 120s,一次性) │
    │                              │─────────────────────────────►│ 显示"配对码 482913"
    │  pair.request{deviceInfo}    │                              │ 用户看到码
    │─────────────────────────────►│                              │
    │  ◄─ pairing-required{status} │  ← 只回状态/nonce，**绝不含码** │
    │  (用户在手机上输入 482913)     │                              │
    │  pair.submit{code,deviceInfo}│                              │
    │─────────────────────────────►│ 校验: TTL + 一次性 + 匹配     │
    │  ◄─ paired{deviceId,secret}  │ 生成密钥, 存哈希+元数据       │
    │  存 secret(OS keychain)      │                              │
    │  重连 + 首帧认证              │                              │
```

要点：
- **码只在可信面显示**，绝不经未认证通道下发（否则任何能连上的进程都能自助配对）。▸ 评审 B3：`pairing-required` 只回 `{status}` / nonce，**不携带码**。
- **可信面不能只依赖窗口可见**：主窗口关窗即 hide（托盘常驻，`src-tauri/src/lib.rs` 的 `CloseRequested` 分支），故码至少要有**一条不依赖窗口可见的通道**——托盘 item 或 `shell.notify`。▸ 评审 N10。
- **未认证连接只暴露配对 API 面**（`pair.request` / `pair.submit`），并**限速 + 尝试上限 + 失败锁定 + 按远端地址限速**；6 位码（10^6 空间）+ 120s TTL 在 LAN 上可被在线爆破，必须有尝试次数上限。▸ 评审 B3 附注。
- 认证成功后该连接要么升级、要么断开重连。
- 无本机脸时（headless / 将来服务器）配对走哪条可信面 = **未决**（见 §12）。

---

## 5. 存储

- **位置**：**`$VRCXK_USER_DIR/sessions.json`**（壳 spawn 时注入 `VRCXK_USER_DIR`，ADR §4.3；宿主不自己猜路径，也不调用 `app_data_dir()`）。▸ 评审 B2。
  - **先决依赖**：ADR 的三个 spawn 期 env（含 `VRCXK_USER_DIR`）**尚未实现**（全仓无 `VRCXK_USER_DIR`，壳今天只注入 `VRCXK_SHELL`）⇒ P2 对 ADR §4.3 有一条未列出的前置依赖。
  - 与 `base-state.json`（ADR 已定的另一处宿主持久状态）**同目录同来源**，避免第三处状态目录。
- **格式**（草案，v1）：

```jsonc
{
  "version": 1,
  "devices": [
    {
      "id": "d-7f3a…",
      "label": "My Phone",
      "platform": "android",
      "keyHash": "sha256:…",
      "salt": "…",              // 可选
      "trust": "trusted",
      "createdAt": 1757000000000,
      "lastSeenAt": 1757000000000,
      "revokedAt": null
    }
  ]
}
```

- **原子写**：写临时文件 + `rename`，避免半截文件。
- **文件权限**：该文件就是 allowlist 本体 ⇒ 权限收紧到仅属主可读写；**删除即全部设备解绑**，备份/删除语义需在文档写明。▸ 评审 N15。
- **pending 配对**：只在内存（`Map`），重启即失效。
- **与 F1 数据层的关系**：会话数据小且正交，**不等 F1 的 SQLite**。落地时用**一个文件存储**（测试指向临时目录），不预设存储接口；将来 F1 落地后可按同一 schema 迁入。（v0 称"宿主第一处持久化"，`base-state.json` 落地后即不再成立，此处已收窄。）

---

## 6. 接口形状

### 6.1 `ctx.sessions` 服务（**`extends Service`**）

▸ 评审 B1：**不能照抄 `ctx.tray` 的普通 class 形状**。`TrayService` / `ShortcutService` 今天是普通 class、零归因（findings §1.13），团队已拍板迁移（findings §2 表末行 / `AGENTS.md` 已知坑）。新服务直接按正确形状写：

```ts
declare module "cordis" {
  interface Context {
    sessions: SessionService
    sessionPolicy: SessionPolicy   // 政策是独立服务，不是 ctx.sessions 的属性（见 §8.3）
  }
}

// 必须 extends Service：ctx.provide 的普通对象零归因（findings §0/§1.2）。
class SessionService extends Service {
  // 构造期捕获自身依赖。Service 的 per-caller 代理上 this.ctx 是「调用者的 ctx」，
  // 不是提供者的（findings §1.3）——所以方法里不要用 this.ctx 取 logger/配置/设备表。
  constructor(ctx: Context, deps: SessionDeps) {
    super(ctx, "sessions")
    this.deps = deps
  }

  // 方法必须是类方法：写成箭头函数属性会【静默】丢归因（findings §1.8）。
  // ▸ 评审 N1：async 且带 socket —— 首帧认证需要等对端发第一帧（见 §6.3）。
  async authenticate(req: IncomingMessage, socket: WebSocket): Promise<SessionGrant | undefined>
  register(grant: SessionGrant, socket: WebSocket): SessionHandle
  broadcast(event: string, payload: unknown, filter?: (s: SessionInfo) => boolean): void

  // 展平命名空间：Service 上的「普通对象」属性同样丢归因（findings §1.7）。
  // v0 的 `pair: { request, submit }` 拆成两个类方法。
  pairRequest(deviceInfo: DeviceInfo): Promise<PairingTicket>
  pairSubmit(code: string, deviceInfo: DeviceInfo): Promise<PairedDevice>
  revoke(deviceId: string): Promise<boolean>
  rotate(deviceId: string): Promise<PairedDevice>

  list(): SessionInfo[]
  onEvent(handler: (e: SessionEvent) => void): () => void   // joined/left/revoked
}
```

装配点：`host/src/index.ts` 与 `ctx.tray` / `ctx.shortcut` 并列，但**用 `new SessionService(ctx, deps)`**——`Service` 构造函数会自动 `provide`（`cordis/lib/index.js` 的 `self.ctx.reflect.provide(name, self, …)`），**不再 `ctx.provide("sessions", …)`**。

▸ 评审 N16：迁移到 `Service` 后**单测构造方式会变**（需要真 ctx）。照 `host/tests/tray-service.test.ts` 的既有习惯：**纯逻辑**（凭据哈希、码校验、TTL、会话表操作）留**无 ctx 的导出函数**做单测，`Service` 只做装配。

### 6.2 `ws.ts` 的 choke point 替换

`host/src/ws.ts:30-38` 改为（`authenticate` 现在是 async，见 §6.3）：

```ts
wss.on("connection", async (socket, req) => {
  const grant = await ctx.sessions.authenticate(req, socket)   // 票据命中即返回；否则等首帧（超时 close）
  if (!grant) { socket.close(1008, "unauthorized"); return }
  const controller = expose(hostWsAPI, webSocketTransport(socket))
  const handle = ctx.sessions.register(grant, socket)
  socket.once("close", () => handle.dispose())
})
```

`authenticate` 内部：query `token` 命中 → `local`；否则等**首帧** `auth{deviceId,secret}`（超时 close）→ 命中设备 → 该设备 `trust`。未认证连接只进配对面（§4）。

### 6.3 首帧认证（为什么不是 URL）

浏览器/WebView 无法给 WebSocket 设自定义 header，只能用 URL query 或子协议；两者都会进日志。故：

- **本机脸**：沿用 query `token`（localhost + IPC 交付，安全）。
- **设备**：连接后**第一条 ws 消息**发 `{ auth: { deviceId, secret } }`，宿主校验通过才 `expose` kkrpc。URL 里不出现密钥。

### 6.4 广播：宿主 → 脸

当前 `hostWsAPI` 只有 `ping`/`getVersion`（`host/src/api.ts`、`src/host.ts:9-12`），**宿主没有回推方向**。做法沿用 `kkrpc` 双向范式（同 stdio 的 `tray.action`）：**脸侧 `RPCChannel` 也 `expose` 一个客户端 API**，宿主通过它回推。

```ts
// 脸侧（src/host.ts）新增 expose
{ client: { event(name: string, payload: unknown): void } }
// 宿主侧：expose() 返回 ExposedController{ channel, dispose }，API 在 channel 上
session.channel.getAPI().client.event("friend.online", { … })
```

▸ 评审 N2：是 **`channel.getAPI()`**，不是 `controller.getAPI()`——`expose()` 返回 `ExposedController{channel, dispose}`，本仓库现有代码即 `host/src/stdio.ts:332` 的 `channel.getAPI()`。并给出 `expose<HostWsAPI, ClientWsAPI>` 的类型参数。

### 6.5 线协议契约

按现有约定放 `contracts/sessions/v1/*.schema.json`（JSON Schema 2020-12，风格同 `contracts/tray-menu.schema.json`），Ajv 校验 + 生成 TS：

- `session-info.schema.json`（`list()` 返回项）
- `pairing.schema.json`（`pair.request/submit`、`paired`）
- `auth.schema.json`（首帧认证帧）

▸ 评审未覆盖 #3：`SessionInfo` 形状要含**连接时间**与**远端地址**（LAN 场景审计常用），不能只列文件名。

测试沿用 `host/tests/{shortcut,tray}-wire.test.ts` 的 **in-memory transport** 打法。

---

## 7. 传输绑定与端口暴露安全模型

对应 §4.8 点名的「外部访问鉴权 + 端口暴露安全模型」。

- **绑定可配**：`host`/`port` 由 cordis 配置或 env（如 `VRCXK_WS_HOST`/`VRCXK_WS_PORT`）提供，默认仍是 `127.0.0.1` + `0`（随机）。`host/src/ws.ts:16` 的硬编码 `new WebSocketServer({ host: "127.0.0.1", port: 0 })` 换成读取配置。
- **脸侧前置**：只改宿主绑定**不够**。脸侧 `src/host.ts:15` 硬编码 `ws://127.0.0.1`、`HostReady` 只有 `{port, token}`（`host/src/ws.ts:9-12`）；`mobile-feasibility.md` §2.1 要求 `HostReady` 承载**完整端点**。§10 的 P1/P2 需含脸侧改动与边界。▸ 评审 N9。
- **非 loopback 强制 TLS**：绑定到非 `127.0.0.1`/`::1` 时，**必须** `wss://` + 设备凭据，否则**拒绝启动**（响亮报错，不静默降级）——「不能只开绑定不改鉴权」（`mobile-feasibility.md` §2.2）。
- **TLS 的宿主实现形态**：`new WebSocketServer({host, port})` **不能直接 TLS**；需 `https.createServer({cert, key})` + `new WebSocketServer({ server })`。证书/私钥**存放位置、文件权限、轮换**须定（且须落 ADR 用户目录，与 §5 同源）。▸ 评审 N11。
- **证书信任的鸡生蛋**：device-code 只证明「用户在场」，**不证明对端是那台脑** ⇒ 局域网 MITM 可代理配对并转交码。至少一条缓解：双端显示**证书指纹（SAS）** / 配对码做 PAKE / 让用户把证书装进设备信任库。▸ 评审 N17。
- **客户端 pinning 在手机侧结构上可能做不到**：kkrpc 客户端 transport 只接受 `{url, protocols}` 并用「ambient WebSocket」⇒ 脸（WebView 的 JS）**没有实现 pinning 的地方**。要么改原生 transport，要么让用户装 CA/用真证书。设计稿不能只写「客户端 pin」了事。▸ 评审未覆盖 #7。
- 端口策略：局域网场景下固定端口更友好（便于手动输入），但仍以配置为准。

---

## 8. 分级授权

### 8.1 信任档

| 档 | 谁 | 来源 |
|---|---|---|
| `local` | 本机第一方脸 | 会话票据（query token） |
| `trusted` | 用户自己配对的设备（手机、第二桌面） | 设备密钥 + 用户带外确认 |
| `limited` | 受限 / 临时（分享链接等，**预留**） | 设备密钥 + 受限标记 |

### 8.2 能力矩阵（**按 ws RPC 方法**）

▸ 评审 N4：矩阵按**客户端能调的 ws RPC 方法**维度写。`ctx.shell.*` 是 **host→壳 的内部桥**（`host/src/stdio.ts:113-159`），**客户端调不到**，放进矩阵是类别错误；客户端能调的是 `hostWsAPI`（`host/src/api.ts`、`ws.ts:36`）。

| ws RPC 方法 | `local` | `trusted` | `limited` |
|---|---|---|---|
| `ping` / `getVersion` | ✅ | ✅ | ✅ |
| 业务 RPC（F1+ 扩展的 `hostWsAPI`） | ✅ | ✅ | 只读子集（预留） |
| `sessions.list` | ✅ 全部 | ✅ **仅自己**（或仅聚合计数，见 §11） | ❌ |
| `sessions.pairRequest` / `pairSubmit` | ✅ | ❌ | ❌ |
| `sessions.revoke` / `rotate` | ✅ | ❌ | ❌ |

▸ 评审 N6：`trusted` 的 `list` 只看自己，与 §11「UI 显示当前 N 台设备已连接」冲突（手机拿不到 N）。二者取一：给 `trusted` 一个**聚合计数**（只数不列），或把 §11 的 UI 限定为**本机面**。

### 8.3 授权政策插件化 + 执行点

核心 `SessionService` 只产出 `SessionGrant{ trust, deviceId? }`；**「某 trust 能调哪些方法」由独立服务 `ctx.sessionPolicy` 决定**，默认实现 = §8.2 的静态 allow-list，插件可注册更细规则（按方法名、按业务域）。

- ▸ 评审 N3：政策**不能挂在 `ctx.sessions` 上**（给非提供者 fiber 的服务实例 set 属性会抛 `cannot set property … without provide`，`cordis/lib/index.js`）。故政策是**独立 provided 服务**，或 `SessionService` 显式提供 `setPolicy()`。
- ▸ 评审 N5：**执行点当前缺口**。`expose(hostWsAPI, …)` 把整个 API 面暴露给任何已认证连接，方法级 allow-list 现在**无处落地**。指名 kkrpc 2.1.0 的**接收侧 middleware**：`middlewarePlugin` + `RPCCallContext.method`（`kkrpc/dist/middleware.d.ts`），挂到 `RPCChannelOptions.plugins`。§10 的 P3 依赖它。

---

## 9. 与 51 重启 / generation 的关系

- **设备密钥跨重启不变** → 重启后设备**无需重配对**，直接重连。
- **活会话是每进程的**：重启即全部销毁；会话表靠设备重连重建。**不恢复旧连接**（连接是瞬态的，恢复无意义且危险）。
- **`bootId`**：宿主每次进程启动生成一个随机 `bootId`（字符串/uuid），在握手/`welcome` 帧里带给对端。对端据此判断"脑换了进程"，重置自己的幂等状态。
- **与壳的 `generation` 分层**：`generation` = 壳第几次拉起宿主（`src-tauri/src/host.rs`），**随 `host-lifecycle` 快照事件**到脸（`src-tauri/src/lib.rs`）——**不是 `host-ready`**（该 DTO 只有 `{port,token}`）；`bootId` = 宿主自己的进程身份，走 ws 到所有客户端。两者都要，别合并。▸ 评审 N7。
- ▸ 评审 N8 **现成缺口**：托盘 schema 的 `generation` 恒 0（host 不送有意义的值，见 `host/src/tray.ts` / `src-tauri/src/tray.rs` 注释）。P1 明确二选一：壳 spawn 时注入 `VRCXK_GENERATION`（顺手补上托盘那个恒 0）**或**明确该字段长期为 0。**`bootId` 是字符串/uuid，不进托盘 schema**（该 schema 拒超 safe-integer 的代际，`src-tauri/src/tray_schema.rs`）。

---

## 10. 分阶段落地（供排期）

| 阶段 | 内容 | 前置依赖 | 风险 | 可独立验收 |
|---|---|---|---|---|
| **P0** | 现状不变（票据 + localhost） | — | 无 | — |
| **P1** | 传输抽象：`host`/`port` 可配 + **广播（宿主→脸）** + `bootId` 握手（含 §9 generation 缺口决策） | 脸侧需能消费完整端点（N9） | 低 | 脸能收宿主主动推送 |
| **P2** | `ctx.sessions` + 设备密钥 + 配对 + 吊销/轮换 + `sessions.json` | **ADR §4.3 的 `VRCXK_USER_DIR` 注入落地**（B2） | 中 | 第二个**本机脸**配对后免 token 连上（手机需等 P4，见下） |
| **P3** | 分级授权（`ctx.sessionPolicy`） | P2 + **kkrpc 接收侧 middleware 执行点**（N5） | 中 | `trusted` 调管理方法被拒 |
| **P4** | `wss://` + 自签证书 + 非 loopback 守卫 | P2 | 中 | 局域网加密连接 |

▸ 评审 N13 **阶段验收的隐藏依赖**（逐条标注）：
- P2 的「**手机**配对后免 token 连上」在 P2 **不可验证**：§7 自己禁止非 loopback 明文 ⇒ 手机须等 P4；P2 实际只能验「第二个**本机**脸」。
- P1 的「host/port 可配」在脸侧被 N9 阻塞（脸仍硬编码 `ws://127.0.0.1`）。
- P3 依赖 P2 + 一个**未设计**的执行点（N5）。

▸ 评审 N14：P1 的「补宿主→脸广播方向」是**当前架构缺口**，与多客户端立项无关，建议**拆成独立 issue**，不要绑在 §4.8「不实现」的上下文里。

---

## 11. 可观测

- `ctx.sessions.list()` → UI 显示「当前 N 台设备已连接」（脸 / 托盘）。`trusted` 侧的可见性见 §8.2 / N6。
- `onEvent` 流（joined / left / revoked）→ 审计日志 + UI 实时更新。
- 审计记录：`deviceId`、动作、时间戳（与 §5 的 `lastSeenAt` 同源）。
- ▸ 评审 N12 **审计落点缺口**：host 日志走 stderr（`host/src/log.ts`），而 stderr 被壳 `Stdio::inherit()`（`src-tauri/src/host.rs`）⇒ 打包 GUI 无控制台，**审计留不下来**。须明确审计 sink（文件 / 日志服务）与保留 / 轮转策略。
- ▸ 评审未覆盖 #2：审计**不含调用者身份**——「哪台设备做了什么」能答，「**哪个插件**做了什么」答不了。这与 B1 同源，靠 `Service` 归因补齐。

---

## 12. 明确不做 / 未决

**不做（沿用既有决策）**
- 服务器 / 远程推送（L2/L3）= **独立架构立项**，本文不设计。
- 与 VRCX 账号体系耦合（见 §3.2）。
- 通用网关抽象、通用鉴权框架——只做「一个服务 + 一处替换」（需求记录 §3）。

**本轮补入的缺口（§2.6 生命周期策略 / §2.7 可观测）**
- **连接数上限**、**空闲/超时**、**心跳与断连检测**（需求记录 §2.6 未覆盖，v0 未提）。
- **`revoked` 是否立即关闭活连接**：决定为**是**（§3.2），需实现并在测试中钉住。
- **重连语义**：客户端重连 = 新会话，但**无重连节流/风暴抑制**（壳侧已有成熟 storm/backoff，`src-tauri/src/host.rs` 的 `STABLE_WINDOW`）；也无 `bootId` 变化时客户端**应做什么**的契约。

**未决（立项时再答）**
- 无本机脸时（headless / 服务器）配对的**可信面**走哪（CLI？托盘？另一台已配对设备？）。
- **证书/私钥来源与指纹确认方式**（§7）。
- **审计落点 / 保留**（§11）。
- **连接上限与空闲策略**（上）。
- 证书轮换 / 多用户 / 多脑（一台脸连多个脑）语义。
- Web 客户端特有的 CSRF / Origin 校验（浏览器场景）。

---

## 13. 与 ADR / 移动端的关系

▸ 评审未覆盖 #5 / #6：v0 缺这一章，是 B2 的根因。

- **用户目录（ADR [`adr-plugin-layout.md`](adr-plugin-layout.md)）**：用户目录 = `config_dir()/VRCX-K`，**项目内一律不调用 `app_config_dir()` / `app_data_dir()` / `app_local_data_dir()`**，统一走一处解析器；壳在 spawn 时注入 **`VRCXK_USER_DIR`**。宿主**没有任何** app 目录概念 ⇒ 布局跨目录时**壳必须把目录告诉宿主**。`sessions.json` 与 `base-state.json` 同走此来源（§5）。ADR §4.3 的 env 注入**尚未实现**，是 P2 的先决依赖。
- **移动端（[`mobile-feasibility.md`](mobile-feasibility.md) §2.3）**：脑远程后 **脑⇄手 stdio 断**，系统能力须**经脸转达**（且要求脸活着）。这直接影响「系统能力经壳」那一行——在「手机连桌面脑」的目标场景下，该行**没有实现路径**。§8.2 已按 ws RPC 方法重写以回避这个类别错误，但系统能力如何跨端转达仍是待设计项。

---

## 关联

- 需求记录：[`host-sessions.md`](host-sessions.md)
- 移动端方向：[`mobile-feasibility.md`](mobile-feasibility.md) §2.1 / §2.3 / §7
- 目录布局 ADR：[`adr-plugin-layout.md`](adr-plugin-layout.md)
- Cordis 运行时实测：[`cordis-runtime-findings.md`](cordis-runtime-findings.md)
- 架构期权：[`architecture-proposal.md`](architecture-proposal.md) §4.8
- 追踪 issue：[#13](https://github.com/VRChatCN-Kipfel/VRCX-K/issues/13)
