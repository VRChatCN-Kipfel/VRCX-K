#!/usr/bin/env bash
# android-smoke.sh 的崩溃判据回归测试（无需设备、无需 Android SDK）。
#
# 为什么需要它：崩溃判据很容易"看起来对"，但有两种静默失效方式，且都不报错：
#   ① 误报：全量 logcat 里别的进程崩溃（裸 `FATAL EXCEPTION` / `Fatal signal`），
#      被算到本应用头上 —— 会让正常的 run 变红，久了就被当噪声忽略。
#   ② 漏报：改用 `adb logcat --pid=<app pid>` 过滤时，**原生崩溃会整类丢失** ——
#      tombstone 由 `debuggerd` / `crash_dump` 写出，其日志条目的 pid 不是应用的
#      pid。漏报比误报危险得多：本步存在的唯一目的就是抓崩溃。
#   本脚本用假 adb 把这两种情形都钉住。
#
# 用法：bash scripts/android-smoke.test.sh
# 退出码：0 = 全部通过；非 0 = 有场景不符预期。
#
# ⚠ 安全：本测试会注入一个假 `adb`。若隔离失败，`adb install` 会打到【真机】上
#   （本项目开发机上实测有 Quest 2 长期连接；首版测试就这样误触过真机，幸好喂的是
#   0 字节空文件被 PackageManager 拒绝）。故运行前先证明隔离生效，不成立就直接退出。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE="$REPO/.temp/fake-adb"

rm -rf "$FAKE"; mkdir -p "$FAKE/bin" "$FAKE/out"

# ── 假 adb：按环境变量返回预设结果 ──────────────────────────────────────
cat > "$FAKE/bin/adb" <<'FAKEADB'
#!/usr/bin/env bash
case "$1" in
  wait-for-device) exit 0 ;;
  shell)
    shift
    case "$1" in
      pidof) [ -n "${FAKE_PID:-}" ] && echo "$FAKE_PID"; exit 0 ;;
      *boot_completed*) echo 1; exit 0 ;;
      "cmd") echo "com.vrcxk.app/.MainActivity"; exit 0 ;;
      "dumpsys") echo "ResumedActivity: com.vrcxk.app/.MainActivity"; exit 0 ;;
      *) exit 0 ;;
    esac ;;
  install) exit "${FAKE_INSTALL_RC:-0}" ;;
  logcat)
    # -c（清空）不产出内容；-d（dump）吐出预设日志。
    for a in "$@"; do [ "$a" = "-c" ] && exit 0; done
    cat "${FAKE_LOGCAT:-/dev/null}" 2>/dev/null || true
    exit 0 ;;
  *) exit 0 ;;
esac
FAKEADB
chmod +x "$FAKE/bin/adb"

# 假 sleep：跳过脚本里的 15s 等待与轮询间隔。
cat > "$FAKE/bin/sleep" <<'FAKESLEEP'
#!/usr/bin/env bash
exit 0
FAKESLEEP
chmod +x "$FAKE/bin/sleep"

# ── 护栏：证明隔离生效后才继续 ───────────────────────────────────────────
# PATH 只留 假 adb 目录 + 系统常规目录，使真 adb（Windows 下在 System32，
# Linux 下在 SDK platform-tools）不可达。
export PATH="$FAKE/bin:/usr/bin:/bin"
RESOLVED="$(command -v adb || true)"
if [ -z "$RESOLVED" ]; then
  echo "FAIL: fake adb not resolvable — PATH isolation did not take effect" >&2
  exit 2
fi
if [ "$RESOLVED" != "$FAKE/bin/adb" ]; then
  echo "FAIL: adb resolved to '$RESOLVED', not the fake one — refusing to run" >&2
  echo "      (a real device could be hit by 'adb install')" >&2
  exit 2
fi
echo "isolation ok: adb -> $RESOLVED"

