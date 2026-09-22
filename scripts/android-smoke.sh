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
i=0
while [ "$i" -lt 45 ]; do
  if adb shell pidof "$PKG" >/dev/null 2>&1; then
    echo "process alive after $((i * 2))s"
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
adb logcat -d > "$LOG" 2>&1 || true
wc -l "$LOG" || true

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

# 崩溃判据只认这两类硬信号，不去猜业务层日志措辞（那会引入假阳性）。
if grep -qE 'FATAL EXCEPTION|Fatal signal [0-9]+|BEGIN: (libc|debuggerd)' "$LOG"; then
  echo "::error::crash markers found in logcat:"
  grep -nE 'FATAL EXCEPTION|Fatal signal [0-9]+|BEGIN: (libc|debuggerd)' "$LOG" | head -40
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "──── last 200 logcat lines ────"
  tail -200 "$LOG"
  exit 1
fi

echo "SMOKE_OK: installed, launched, no crash markers"
