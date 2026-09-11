# 移动端方案（Android / iOS）

> 状态：**方向已定，未实现**。
> 最后更新：2026-09-11（**第二版：整体推翻初版的问题框架**，见 §0.2）。
> 上游结论均有出处；**本项目未亲自验证的一律标注**。

## 0. 结论

### 0.1 一句话

**移动端不是"把宿主搬到手机上"，而是"第三端"** —— 手机 = **脸 + 手**，**脑留在桌面或服务器**。三端 RPC 架构（`docs/architecture-proposal.md` §4.8，设计阶段已预留为"期权价值"）使这一点成立：`脸⇄脑` 本来就是 `kkrpc/ws`，**换地址即可换位置**。

### 0.2 ⚠️ 初版文档的错误（本版推翻）

初版把问题框成"**如何让 bun 宿主在 Android 上跑起来**"，据此调研了 execve/SELinux、内嵌 JS 引擎、`jniLibs` 变通等，结论是"不建议移植"。**这个框架本身就是错的**，因为：

> 架构文档 §4.8 早已写明：*"业务主通道选 kkrpc/ws（非 Tauri 私有 IPC）使「大脑 = Cordis 宿主」天然是本地服务形态——同一 API 面未来可被其他客户端复用"*，并把 **"移动客户端（手机连桌面宿主，需局域网 + TLS + 配对）"** 列为预留方向。

**宿主根本不需要在手机上。** 一旦认清这点：

| 初版纠结的问题 | 正确框架下 |
|---|---|
| Android 禁 `execve` 怎么办 | **不存在**——手机上没有二进制要 exec |
| 要不要内嵌 JS 引擎（mozjs/deno_core） | **不需要** |
| 每 ABI ~85–90MB 的 bun 产物 | **不需要** |
| "保 kkrpc 契约 ≠ 保 Cordis/JS 插件生态"这个两难 | **消失了**——插件跟着脑走，**生态零损耗** |

初版的调研内容（execve/W^X 机制、bun Android 实测）**没有浪费**，它们现在的用途是：**证明"手机本地跑宿主"这条路确实很贵**，从而反证"客户端"是正确选择。保留于 §4。

### 0.3 真正的工程量在"三通道里断掉的那一条"

三端 RPC 是**三条**通道，脑远程化只打断**一条**：

| 通道 | 实现 | 脑搬到远端后 | 需要做什么 |
|---|---|---|---|
| 脸 ⇄ 脑 | `kkrpc/ws`（`src/host.ts`） | ✅ 存活 | **URL 可配置 + TLS + 配对**（§2.1） |
| 脸 ⇄ 手 | Tauri IPC（`App.tsx`） | ✅ 存活（本就本地） | 几乎不用动 |
| 脑 ⇄ 手 | `kkrpc/stdio`（`host/src/stdio.ts` ↔ `Peer::new(stdin)`） | ❌ **断** | **必须换通道**（§2.3） |

第三条是**子进程管道**（`host.rs:1060` 的 `Peer::new(stdin)`），前提是"脑是本机子进程"。脑一远程，这个前提消失。

---

## 1. 正确形态：三端各处其位

```
┌──────────── 手机（Tauri App）────────────┐
│  脸 React                                │
│    ├─ Tauri IPC ──→ 手（Rust 壳）        │  本地，系统能力
│    └─ kkrpc/ws ────┐                     │  出站连接（NAT 友好）
└────────────────────┼─────────────────────┘
                     │  TLS + 配对
        ┌────────────▼─────────────┐
        │  脑 Cordis 宿主 + 插件    │  ← 桌面机 或 服务器
        │  （Cordis/JS 插件全部在此）│
        └──────────────────────────┘
```

**要点**：
- 插件**跟着脑走**，因此不损失生态——这是本方案最大的收益。
- 手机侧只有"脸（UI）+ 手（系统能力）"，两者都是**轻**组件。
- 手机是**出站**连接（`ws` 客户端），天然友好于 NAT/移动网络；不需要手机开放入站端口。
- 脑可以有两种部署：**(a) 用户自己的桌面机**（局域网/远程），**(b) 托管服务器**。(b) 正是已立项待做的 **L2/L3「推送 + 服务器」**，两者应**合并设计**。

