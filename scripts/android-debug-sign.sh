#!/usr/bin/env bash
# 用一次性 debug 证书给 unsigned release APK 签名，使其可被 adb install。
#
# ⚠ 这不是分发包的签名。目的仅让模拟器（以及任何开发者本机）能装上这个 APK，
#   以验证"应用在 Android 上能启动、不崩"。debug 证书不可用于分发，签名产物
#   只应作为 CI artifact 供人工复核，不能当作发布件。
#
# 为什么不改 gradle 的 signingConfigs：
#   src-tauri/gen/android/ 是 gitignore 的生成物，每次 `tauri android init` 重建，
#   往其中的 build.gradle.kts 注入代码无法持久化到仓库；而 apksigner 对已产出的
#   APK 直接签名，既不动生成物、也不影响构建链，边界清晰。
#
# 用法：bash scripts/android-debug-sign.sh <apk> [out-apk]
# 依赖：apksigner（Android SDK build-tools）与 keytool（JDK 17，CI 已装）。
set -euo pipefail

APK="${1:?usage: android-debug-sign.sh <apk> [out-apk]}"
OUT="${2:-${APK%-unsigned.apk}-debug-signed.apk}"

if [ ! -f "$APK" ]; then
  echo "::error::APK not found: $APK"
  exit 1
fi

# Android SDK 布局：$ANDROID_HOME/build-tools/<ver>/apksigner。
# 版本号不写死 —— CI 上由 gradle 阶段决定装了哪个版本，这里动态取最新的一个。
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  echo "::error::neither ANDROID_HOME nor ANDROID_SDK_ROOT is set"
  exit 1
fi
SDK="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"

APKSIGNER=""
if command -v apksigner >/dev/null 2>&1; then
  APKSIGNER="$(command -v apksigner)"
else
  # 取版本号最大的 build-tools（sort -V 做版本序，避免 37.0.0 vs 9.0.0 这类
  # 字典序陷阱）。
  find_apksigner() {
    local d
    d="$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1 || true)"
    if [ -n "$d" ] && [ -x "$d/apksigner" ]; then
      printf '%s\n' "$d/apksigner"
    fi
  }
  APKSIGNER="$(find_apksigner)"
fi
if [ -z "$APKSIGNER" ]; then
  # 刻意【不】在这里自装 build-tools。此前这里写的是
  #   yes | sdkmanager --install 'build-tools;latest' ... || true
  # 那是个【假安全网】，两点都错：
  #   1) `build-tools;latest` 不是合法的 sdkmanager 包名（它要具体版本，如
  #      `build-tools;37.0.0`），该命令必然失败；
  #   2) 失败又被 `|| true` 吞掉，于是"按需自装"从未真正发生过 —— 下面这个
  #      硬失败分支才是它唯一可能的归宿。
  # 实测（run 35733791102，本步成功那次）：`apksigner` 来自
  #   /usr/local/lib/android/sdk/build-tools/37.0.0/apksigner
  # 而 build-tools 是前一步 `tauri android build`（AGP）自己拉进来的，时间上
  # 早于本步；emulator-runner 在更后面才又装了一次。即本兜底【从未被触发】。
  # 与其保留一段永远不会正确执行的代码，不如失败时把原因和出路讲清楚。
  echo "::error::apksigner not found under $SDK/build-tools"
  echo "  ANDROID_HOME=$SDK"
  echo "  build-tools 目前的内容："
  ls -1 "$SDK/build-tools" 2>/dev/null || echo "    (build-tools 目录不存在)"
  echo "  出路：确认前一步 'Build universal APK' 已成功执行（AGP 会拉取 build-tools），"
  echo "        或在 workflow 的 setup-android 步骤显式声明一个具体版本，例如"
  echo "        packages: 'platform-tools, build-tools;37.0.0'"
  exit 1
fi
echo "apksigner: $APKSIGNER"

# 一次性 keystore。放在 RUNNER_TEMP，不进仓库、不进 artifact。
WORK="${RUNNER_TEMP:-$(mktemp -d)}/vrcxk-debug-sign"
mkdir -p "$WORK"
KS="$WORK/debug.keystore"
STOREPASS="android"   # 与 Android 官方 debug keystore 的惯例一致
KEYPASS="android"
ALIAS="androiddebugkey"

if [ ! -f "$KS" ]; then
  echo "── generating one-off debug keystore ──"
  keytool -genkeypair -v \
    -keystore "$KS" \
    -storepass "$STOREPASS" \
    -keypass "$KEYPASS" \
    -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null
fi

echo "── signing ──"
cp "$APK" "$OUT"
# --min-sdk-version 不指定：apksigner 从 APK 的 manifest 读取。
"$APKSIGNER" sign \
  --ks "$KS" \
  --ks-pass "pass:$STOREPASS" \
  --key-pass "pass:$KEYPASS" \
  --ks-key-alias "$ALIAS" \
  "$OUT"

echo "── verify ──"
"$APKSIGNER" verify --verbose "$OUT"

echo "signed: $OUT"
# 输出给后续步骤用（调用方可用 GITHUB_OUTPUT 接走）
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "signed_apk=$OUT" >> "$GITHUB_OUTPUT"
fi
