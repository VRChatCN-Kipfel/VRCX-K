# D1 探针结论：kkrpc Rust ↔ npm 的协议互通（M1-4 设计输入）

> 状态：**已定案并已实现**（M1-4 双向桥按 E′ 形态落地，见 `docs/cordis-runtime-findings.md` 与 `src-tauri/src/kkrpc_peer.rs`）。
> 本文是 M1-4 的**设计依据**，由 `.temp/D1-findings.md` **转正**而来（依据 `AGENTS.md` 的"被引用即须转正"规则：该结论被 `AGENTS.md` 引用，而 `.temp/` 可随时整目录删除）。
> ⚠ **原始探针目录 `.temp/d1probe/` 已不存在**——它是丢弃型的探针 crate。本文保留结论与算法；若需重新验证，按"复现方法"一节重建。
> 日期：2026-09（M1-4 设计期）

---

## 0. 一句话结论

**crates.io 的 `kkrpc` Rust crate 0.6.1 与 npm `kkrpc` 2.1.0 协议不互通**（JSON-mode vs compact）。
⇒ **不自研完整 Client**，改走 **方案 E′「宿主全双工 + Rust 轻量喊话」**，已实证并定案。

---

## 1. 问题

crates.io 的 `kkrpc` crate 能否与 npm/TS 的 `kkrpc` 2.1.0 在**一条 stdio 链路**上做真正的双向 RPC——
即 Rust 既能**调用**宿主，又能**响应**宿主发起的调用？

## 2. 方法

独立探针 crate（当时的 `.temp/d1probe`）：

- 启动 `.temp/d1-host.ts`（bun，kkrpc/stdio 的 `nodeStdioTransport`，暴露 math/echo/notify）
- 模式：`raw` / `thread-read` / `client-only` / `client-debug` / `duplex`

## 3. 实测结论

| # | 结论 |
|---|---|
| 1 | **手写 compact 帧可用**：写 `{"t":"q","id":"raw-1","op":"call","p":["math","add"],"a":[2,3]}\n` → 宿主回 `{"t":"r","id":"raw-1","v":5}`。⇒ **npm kkrpc 端点说的是 compact 协议** |
| 2 | **thread-read（自建读线程 + 手写帧）10/10 通过** |
| 3 | **crates.io `kkrpc` 0.6.1 的 `Client` 10/10 失败（全 HANG）**：它的线上帧是 `{"args":[0,1],"id":"…","method":"math.add","type":"request","version":"json"}` —— 即**旧的 JSON-mode 协议**，**不是 compact** |
| 4 | **根因是协议版本错配**，不是"双向能力"问题 |
| 5 | GitHub `main` 的 `interop/rust/src/lib.rs` **已实现 compact**（`t:"q"` / `op` / `p` / `a`，与 npm 2.1.0 及官方 interop skill 一致），但**该修复未发布到 crates.io**（只有 0.6.0 / 0.6.1，都是 JSON-mode 时代） |

## 4. 候选方案与取舍

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A** | Cargo 指向 `kkrpc = { git = "…" }`（main） | 最快拿到 compact + 对称 Client/Server；但**钉在移动的 main**，且在本地复制一份 interop/rust |
| **B** | 自研 ~150 行 compact 传输 + 单读线程分发（`q`→服务端 handler，`r`/`cb`→客户端 pending） | 协议仍是 kkrpc compact；**去掉对未发布 crate 的依赖**；面小、算法有官方 skill 文档 |
| **C** | 等 crates.io 发布 compact 版 | **阻塞 M1-4** |

## 5. ✅ 定案：方案 E′（在 A-vs-B 讨论后追加，**实测通过**）

**"轻量喊话"桥**——Rust **不实现**完整 kkrpc Client：

- **Rust 读循环**：分发 `q` → 本地 handler（响应宿主→Rust），`cb` → 本地回调表，**忽略 `r`**
- **Rust → 宿主的即时信号**：**裸写一个 compact 请求帧**（`{t:"q",id,op:"call",p,a}`）——宿主的**事件驱动读循环立即执行**，**零轮询、无需第二条通道**。已验证：`shell.restart` 帧 → 宿主确实执行了
- **Rust 需要一个返回值**时：传一个 kkrpc 回调标记参数（`{"__kkrpc_next_arg__":"callback","id":…}`）；宿主做完工作把结果以 `t:"cb"` 推回；Rust 分发到本地回调。已验证：`query.version` 往返 **~613 µs**
- **回调值回来时包在 value envelope 里**（`{"__kkrpc_next_arg__":"value","v":…}`）——按官方 interop skill **必须 unwrap**

⇒ **E′ 比"完整 Client+Server 适配器"更简单**，且 Rust 保持"主动发令者"角色（发命令、经回调异步拿结果）。

## 6. 附带发现（真实架构约束）

**kkrpc/stdio 把 stdout 当协议通道** ⇒ **stdio 桥一旦建立，宿主代码绝不能往 stdout `console.log`**——**所有宿主日志必须走 stderr**。
（`host/src/log.ts` 与 `host/src/index.ts` 即此约定；`host/tests/compile-smoke.test.ts` 还断言 compiled host 的 stdout 为空串。）

## 7. 复现方法（原始探针已删除）

`.temp/d1probe/` 是丢弃型 crate，**不在仓库内**。要重新验证：

1. 建一个 detached workspace 的 Rust 探针 crate，依赖 `kkrpc`（**先确认 crates.io 是否已发布 compact 版**——若已发布，本结论的"必须自研"前提失效，应改回方案 A）
2. 写一个 bun 宿主脚本，用 kkrpc/stdio 的 `nodeStdioTransport` 暴露 `math.add` / `echo` / `notify`
3. 验证三点：① 手写 compact 帧能通；② 0.6.1 的 `Client` 是否 HANG；③ `t:"cb"` 回调往返
4. 当前生产实现见 `src-tauri/src/kkrpc_peer.rs`（约 100 行 compact 端点，取自官方 skill 算法）

## 8. 何时可以换掉

**上游发布 compact 版 kkrpc 到 crates.io 后**，可把自研端点换回官方 crate（`AGENTS.md` 与架构 §4.5 的"上游追踪"应一并复核）。

---

## 相关

- 生产实现：`src-tauri/src/kkrpc_peer.rs`
- 协议坑：`AGENTS.md`「已知坑」；`docs/cordis-runtime-findings.md`
- 架构：`docs/architecture-proposal.md` §1.3（kkrpc 三通道）/ §4.5（上游追踪）/ 附录 A（kkrpc 采用记录）