---

## 2. 需要实现的工程项

### 2.1 脸：端点可配置 + TLS + 配对（原 §4.8 所说"外部访问鉴权"）

当前 `src/host.ts:15` **硬编码**：

```ts
return `ws://127.0.0.1:${ready.port}?token=${ready.token}`
```

`HostReady = { port, token }`（`App.tsx:120/126` 经 Tauri IPC 取得）——**语义上已经是一次"连接信息交付"**，只是被写死成 localhost + 明文。

需要：
- `HostReady` 承载**完整端点**（scheme + host + port），而非只有 port；或引入"配对结果"作为端点来源。
- `wss://`（TLS）。**明文 ws 只能用于 localhost**；跨设备必须加密。
- **配对流程**：当前的 `token` 是**每次启动随机生成、经本地 IPC 交付的一次性会话凭据**，**不能**当作跨设备长期凭据。需要真正的配对（用户确认 + 持久凭据 + 吊销）。
- 会话凭据要有**过期与轮换**。

### 2.2 脑：绑定与暴露

`host/src/ws.ts:16` **硬编码**监听 localhost：

```ts
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 })
```

若脑在桌面、手机经局域网连接，则需要**可配置绑定接口**（以及端口策略）。这属于 §4.8 点明的"**端口暴露安全模型**"，必须与 §2.1 的鉴权一起做，不能只开绑定不改鉴权。

### 2.3 脑 ⇄ 手：stdio 断掉后的替代（**本方案的核心新增设计**）

脑远程后无法再用进程管道请求设备能力（"弹个通知""打开文件选择"）。可选路径：

| 方案 | 机制 | 评价 |
|---|---|---|
| **(a) 经脸转达** | 脑 → `ws` → 脸 → Tauri IPC → 手 | **推荐**。脸同时握有两条本地通道（§0.3 表），是天然的转发点；且手机本就是出站连接。代价：多一跳；**要求脸活着** |
| (b) 手直接暴露 ws | 手自己起一个 ws 端点，脑直连 | 手机需可被入站连接（NAT/省电不友好），且要重建鉴权 |
| (c) 能力发起方本地化 | 需要系统能力的动作改由**脸**发起（脸本就在本地） | 适用于 UI 触发的动作；**不适用于脑主动触发**（如"好友上线提醒"） |

**关键约束（→ 收敛到 L2/L3）**：方案 (a) 要求"脸活着"。**应用未运行/被后台挂起时，脑无法触达设备** —— 这正是需要 **推送（FCM/APNs）唤醒** 的场景。所以：

> **移动端的"系统能力触达"与"推送唤醒"是同一个问题**，应作为 L2/L3 的一部分统一设计，而不是两个独立议题。

### 2.4 手：移动端能力面（已部分完成）

`shell.*` 是**契约**，移动端是"同契约、另一套实现"。已完成的门控见 §5；剩余需补的移动端**新增面**（桌面不存在）：运行时权限（Android 13+ `POST_NOTIFICATIONS`）、通知 channel、FGS 语义、Intent 跳转。

---

## 3. 为什么"手机本地跑宿主"很贵（初版调研的复用）

保留此节作为**"为什么选客户端而非本地宿主"的证据**，而不是作为主方案。

### 3.1 `execve` 被 SELinux 禁止（`targetSdk ≥ 29`）

`system/sepolicy/private/app_neverallows.te`（**本项目亲自核对**，LineageOS `lineage-20.0 ~ 23.0` = Android 13 ~ **16** 一致）：

```
# Block calling execve() on files in an apps home directory.
# This is a W^X violation (loading executable code from a writable
# home directory). For compatibility, allow for targetApi <= 28.
# b/112357170
neverallow {
  all_untrusted_apps
  -untrusted_app_25
  -untrusted_app_27
  -runas_app
} { app_data_file privapp_data_file }:file execute_no_trans;
```

**W^X = Write XOR Execute**：可写的东西不能可执行。切断的攻击链是"任意文件写入 → 写入二进制 → `execve` → 任意代码执行"。应用私有目录恰好是"自己可写 + 内容不可信 + 在 APK 签名校验之外 + 可持久"的最危险组合。

