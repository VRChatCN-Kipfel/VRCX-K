# 移动端可行性调研（Android）

> 状态：**调研完成，未立项**。本文只回答"能不能、代价多大"，不含实现计划。
> 调研日期：2026-09-11。上游结论均有出处；**未亲自验证的一律标注**。

## 0. 结论（TL;DR）

1. **桌面那套"壳 spawn 一个常驻 host 进程"不能照搬到 Android** —— 但原因**不是**"技术上不可能"，而是三条成本不同的墙叠加。
2. **三道墙里只有一道是硬的**：

   | 墙 | 硬度 | 为什么 |
   |---|---|---|
   | Play 政策禁运行时下载可执行码 | **不适用** | 我们 APK/IPA 只在 GitHub 分发，不过 Play |
   | 常驻前台服务受限（Android 15+ `dataSync` 24h/6h） | **软化** | 产品上不要求 24h 常驻，按需唤醒即可 |
   | 高 targetSdk 禁 `execve` | **有出路** | `targetSdk ≤ 28` 落进被显式豁免的 SELinux 域（Termux 同款机制） |
   | bun 的 Android 产物不稳定 | **硬** | 与 targetSdk 无关，是 bun 自身的 seccomp 缺陷，修未合 |

3. **推荐形态**：移动端要么做**瘦客户端**（宿主不参与），要么**进程内嵌 JS 引擎**；**不要**直接把桌面 sidecar 移植过去（除非接受"研究性质"的代价）。
4. **本文档最重要的两条项目内事实**见 §5 —— 它们都是"看起来多余、删了就坏"的配置。

---

## 1. 为什么高 targetSdk 会禁止 execve：W^X

这是整件事的技术根因，值得单独讲清楚。

### 1.1 W^X 是什么

**W^X = Write XOR Execute**：一份内存或一个文件，**要么可写、要么可执行，不能兼得**。

它切断的是一条攻击链：

```
任意文件写入 → 把二进制写进可写目录 → execve → 以本应用身份执行任意代码
```

禁止 `execve` 之后，攻击者即使拿到"任意文件写入"，也只能写数据，**无法把数据变成代码执行**。这是典型的"切断提权路径"：把「数据面被污染」与「任意代码执行」隔离开。

### 1.2 为什么偏偏是"应用私有目录"

`app_data_file`（`/data/data/<pkg>/…`、`filesDir`、`getExternalFilesDir`）恰好是最危险的组合：

| 属性 | 后果 |
|---|---|
| 应用自己**可写** | 任何影响应用写入的数据流都成潜在注入点 |
| 内容**来源不可信** | 下载的文件、SAF 选中的文件、共享存储、第三方 provider |
| **在 APK 校验模型之外** | APK 在**安装时**验证签名；从数据目录执行 = **绕开"代码即签名包"** |
| **持久** | 写入的文件下次启动仍在 → 恶意代码驻留 |

APK 里的代码是**签名并（若走商店）被审过**的；数据目录里的文件**什么都不是**。允许 `execve` 等于允许运行一段没人审过的代码。

### 1.3 官方措辞与源码原文

