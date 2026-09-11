# 宿主：会话与设备管理（实现设计稿 · v0）

> 状态：**设计稿（供评审），未实现**。承接需求记录 [`host-sessions.md`](host-sessions.md) 与 issue [#13](https://github.com/VRChatCN-Kipfel/VRCX-K/issues/13)，回答其 §5 的五个待决问题，并给出凭据 / 配对 / 存储 / 接口 / 分级 / 传输的实现设计。
> 日期：2026-09-11。上位：[`architecture-proposal.md`](architecture-proposal.md) §4.8、[`mobile-feasibility.md`](mobile-feasibility.md) §2.1/§7、[`ROADMAP.md`](ROADMAP.md) §4.1。
> 本文**不改动** §4.8「当前决策：不实现」——它只是把该决策落地时需要的东西先设计出来，供立项评审。

## 0. 一句话

**本机脸（ephemeral token）现状不动；新增一层「持久设备凭据 + 会话服务」，把 `host/src/ws.ts:32` 的唯一 choke point 从「比对一次启动 token」换成「问 `ctx.sessions` 要一个会话授权」。** 现有代码里已经具备全部落点，本设计只是把它们串起来。

## 1. 设计原则

1. **本机脸零改动（P0）**：`ready{port,token}` 经本地 IPC 交付、localhost + 一次性 token 这条路**保留**，它是「本机即信任」的 bootstrap，不需要变复杂。
2. **两类凭据，职责正交**：会话票据（ephemeral，服务本机脸）与设备密钥（persistent，服务跨设备）分开，后者**独立于每次启动的 token**（需求记录 §1.1 的推论）。
3. **认证在核心、授权在政策**：核心只回答「你是谁、信任几级」；「你能调什么」由可插拔的政策回答。
4. **凭据跟脑走**：宿主是最终鉴权方。凭据存宿主侧，不存壳、不存脸——脑将来可能跑在服务器上（`mobile-feasibility.md` §1）。
5. **默认最安全**：非 loopback 绑定必须 TLS + 设备凭据，拒绝明文暴露；配对只在可信面显示。

---

## 2. 回答 §5 五个待决问题

| # | 问题 | 决定 | 理由 |
|---|---|---|---|
| 1 | **凭据模型** | **两把钥匙**：① 会话票据（ephemeral，保留现状，只服务本机脸）；② 设备密钥（每设备一对 `{deviceId, secret}`，宿主只存哈希）。**与 VRCX 账号体系解耦** | 两者回答不同问题：票据 = "本机这次启动"，密钥 = "这台设备长期"。VRCX 账号是"访问 VRChat 的能力"，设备密钥是"访问宿主的能力"，正交——换 VRCX 账号不该重配设备 |
| 2 | **配对状态存哪** | **宿主磁盘**（单文件，原子写），路径由壳的 `shell.path.resolve("data")` 提供；**pending 配对只存内存** | 脑是最终鉴权方且将来可能上服务器，凭据必须跟脑；pending 短命，重启即失效更安全。**不存壳/脸** |
| 3 | **核心服务还是插件** | **拆两半**：`ctx.sessions`（核心，认证 + 会话表 + 广播）＋ 授权政策（插件，`ctx.sessions.policy`） | 认证是传输层安全边界，必须始终存在、不依赖插件加载顺序；授权规则随业务演化，适合插件化 |
| 4 | **信任分级** | **三档** `local` / `trusted` / `limited`；**手机 = `trusted`（同一用户，业务同权）**，但**设备管理权默认仅 `local`** | 手机是可丢失设备：业务上该同权，但让一台可能被盗的设备能吊销/接管其他设备会自我锁死 |
| 5 | **与 51 重启 / generation** | 设备密钥**跨重启不变**（设计目标）；**活会话是每进程的，重启即清空**，对端重连 = **新会话**；宿主每次启动生成 **`bootId`**，在握手帧里告知对端"换代" | 壳的 `generation` 是"壳第几次拉起"（`src-tauri/src/host.rs`），与"脑自己的进程身份"不是同一层概念，故引入宿主侧 `bootId` |

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
- 传输：**首帧认证**，不进 URL（见 §6.3）。查询串会进日志/代理，设备凭据不应出现在 URL。
- 生命周期：配对签发 → 使用 → 轮换（重签）→ 吊销（标记 `revokedAt`，校验时拒绝）。
- 与 VRCX 账号：**无耦合**。将来的服务器（L2/L3）可在上层把 `deviceId` 关联到账号，但宿主只认设备密钥。

---

## 4. 配对流程（带外确认 / device-code）

标准「电视配对码」式：**码显示在可信面，密钥只下发给出示了码的对端**。

```
手机(未认证连接)                宿主                        可信面(本机脸/托盘)
    │  connect                      │                              │
    │─────────────────────────────►│  生成 6 位码(TTL 120s,一次性) │
    │                              │─────────────────────────────►│ 显示"配对码 482913"
    │  pair.request{deviceInfo}    │                              │ 用户看到码
    │─────────────────────────────►│                              │
    │  ◄─ pairing-required{code}   │  (码也可只显示、不下发)      │
    │  (用户在手机上输入 482913)     │                              │
    │  pair.submit{code,deviceInfo}│                              │
    │─────────────────────────────►│ 校验: TTL + 一次性 + 匹配     │
    │  ◄─ paired{deviceId,secret}  │ 生成密钥, 存哈希+元数据       │
    │  存 secret(OS keychain)      │                              │
    │  重连 + 首帧认证              │                              │
```

要点：
- **码只在可信面显示**，绝不经未认证通道下发（否则任何能连上的进程都能自助配对）。
- 未认证连接只暴露**配对 API 面**（`pair.request` / `pair.submit`），并限速 + TTL + 一次性；认证成功后该连接要么升级、要么断开重连。
- 无本机脸时（headless / 将来服务器）配对走哪条可信面 = **未决**（见 §12）。

---

## 5. 存储

- **位置**：`shell.path.resolve("data")` 下的 `sessions.json`（路径由壳提供，宿主不自己猜）。
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
- **pending 配对**：只在内存（`Map`），重启即失效。
- **与 F1 数据层的关系**：这是宿主**第一处持久化**，但会话很小且正交，**不等 F1 的 SQLite**。落地时用**一个文件存储**（测试指向临时目录），不预设存储接口；将来 F1 落地后可按同一 schema 迁入。

---

## 6. 接口形状

### 6.1 `ctx.sessions` 服务（照抄 `ctx.tray` 范式）

`host/src/tray.ts:26-30` 的 `declare module "cordis"` + `attachShell` 形状直接复用：

```ts
declare module "cordis" {
  interface Context {
    sessions: SessionService
  }
}

class SessionService {
  // ── 传输层调用（认证 = 唯一 choke point 的新实现）──
  authenticate(req: IncomingMessage): SessionGrant | undefined
  /** 已认证连接注册进会话表；返回句柄用于广播与注销。 */
  register(grant: SessionGrant, socket: WebSocket): SessionHandle

  // ── 广播（宿主 → 脸，当前缺失的方向）──
  broadcast(event: string, payload: unknown, filter?: (s: SessionInfo) => boolean): void

  // ── 设备管理（默认仅 local 档）──
  pair: { request(deviceInfo): Promise<PairingTicket>; submit(code, deviceInfo): Promise<PairedDevice> }
  revoke(deviceId: string): Promise<boolean>
  rotate(deviceId: string): Promise<PairedDevice>

  // ── 可观测 ──
  list(): SessionInfo[]
  onEvent(handler: (e: SessionEvent) => void): () => void   // joined/left/revoked
}
```

装配点：`host/src/index.ts` 与 `ctx.tray` / `ctx.shortcut` 并列 `ctx.provide("sessions", …)`（`index.ts:164-174`）。

### 6.2 `ws.ts` 的 choke point 替换

`host/src/ws.ts:30-38` 改为：

```ts
wss.on("connection", (socket, req) => {
  const grant = ctx.sessions.authenticate(req)          // 票据 或 首帧设备凭据
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

当前 `hostWsAPI` 只有 `ping`/`getVersion`（`host/src/api.ts`、`src/host.ts:9-12`），**宿主没有回推方向**。做法沿用 `kkrpc` 双向范式（同 stdio 的 `tray.action`）：**脸侧 `RPCChannel` 也 `expose` 一个客户端 API**，宿主通过 `controller.getAPI()` 调用它。

```ts
// 脸侧（src/host.ts）新增 expose
{ client: { event(name: string, payload: unknown): void } }
// 宿主侧
session.api.client.event("friend.online", { … })
```

### 6.5 线协议契约

按现有约定放 `contracts/sessions/v1/*.schema.json`（JSON Schema 2020-12，风格同 `contracts/tray-menu.schema.json`），Ajv 校验 + 生成 TS：

- `session-info.schema.json`（`list()` 返回项）
- `pairing.schema.json`（`pair.request/submit`、`paired`）
- `auth.schema.json`（首帧认证帧）

测试沿用 `host/tests/{shortcut,tray}-wire.test.ts` 的 **in-memory transport** 打法。

---

## 7. 传输绑定与端口暴露安全模型

对应 §4.8 点名的「外部访问鉴权 + 端口暴露安全模型」。

- **绑定可配**：`host`/`port` 由 cordis 配置或 env（如 `VRCXK_WS_HOST`/`VRCXK_WS_PORT`）提供，默认仍是 `127.0.0.1` + `0`（随机）。`host/src/ws.ts:16` 的硬编码换成读取配置。
- **非 loopback 强制 TLS**：绑定到非 `127.0.0.1`/`::1` 时，**必须** `wss://` + 设备凭据，否则**拒绝启动**（响亮报错，不静默降级）——「不能只开绑定不改鉴权」（`mobile-feasibility.md` §2.2）。
- **证书**：首选**自签证书 + 指纹 pinning**——首次配对时把证书指纹与配对码一起在可信面确认，客户端 pin。避免在局域网引入 CA 复杂度。证书由用户在配置里提供，或首启生成。
- 端口策略：局域网场景下固定端口更友好（便于手动输入），但仍以配置为准。

---

## 8. 分级授权

### 8.1 信任档

| 档 | 谁 | 来源 |
|---|---|---|
| `local` | 本机第一方脸 | 会话票据（query token） |
| `trusted` | 用户自己配对的设备（手机、第二桌面） | 设备密钥 + 用户带外确认 |
| `limited` | 受限 / 临时（分享链接等，**预留**） | 设备密钥 + 受限标记 |

### 8.2 能力矩阵（草案）

| 能力 | `local` | `trusted` | `limited` |
|---|---|---|---|
| 业务 RPC（F1+ 扩展的 `hostWsAPI`） | ✅ | ✅ | 只读子集（预留） |
| 会话 `list` | ✅ 全部 | ✅（自己） | ❌ |
| 发起配对 | ✅ | ❌ | ❌ |
| 吊销 / 轮换设备 | ✅ | ❌ | ❌ |
| 系统能力经壳（`ctx.shell.*`） | ✅ | 按政策 | ❌ |

### 8.3 授权政策插件化

核心 `SessionService` 只产出 `SessionGrant{ trust, deviceId? }`；**「某 trust 能调哪些方法」由 `ctx.sessions.policy` 决定**，默认实现 = 上表的静态 allow-list，插件可注册更细规则（如按方法名、按业务域）。这样核心不含业务策略。

---

## 9. 与 51 重启 / generation 的关系

- **设备密钥跨重启不变** → 重启后设备**无需重配对**，直接重连。
- **活会话是每进程的**：重启即全部销毁；会话表靠设备重连重建。**不恢复旧连接**（连接是瞬态的，恢复无意义且危险）。
- **`bootId`**：宿主每次进程启动生成一个随机 `bootId`，在握手/`welcome` 帧里带给对端。对端据此判断"脑换了进程"，重置自己的幂等状态。
- 与壳的 `generation` **分层**：`generation`（`src-tauri/src/host.rs`）= 壳第几次拉起宿主，走 `host-ready`（IPC）到脸；`bootId` = 宿主自己的进程身份，走 ws 到所有客户端。两者都要，别合并。

---

## 10. 分阶段落地（供排期）

| 阶段 | 内容 | 风险 | 可独立验收 |
|---|---|---|---|
| **P0** | 现状不变（票据 + localhost） | 无 | — |
| **P1** | 传输抽象：`host`/`port` 可配 + **广播（宿主→脸）** + `bootId` 握手 | 低 | 脸能收宿主主动推送 |
| **P2** | `ctx.sessions` + 设备密钥 + 配对 + 吊销/轮换 + `sessions.json` | 中 | 手机（或第二个脸）配对后免 token 连上 |
| **P3** | 分级授权（policy） | 中 | `trusted` 调管理方法被拒 |
| **P4** | `wss://` + 自签证书 pinning + 非 loopback 守卫 | 中 | 局域网加密连接 |

P1 本身就有独立价值（补上缺失的宿主→脸方向）且不碰鉴权，适合先行。

---

## 11. 可观测

- `ctx.sessions.list()` → UI 显示「当前 N 台设备已连接」（脸 / 托盘）。
- `onEvent` 流（joined / left / revoked）→ 审计日志 + UI 实时更新。
- 审计记录：`deviceId`、动作、时间戳（与 §5 的 `lastSeenAt` 同源）。

---

## 12. 明确不做 / 未决

**不做（沿用既有决策）**
- 服务器 / 远程推送（L2/L3）= **独立架构立项**，本文不设计。
- 与 VRCX 账号体系耦合（见 §3.2）。
- 通用网关抽象、通用鉴权框架——只做「一个服务 + 一处替换」（需求记录 §3）。

**未决（立项时再答）**
- 无本机脸时（headless / 服务器）配对的**可信面**走哪（CLI？托盘？另一台已配对设备？）。
- 证书轮换 / 多用户 / 多脑（一台脸连多个脑）语义。
- Web 客户端特有的 CSRF / Origin 校验（浏览器场景）。

---

## 关联

- 需求记录：[`host-sessions.md`](host-sessions.md)
- 移动端方向：[`mobile-feasibility.md`](mobile-feasibility.md) §2.1 / §7
- 架构期权：[`architecture-proposal.md`](architecture-proposal.md) §4.8
- 追踪 issue：[#13](https://github.com/VRChatCN-Kipfel/VRCX-K/issues/13)