**关键非对称性**（同一份 sepolicy）：禁的是 `execute_no_trans`（当程序跑），**没有禁 `execute`**（mmap/dlopen 仍可）——`untrusted_app_all.te` 至今保留 `allow untrusted_app_all app_data_file:file { r_file_perms execute };`。

**`targetSdk ≤ 28` 是出路**：`seapp_contexts` 按 targetSdk 分域，26–28 落进 `untrusted_app_27`，而 neverallow **显式豁免**它（Termux 同款机制）。**但代价与风险**：整个应用停留在 API 28 行为契约；且注释里 "**For compatibility**" 是**过渡措辞**，同类兼容口子 Google 历来会清理——**这条路有被未来 Android 关闭的风险**。（`b/112357170` 无法读取内容，勿引用。）

### 3.2 bun 在 Android：能编译，但不稳，且无法当库

**本项目实测**（bun 1.4.2）：

```bash
$ bun build --compile --target=bun-android-arm64
error: invalid target, android only exists with linux (use bun-linux-arm64-android)

$ bun build --compile --target=bun-linux-arm64-android   # ✅ exit 0
```

- 拼写**必须带 `linux`**。
- 产物经验证为 **PIE + bionic**（`PT_INTERP=/system/bin/linker64`，`NEEDED=libc/libm/libdl`），**非 glibc**；**16KB 页对齐满足**（自写 ELF 解析器复算，`PT_LOAD p_align` 最小 `0x4000`）；体积 arm64 **84.4MB** / x64 **86.8MB**。
- **无法当库加载**：bun v1.4.2 的**全部 34 个发布产物都是可执行文件**，无任何 `libbun`/`.so`/`.a`/头文件；仓库 issue 搜 `embed library C API`/`libbun` **零结果**。bun **不提供嵌入形态**（不同于 V8/QuickJS/libnode）。
- **上游不稳**（**调研来源，本项目未复现**）：`oven-sh/bun#30766` Android 产物启动即被 seccomp **SIGSYS** 杀（`close_range`）；`#39775`/`#39060` 未合。这是**唯一与 targetSdk 无关的硬墙**。

**结论**：手机本地跑宿主 = 自建工具链 + 每 ABI ~85MB + 押在 experimental 目标 + 期望 `targetSdk ≤ 28` 的长期风险。**而客户端方案这些问题一个都不存在。**

### 3.3 Tauri 自身不支持移动端 sidecar

`tauri-plugin-shell` 的 Android 支持等级是 **`level = "partial"`**，note 原文 `Only allows to open URLs via open` —— Android 上**没有 `execute`/`spawn`**（Kotlin 实现只有一个 `open()`）。上游 issue **tauri-apps/tauri#9774** 仍 OPEN。

---

## 4. 本仓库的两条"载重"事实（删了就坏）

### 4.1 `tauri.android.conf.json` 的 `externalBin: []` 是防线

**看起来可以删（"Android 又不打包 sidecar"），删了直接坏构建。**

`tauri-build` 对 `externalBin` 的复制**没有 desktop/mobile 门控**。**本项目亲自核对 tauri-build 2.6.3**：`copy_binaries` 在 `try_build()` 中**无条件调用**（`lib.rs:545`），该 crate **不含任何 `cfg(desktop)`**；`tauri-utils::external_binaries` 只拼 `-{target_triple}`。于是 Android 构建会去找无人生产的 `binaries/host-aarch64-linux-android` → 上游报光秃秃的 `os error 2`（#9774）。

**已加回归测试**（`src-tauri/src/lib.rs::packaging_tests`），按**合并语义**断言（Tauri 把平台配置深合并到基础配置：**省略键 = 继承桌面值**，不是"未设置"）。已实测三种破坏方式都能触发失败：①删整个 `bundle` 块；②把 `externalBin` 显式写成 `["binaries/host"]`；③删 `build` 块使其继承 `build:host`。

> 教训：该守卫**第一版是假防线**（只读覆盖文件本身，删除覆盖后照样通过）。守卫必须按**有效配置**判定。

