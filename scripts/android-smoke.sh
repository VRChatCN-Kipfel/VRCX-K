#!/usr/bin/env bash
# Android 模拟器冒烟：安装 APK → 启动 → 抓 logcat → 断言。
#
# ⚠ 为什么必须是【独立脚本文件】而不是 workflow 里的 `script:` 内联块：
#   reactivecircus/android-emulator-runner 会把 `script` 输入【逐行拆开】，
#   每行交给一个独立的 `/usr/bin/sh -c` 进程执行（实测日志形态：
#     [command]/usr/bin/sh -c set -u
#     [command]/usr/bin/sh -c APK="..."
#     [command]/usr/bin/sh -c if ! adb install -r "$APK"; then
#     /usr/bin/sh: 1: Syntax error: end of file unexpected (expecting "fi")
#   ）。因此内联多行脚本必然散架：变量不跨行保留、if/fi 与 for/done 这类
#   跨行结构直接语法错误。（本地 `bash -n` 检查【发现不了】这一点——它检查的
#   是"整段是一个脚本"，而 CI 上根本不是那样执行的。）
#   把它落成文件、由 script 里单行调用，即可让整段在同一个 shell 进程内运行。
#
# 用法（由 workflow 调用）：
#   bash scripts/android-smoke.sh <apk-path> <out-dir>
#
# 退出码：0 = 安装且启动成功、无崩溃标记；非 0 = 冒烟失败（细节已打印）。
set -uo pipefail

APK="${1:?usage: android-smoke.sh <apk-path> <out-dir>}"
OUT="${2:?usage: android-smoke.sh <apk-path> <out-dir>}"
PKG="com.vrcxk.app"

mkdir -p "$OUT"
LOG="$OUT/logcat.txt"
LOG_APP="$OUT/logcat-app.txt"
STATE="$OUT/device-state.txt"

echo "APK = $APK"
if [ ! -f "$APK" ]; then
  echo "::error::APK not found at '$APK'"
  exit 1
fi

adb wait-for-device

# 二次保险：action 已等过一轮 boot，这里再确认一次。
# 单引号是有意的 —— $(...) 要交给【设备端】的 sh 展开；写成双引号会被本地
# shell 先展开成空串，等待逻辑就废了。
# shellcheck disable=SC2016
adb shell 'while [ -z "$(getprop sys.boot_completed)" ]; do sleep 1; done'

# 清空既有缓冲，确保捕获到的只有本次安装/启动产生的内容。
adb logcat -c

echo "── adb install ──"
if ! adb install -r "$APK"; then
  echo "::error::adb install failed"
  adb logcat -d > "$LOG" 2>&1 || true
  exit 1
fi

echo "── launch via monkey（不硬编码 Activity 名）──"
# 不用 `am start -n <pkg>/.MainActivity`：那个 Activity 全名从未被实测验过
# （gen/android 是 gitignore 的生成物，仓库里查不到）。monkey 由系统解析
# LAUNCHER intent，避免把未验证的名字变成假失败源。
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1

# 轮询进程出现，最多 90s（代替固定 sleep，WebView 冷启可能远超 8s）。
LAUNCHED=0
APP_PID=""
i=0
while [ "$i" -lt 45 ]; do
  # --first：某些 ROM 的 pidof 会返回多个 pid（多进程应用），取首个即可。
  APP_PID="$(adb shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')"
  if [ -n "$APP_PID" ]; then
    echo "process alive after $((i * 2))s (pid=$APP_PID)"
    LAUNCHED=1
    break
  fi
  i=$((i + 1))
  sleep 2
done

# 多跑一会儿：WebView 初始化与业务首帧都在这段时间内发生，
# 崩溃若发生也多半在此窗口内写入 logcat。
sleep 15

echo "── capture logcat ──"
# 全量缓冲照旧留存（人工排障用，也能看到系统侧信息）。
adb logcat -d > "$LOG" 2>&1 || true
wc -l "$LOG" || true

# 另存一份【仅本应用进程】的日志，便于人工快速阅读（体积小得多）。
# ⚠ 它【不是】崩溃判据的来源 —— 理由见下方判据处。
if [ -n "$APP_PID" ]; then
  adb logcat -d --pid="$APP_PID" > "$LOG_APP" 2>&1 || true
  echo "app-only logcat: $APP_PID ($(wc -l < "$LOG_APP" 2>/dev/null || echo 0) lines) -> $LOG_APP"
fi

# 存一份设备/包状态，便于事后核对实际 Activity 名与前台状态。
{
  echo "### pidof"
  adb shell pidof "$PKG" || true
  echo "### resolved launcher activity"
  adb shell cmd package resolve-activity --brief "$PKG" || true
  echo "### resumed activity"
  adb shell dumpsys activity activities | grep -E 'mResumedActivity|ResumedActivity' || true
} > "$STATE" 2>&1 || true
cat "$STATE" || true

FAIL=0

if [ "$LAUNCHED" -ne 1 ]; then
  echo "::error::$PKG did not start within 90s (see $LOG)"
  FAIL=1
fi

# ── 崩溃判据：扫【全量】缓冲，但只认【带本应用归属标识】的行 ──────────────
#
# 为什么不按 app pid 过滤（一个看似显然、实则会漏报的做法）：
#   Java 崩溃的 `FATAL EXCEPTION` 由应用进程自己写，按 pid 过滤没问题；
#   但**原生崩溃**（SIGSEGV/SIGABRT 等）的 `Fatal signal` 与 tombstone 由
#   `debuggerd` / `crash_dump` **另一个进程**写出，其日志条目的 pid 不是应用的
#   pid。若按 app pid 过滤，**最严重的那类崩溃会被静默漏掉** —— 漏报远比误报
#   危险，因为本步存在的唯一目的就是抓崩溃。
#
# 所以改为：仍然扫全量，但把判据从"裸信号名"换成**带包名归属的形式**，
#   既不会把别的进程的崩溃误记到我们头上（误报），也不会漏掉原生崩溃（漏报）：
#     ① `Process: com.vrcxk.app, PID:` —— AndroidRuntime 在每条 Java 崩溃栈
#        的头部固定打印这一行，是 Java 崩溃的权威归属。
#     ② `>>> com.vrcxk.app <<<`      —— tombstone 头部的进程归属标记，
#        是原生崩溃的权威归属（`pid: N, tid: N, name: main  >>> pkg <<<`）。
#   两者都出现才算数；既不匹配 `FATAL EXCEPTION` 的裸字样，也不匹配裸
#   `BEGIN: libc`（那是任何进程崩溃都会有的通用标记）。
CRASH_RE="Process: ${PKG}, PID:|>>> ${PKG} <<<"
if grep -qE "$CRASH_RE" "$LOG"; then
  echo "::error::crash markers attributed to $PKG found in $LOG:"
  grep -nE "$CRASH_RE" "$LOG" | head -40
  # 一并打印上下文，便于直接看到崩溃栈而不必下载 artifact。
  echo "──── context around first hit ────"
  FIRST_LINE=$(grep -nE "$CRASH_RE" "$LOG" | head -1 | cut -d: -f1)
  START=$((FIRST_LINE > 10 ? FIRST_LINE - 10 : 1))
  sed -n "${START},$((FIRST_LINE + 60))p" "$LOG"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "──── last 200 lines of $LOG ────"
  tail -200 "$LOG"
  exit 1
fi

echo "SMOKE_OK: installed, launched, no crash markers"