PASS=0; FAILED=0
run_case() {
  local name="$1" pid="$2" logcat="$3" expect="$4"
  export PATH="$FAKE/bin:/usr/bin:/bin"
  export FAKE_PID="$pid" FAKE_LOGCAT="$logcat"
  local outdir="$FAKE/out/$name"
  rm -rf "$outdir"
  bash "$REPO/scripts/android-smoke.sh" "$FAKE/fake.apk" "$outdir" > "$outdir.log" 2>&1
  local rc=$?
  local got="fail"; [ "$rc" -eq 0 ] && got="pass"
  if [ "$got" = "$expect" ]; then
    echo "  PASS  $name -> $got"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name -> $got (expected $expect)"
    sed -n '1,20p' "$outdir.log" | sed 's/^/        /'
    FAILED=$((FAILED + 1))
  fi
}

# 造一个非空文件：0 字节会被 PackageManager 以 "Size must be positive" 拒绝，
# 那与判据无关，会掩盖真正的失败原因。
printf 'PK\x03\x04fake-apk-content' > "$FAKE/fake.apk"

cat > "$FAKE/lc-ok.txt" <<'EOF'
09-22 14:07:49.000  1234  1234 I ActivityManager: Start proc com.vrcxk.app
09-22 14:07:50.000  1234  1234 D VRCX-K: hello from app
EOF

# 本应用 Java 崩溃：AndroidRuntime 固定打印 "Process: <pkg>, PID:"
cat > "$FAKE/lc-java.txt" <<'EOF'
09-22 14:07:49.000  1234  1234 I ActivityManager: Start proc
09-22 14:07:52.000  1234  1234 E AndroidRuntime: FATAL EXCEPTION: main
09-22 14:07:52.001  1234  1234 E AndroidRuntime: Process: com.vrcxk.app, PID: 1234
09-22 14:07:52.002  1234  1234 E AndroidRuntime: java.lang.RuntimeException: boom
EOF

# 本应用【原生】崩溃：tombstone 由 crash_dump 写，pid 不是应用的 ——
# 这正是"按 app pid 过滤"会漏掉的场景。
cat > "$FAKE/lc-native.txt" <<'EOF'
09-22 14:07:52.000  1234  1234 F libc: Fatal signal 11 (SIGSEGV), code 1
09-22 14:07:52.100  8888  8888 I crash_dump: *** *** *** *** *** *** ***
09-22 14:07:52.101  8888  8888 I crash_dump: pid: 1234, tid: 1234, name: main  >>> com.vrcxk.app <<<
EOF

# 别的进程崩溃：不应算到本应用头上（误报防线）。
cat > "$FAKE/lc-other.txt" <<'EOF'
09-22 14:07:49.000  1234  1234 I ActivityManager: Start proc
09-22 14:07:51.000  9999  9999 E AndroidRuntime: FATAL EXCEPTION: main
09-22 14:07:51.001  9999  9999 E AndroidRuntime: Process: com.other.app, PID: 9999
09-22 14:07:51.500  7777  7777 I crash_dump: pid: 9999, tid: 9999, name: x  >>> com.other.app <<<
EOF

# 裸信号名噪音（属于别的进程）：旧的"裸信号名"判据会在这里误报。
cat > "$FAKE/lc-noise.txt" <<'EOF'
09-22 14:07:49.000  1234  1234 I ActivityManager: Start proc
09-22 14:07:50.000  9999  9999 F libc: Fatal signal 6 (SIGABRT)
09-22 14:07:50.100  7777  7777 I debuggerd: BEGIN: libc
EOF

echo "── android-smoke.sh crash-criteria regression ──"
run_case "ok-no-crash"       "1234" "$FAKE/lc-ok.txt"     "pass"
run_case "app-java-crash"    "1234" "$FAKE/lc-java.txt"   "fail"
run_case "app-native-crash"  "1234" "$FAKE/lc-native.txt" "fail"
run_case "other-app-crash"   "1234" "$FAKE/lc-other.txt"  "pass"
run_case "bare-signal-noise" "1234" "$FAKE/lc-noise.txt"  "pass"
run_case "never-started"     ""     "$FAKE/lc-ok.txt"     "fail"

echo
echo "$PASS passed, $FAILED failed"
rm -rf "$FAKE"
[ "$FAILED" -eq 0 ]