### 4.2 文件选择在移动端是 URI，不是路径（已修）

`FilePath` 是 `Url(Url) | Path(PathBuf)`，而 `into_path()` **只转换 `file://`**；Android SAF 返回 **`content://`** → 必然失败。旧代码把失败压成 `json!("")` → **Android 上选完文件静默返回空串**，与"用户取消"无法区分。已改为：能转就用路径，**不能转就原样返回 URI**，语义交给调用方（可能需要"读取"而非"打开路径"）。

---

## 5. 已完成的移动端基础（本轮）

| 项 | 状态 |
|---|---|
| 桌面专属能力门控（托盘/快捷键/单实例/窗口操作/选文件夹/托盘快照），Android 编译 27 error → **0** | ✅ 已提交 |
| CI `mobile (android)` job 转绿（含 APK 产出），**摘掉 `continue-on-error`** | ✅ 已提交 |
| 文件选择 URI 语义修正 + 3 条回归测试 | ✅ 已提交 |
| `externalBin` 打包守卫 + 3 种破坏方式实证 | ✅ 已提交 |

（`tauri-cli 2.11.4` 模板实测：`targetSdk=36` / `compileSdk=36` / AGP `8.11.0`、**未设** `useLegacyPackaging`。）

---

## 6. 未验证清单（不要当事实引用）

**本项目亲自验证**：§3.1 sepolicy 原文（含豁免与 `execute` 非对称性）；§3.2 的编译/ELF 头/16KB 对齐/体积/bun 发布产物无库形态；`tauri-build 2.6.3` 无 `cfg(desktop)`；`tauri-cli 2.11.4` 模板配置；`wry 0.55.1` 的 `javascriptcore-rs` 只挂 linux/bsd（Android 走 `jni`/`ndk`）；本仓库两份 tauri 配置；三通道代码位置（`src/host.ts`、`host/src/ws.ts`、`host/src/stdio.ts`、`host.rs`）。

**调研来源、未独立验证**：
1. bun 上游缺陷编号与状态（#30766 / #39775 / #39060 / #38246）及"Android 不在文档支持目标表内"。
2. `mozjs` / `deno_core` / QuickJS / `boa` / `nodejs-mobile` / Hermes 的 Android 可用性对比（**已不再需要**，因不需本地引擎，仅作背景）。
3. 内嵌引擎方案（WebView / hidden window）——Tauri 维护者在 discussion **#8174** 推荐过"隐藏窗口做 extension host"；**本方案不需要它**。
4. Termux 机制细节（`targetSdk=28` 落旧域、`termux-exec` 的 linker-exec）。
5. **`wss://` 在移动网络/后台的实际表现、心跳与重连策略** —— 未验证。
6. **配对协议的具体设计**（用户确认流程、凭据存储、吊销）—— 本文件只列需求，未设计。
7. **Play 政策**：我们不过 Play，故未深究；若将来上 Play，§3 的"政策墙不适用"结论须重新评估。

---

## 7. 决策记录与待决问题

| 日期 | 决定 |
|---|---|
| 2026-09-11 | **移动端 = 第三端（脸 + 手），脑留在桌面/服务器**；不走"手机本地宿主"路线 |
| 2026-09-11 | 初版"如何把宿主移植到 Android"的框架**作废**，本文档重写 |
| 2026-09-11 | 分发不走 Play（APK/IPA 仅 GitHub） |
| 2026-09-11 | 不要求桌面式 24h 常驻，按需唤醒 |
| 2026-09-11 | `tauri-winrt-notification` 显式依赖保持 `0.8`（有意选择，见 `AGENTS.md`） |

**待决（将来立项时先答）**：
1. **脑的部署形态**：只支持"连自己的桌面机"，还是同时做"托管服务器"？后者 = **L2/L3 项目**，两者应合并设计。
2. **脑⇄手替代通道**选哪条（§2.3）？推荐 (a) 经脸转达，但需确认"脸必须活着"是否可接受——不可接受的部分由**推送唤醒**补。
3. **配对与鉴权**的具体设计（§2.1）——这是 §4.8 说的"外部访问鉴权 + 端口暴露安全模型"，**独立立项**。