- 机制（**本项目亲自核对**）：`system/sepolicy/private/app_neverallows.te`，在 LineageOS `lineage-20.0 / 21.0 / 22.1 / 22.2 / 23.0`（= Android 13/14/15/15.2/**16**）中一致：

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

- 官方文档措辞（调研来源，与上述源码注释一致）：Android 10 behavior changes "Removed execute permission for app home directory" —— *"Untrusted apps that target Android 10 cannot invoke `execve()` directly on files within the app's home directory."*

### 1.4 关键非对称性：禁 `execve`，不禁 `dlopen`

同一份 sepolicy 里，**禁的是 `execute_no_trans`（直接当程序跑），`execute`（mmap 映射可执行）没有被禁**。`untrusted_app_all.te` 至今仍有：

```
allow untrusted_app_all app_data_file:file { r_file_perms execute };
```

配套约束是"不能既写又执行"（无法通过可写 fd 映射 `PROT_EXEC`）。

**这条非对称性决定了替代方案的空间**：
- ❌ `execve` 一个可执行文件 → 被禁
- ✅ `dlopen` 一个共享库 / 链接进进程内嵌引擎 → **仍然允许**

`jniLibs` 变通之所以成立，也是因为包管理器把 `lib*.so` 解到 `nativeLibraryDir`，而那里的 label 是 **`apk_data_file`（明确可执行）**，不在上面那条 `neverallow` 里。

### 1.5 `targetSdk ≤ 28` 为什么能豁免（以及代价）

SELinux 域是按 **targetSdkVersion** 切的。`private/seapp_contexts`（Android 16）：

```
user=_app minTargetSdkVersion=28 domain=untrusted_app_27 type=app_data_file levelFrom=all
user=_app domain=untrusted_app_25 type=app_data_file levelFrom=user
```

而 neverallow **显式减掉** `untrusted_app_25` / `untrusted_app_27` / `runas_app`。所以 targetSdk 26–28 的应用落进 `untrusted_app_27` → **数据目录 execve 被允许**。

注释里那句 **"For compatibility"** 是关键：Android 10 引入限制时已有大量依赖此行为的应用（Termux 最大），Google 用"按 targetSdk 分域"做过渡，让旧目标版本留在旧域里。

**代价与风险（必须记住）**：
- 整个应用停留在 API 28 的行为契约：新 targetSdk 才启用的安全加固与行为变更一律不生效。
- ⚠️ **"For compatibility" 是过渡措辞，不是永久承诺**。同一文件里 `dex2oat` 等条目也带 `-untrusted_app_25 -untrusted_app_27` 豁免，这类兼容口子 Google 历来会逐步清理。**这条路存在被未来 Android 关闭的风险** —— 问题不是"今天能不能"，而是"三年后还行不行"。
- 因此这是一个**明确的取舍**（选择不参与 Android 10+ 的应用安全模型），不是"绕过限制的聪明做法"。做这个选择时必须同时接受它可能失效。
- `b/112357170` 是 Google 内部 bug 号，**无法读取内容**，不要当可引用依据。

---

## 2. 我们当前架构在 Android 上的映射

`shell.*` 是契约、不是实现，所以移动端是"**同一契约、另一套实现**"。逐条对照：

| 我们的能力 | Android 对应物 | 现状 |
|---|---|---|
| 托盘 tray | 无托盘 → 常驻通知 / QS Tile / 应用内状态 | 已 `cfg(desktop)` 门控 ✅ |
| 全局快捷键 | 无全局热键 → App Shortcuts / QS Tile / MediaSession | 已门控 ✅ |
| 单实例锁 | 概念不同（单进程模型） | 已门控 ✅ |
| `window.minimize/maximize/unminimize` | 无窗口概念 | 已门控 ✅ |
| `shell.openUrl` | `Intent.ACTION_VIEW` | 可映射 ✅ |
| `shell.openPath` | **裸路径不可用** → 需 FileProvider + `ACTION_VIEW` | 需重写 ⚠️ |
| `shell.reveal` | 无"在文件夹中显示" | 需移除 ⚠️ |
| `shell.dialog.pickFile` | SAF，返回 **`content://` URI** | **语义需重定义** ⚠️ 见 §5.2 |
| `shell.notify` | 支持，但 Android 13+ 需 `POST_NOTIFICATIONS` 运行时权限，且多出 **channel** | 需补 ⚠️ |
| `shell.path.*` | app 私有目录可用，但 `home_dir` 等桌面语义不成立 | 需重定义 ⚠️ |
| `shell.app.exit` | 不建议杀进程 | 需重定义 ⚠️ |
| 后台常驻 | 前台服务（FGS），Android 14+ 必须声明 `foregroundServiceType` + 挂常驻通知；**Android 15+ `dataSync` 24h 内累计 6h 上限**，`BOOT_COMPLETED` 不许启动它 | **新增面**，非移植 ⚠️ |
| 开机自启 | `RECEIVE_BOOT_COMPLETED` + 广播接收器；但厂商（小米/华为/OPPO）自启动白名单是**私有设置，程序绕不过** | 只适合轻活 ⚠️ |

**要点：移动端不是"把桌面代码搬过去"，而是"同一契约、另一套实现"** —— 上表中"新增面"（FGS/权限/channel/Intent）在桌面根本不存在。

---

## 3. bun 在 Android 的真实状态（已实测）

### 3.1 交叉编译：可以（本项目亲自验证）

```bash
$ bun build --compile --target=bun-android-arm64
error: invalid target, android only exists with linux (use bun-linux-arm64-android)

$ bun build --compile --target=bun-linux-arm64-android
[7.894s] compile  ... bun-linux-aarch64-android-v1.4.2        # exit 0
```

- **拼写必须带 `linux`**：`bun-android-*` 会被拒绝，正确形式是 `bun-linux-{arm64,x64}-android`。
- 产物经 ELF 头解析确认：aarch64 `e_machine 0xb7`、x64 `0x3e`，均为 **PIE + bionic**（`PT_INTERP=/system/bin/linker64`，`DT_NEEDED=libc/libm/libdl`），**不是 glibc** → 不存在"glibc on Termux"问题。
- **16KB 页对齐**（Android 15+ 对 64 位设备的要求）：本地用自写 ELF program-header 解析器复算，两个产物 `PT_LOAD p_align` 最小值均为 **`0x4000` = 16384** → **满足**。
- 体积：arm64 **84.4 MB** / x64 **86.8 MB**（每 ABI）。

> ⚠️ **但"能编译"≠"能跑"**。产物是否为正确架构、是否对齐，都已验证；**能否在设备上真正执行，未验证**（见 §6）。

### 3.2 上游状态：官方发布但标注 experimental，且当前不稳

- bun 自 **v1.3.14** 起随每版发布 `bun-linux-{aarch64,x64}-android` 产物；官方博客 "Experimental Android support"：*"Bun ships experimental Android builds for aarch64 and x64 with every release."*（**调研来源**）
- **不在文档的支持目标表里**：`bun.sh/docs/bundler/executables` 只列 8 个目标，无 Android 行（**调研来源**）——属于"支持但未文档化"。
- **当前有开着的启动即崩缺陷**（**调研来源，本项目未复现**）：`oven-sh/bun#30766` Android 产物被 seccomp **SIGSYS** 杀（`__NR_close_range`，Android ≤12 的 zygote allowlist 不含它）；`#39775`/`#39060` 未合；另有 `#38246`（已于 2026-08 合入）修的正是"`bun build --compile` 产物在 Android 上启动即段错误"。
- **结论：这条是唯一与 targetSdk 无关的硬墙** —— 即便解决了 execve，仍要等 bun 自己的 Android 稳定性成熟。

---

## 4. 可行路线对比

| 路线 | 保住 `kkrpc` 契约 | 保住 **Cordis/JS 插件生态** | 代价 | 风险 |
|---|---|---|---|---|
| **A. bun sidecar（jniLibs 变通）** | ✅ | ✅ | 自建工具链、`useLegacyPackaging=true`、每 ABI ~85–90MB、需 `targetSdk ≤ 28` 或 `lib*.so` 路线 | **高**（三道墙） |
| **B. 进程内嵌 JS 引擎** | ✅ | ✅ | 高；`mozjs` 有官方 Android 预编译（含 armv7），`deno_core` 语义最好但要源码构建 V8 | 中（**运行时未验证**） |
| **C. 移动端换实现（Rust/Kotlin 同契约）** | ✅ | ❌ | **实现最贵** | **最低**（无平台未知数） |
| **D. 瘦客户端**（宿不参与，只做登录/好友/通知） | 部分 | ❌ | 最低 | 最低 |

### ⚠️ 一个容易误读的点

调研里有说法把 B/C 都描述为"保 kkrpc 契约" —— **这在传输层对，在插件层是误导**：

> 我们的插件是 **Cordis 插件，也就是 JS**（`host/package.json` 依赖 `cordis` / `@cordisjs/plugin-loader` / `@cordisjs/plugin-include`）。路线 C 保住的只是**壳⇄脑这条线**，丢掉的是**插件生态** —— 现有 JS 插件在移动端插件 API 面前一行都跑不了。**"同契约"≠"同生态"。**

所以真正的决策问题是：**移动端要不要保留 Cordis/JS 插件生态？**
- 要 → 必须内嵌 JS 引擎（路线 B），且 `ws` 服务端**不能放 WebView**（浏览器 `WebSocket` 是 client-only），必须留在 Rust。
- 不要 → 路线 C/D，成本与风险都最低。

---

## 5. 本仓库的两条"载重"事实（删了就坏）

### 5.1 `tauri.android.conf.json` 的 `externalBin: []` 是防线，不是冗余

**它看起来可以删（"Android 又不打包 sidecar，覆盖它干嘛"），删了会直接坏构建。**

原因：sidecar 产物按 Rust target triple 命名（`binaries/host-<triple>[.exe]`），而 `tauri-build` 对 `externalBin` 的复制 **没有任何 desktop/mobile 门控**。**本项目亲自核对 tauri-build 2.6.3**：`copy_binaries` 在 `try_build()` 中**无条件调用**（`src/lib.rs:545`），且该 crate **不含任何 `cfg(desktop)`**；`tauri-utils::external_binaries` 只是拼 `-{target_triple}`，不按平台过滤。

于是 Android 构建会去找 `binaries/host-aarch64-linux-android` —— 没有任何东西生产它 → 上游报一个**光秃秃的 `os error 2`**（tauri-apps/tauri **#9774**，仍 OPEN）。

**已加回归测试**（`src-tauri/src/lib.rs` 的 `packaging_tests`），按**合并语义**断言：
- Tauri 把平台配置**深合并**到基础配置上，**覆盖文件省略 `bundle` 键 = 继承桌面的 `externalBin`**，不等于禁用 → 所以断言的是**合并后的有效值**为空，而不是"覆盖文件里写没写"。
- 已用三种破坏方式实测该守卫**确实会失败**：①删除整个 `bundle` 块；②把 `externalBin` 显式写成 `["binaries/host"]`；③删除 `build` 块使其继承 `build:host`。
- （第一条守卫最初写成"只读覆盖文件"，**删除覆盖后照样通过** —— 那是个假防线，已修正。教训：守卫必须按**有效配置**判定。）

### 5.2 文件选择在移动端是 URI，不是路径（已修）

`tauri-plugin-dialog` 的 `FilePath` 是 `Url(Url) | Path(PathBuf)`，而 `into_path()` **只转换 `file://`**：

```rust
Self::Url(url) => url.to_file_path().map_err(|_| Error::InvalidPathUrl),
```

Android SAF 返回的是 **`content://`** → 这个转换**必然失败**。原实现把失败压成 `json!("")`：

```rust
match path.into_path() { Ok(p) => ..., Err(_) => json!("") }   // ← 旧行为
```

**后果**：Android 上选完文件**静默返回空串**，与"用户取消"（`null`）在调用方看来毫无区别 —— 无法区分"用户没选"与"我们表达不了用户选的"。属于**掩盖**而非报错。

**已修（根因）**：`dialog_opts::file_path_to_json` —— 能转换就用路径（`file://` 仍归一化为真实路径），**不能转换就原样返回 URI**，由调用方决定 URI 的含义（可能需要"读取"而不是"打开路径"）。`shell_sys.rs` 与 `smoke.rs` 统一走这一份实现（原先两处各写一份，其中一处正确、一处有 bug —— 正是本模块存在的理由："a second copy would drift silently"）。附 3 条回归测试。

> 附带发现（测试抓到的）：Windows 上 `to_file_path()` **会合法地拒绝**没有盘符的 `file:///tmp/...`。所以"是否转换成功"本身是平台相关的，测试只能钉住**不变量**（永不塌成空串），钉不住具体拼写。

---

## 6. 未验证清单（不要当事实引用）

**本项目亲自验证**：§3.1 全部（编译、ELF 头、16KB 对齐、体积）；`tauri-build 2.6.3` 无 `cfg(desktop)`；`tauri-cli 2.11.4` 模板 `targetSdk=36` / `compileSdk=36` / AGP `8.11.0`、**未设** `useLegacyPackaging`；§1.3/§1.4/§1.5 的 sepolicy 原文；`wry 0.55.1` 的 `javascriptcore-rs` 只挂 linux/bsd、Android 走 `jni`/`ndk`；本仓库两份 tauri 配置的内容。

**仅为调研来源、本项目未独立验证**：
1. **Android 上没有"免费的 JavaScriptCore"** —— WebView 是 Chromium/V8。`wry` 清单已本地证实 JSC 非 Android 依赖，但"WebView=V8"是**推论**（官方页面只写 "based on the Chromium project"，未出现 "V8" 字样）。
2. Tauri 官方 issue **#9774** 与其维护者评论、`tauri-plugin-shell` Android `level="partial"`（"Only allows to open URLs via `open`"）。
3. **bun 上游缺陷编号与状态**（#30766 / #39775 / #39060 / #38246）及"Android 目标不在文档表里"。
4. **`mozjs` / `deno_core` / `rquickjs` / `boa` / `nodejs-mobile` / Hermes 的 Android 可用性对比** —— 尤其 `mozjs` 官方 Android 预编译**存在且可下载**，但**无人验证过运行时**。这是替代路线上最有价值的未验证项。
5. Termux 的机制细节（`targetSdk=28` 落旧域、`termux-exec` 的 linker-exec、Play 版 `useLegacyPackaging`）、UserLAnd / TaskerAppFactory 等先例。
6. `useLegacyPackaging` / `extractNativeLibs` 的官方 DSL 默认值（AGP 文档未取到原文）。
7. **Play 政策的适用性**：因我们**不过 Play**，本轮未再深究；若将来上 Play，§0 的"政策墙不适用"结论**必须重新评估**。
8. **Play 对"间接访问 Android API"的官方定义**（内嵌 JS 引擎 vs WebView）—— 无权威公开定义。

---

## 7. 决策记录

| 日期 | 决定 | 理由 |
|---|---|---|
| 2026-09-11 | **移动端不照搬桌面 sidecar 架构**；本文档记录结论，**不立项实现** | 三道墙成本叠加，且"常驻"前提在 Android 不成立 |
| 2026-09-11 | 分发**不走 Play**（APK/IPA 仅 GitHub） | 用户决策；直接移除 Play 政策墙与 target API 强制 |
| 2026-09-11 | 不要求桌面式 24h 常驻，**按需唤醒** | 用户决策；大幅软化 FGS 时限墙 |
| 2026-09-11 | `externalBin: []` 加回归测试；文件选择 URI 语义修正 | §5 两条载重事实 |
| 2026-09-11 | `tauri-winrt-notification` 显式依赖**保持 `0.8`** | 开发期尽量往高版本靠；已知与传递的 0.7.3 并存、多拉一棵 `windows 0.62` 树，属**有意选择**（见 `AGENTS.md` 通知分层段） |

### 将来立项时要先回答的问题

1. **移动端要不要保留 Cordis/JS 插件生态？**（决定选 §4 的 B 还是 C/D）
2. 如果走 B：选 `mozjs`（有官方 Android 预编译，但无高层 ESM API，需手写模块加载器）还是 `deno_core`（语义最好，但 V8 需源码构建 + 补丁）？
3. 如果走 A：能否接受 `targetSdk ≤ 28` 的**长期风险**（§1.5）？还是接受 `lib*.so` + `useLegacyPackaging` 的自建工具链？
4. **推送唤醒的服务端**（L2/L3）与移动端形态是同一个问题，应合并设计。
