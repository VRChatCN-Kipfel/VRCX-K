<#
  MSI 侧的真机验收（issue #41 §4.2；规格见 PR #49 的「MSI 侧的归属判据」）。

  它验的是两件在 NSIS 那份脚本里**验不到**的事：
    ① 归属判据在 **HKLM** 这条路上真的生效（NSIS 的 SHCTX 是 HKCU，所以那是另一半）；
    ② §2 点名的**升级陷阱**：升级时旧的命令串仍指向**上一次的安装路径**，所以"存在即拒绝"的朴素判据
       会在每次升级时拒绝**我们自己的**产品 —— 症状与"真的有外来键"完全一样。

  ⚠ 与 `installer-acceptance.ps1`（NSIS）**刻意分成两个文件**：两者找包、静默参数、要守的 root 都不同
    （NSIS: `*setup.exe` + `/S` + HKCU；MSI: `*.msi` + `msiexec /qn` + **HKLM**），合成一个会让每一格
    都要先判断自己属于哪种安装器。

  ⚠ 本脚本只能在**有管理员权限的干净 Windows** 上跑（HKLM 写入 + 真装真卸）：CI 的 windows-latest 是，
    开发机**不是** —— 本机的 WiX 工具链根本跑不起来（`candle.exe` 无法执行），所以这一格的证据只能来自 CI。
#>
param(
  [string]$Scheme = 'vrcxk',
  [string]$Product = 'vrcx-k',
  [string]$BundleDir = 'target/release/bundle/msi'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$failures = [System.Collections.Generic.List[string]]::new()
function Say([string]$Message) { Write-Host $Message }
function Check([bool]$Condition, [string]$Message) {
  if ($Condition) { Say "PASS: $Message" } else { Say "FAIL: $Message"; $failures.Add($Message) }
}
function Stage([string]$Title) { Say ''; Say ('#' * 8 + " $Title " + '#' * 8) }

function Get-RegistryExport([string]$Key, [string]$Path) {
  if (-not (Test-Path $Key)) { return '<absent>' }
  # ⚠ reg.exe 只认原生 hive 写法（HKLM\…），PowerShell 的 HKLM:\… 会被它判为 "Invalid key name"。
  $nativeKey = $Key -replace '^HKCU:\\', 'HKCU\' -replace '^HKLM:\\', 'HKLM\'
  & reg.exe export $nativeKey $Path /y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "reg export failed for $nativeKey (exit $LASTEXITCODE)" }
  return Get-Content -Raw $Path
}

# ⚠ StrictMode 下 `(Get-ItemProperty …).'缺失的值'` 会**抛异常**，把"键没写成"这种预期内的失败
# 变成脚本崩溃 —— 那样后面的断言就全跑不到、失败清单也不完整。统一走这个安全取值。
function Get-RegValue([string]$Key, [string]$Name) {
  if (-not (Test-Path $Key)) { return $null }
  # 默认值在 PowerShell 注册表提供程序里的名字是字面量 '(default)'；空字符串会直接绑定失败。
  if ([string]::IsNullOrEmpty($Name)) { $Name = '(default)' }
  $item = Get-ItemProperty -Path $Key -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  $property = $item.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Wait-For([scriptblock]$Probe, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Probe) { return $true }
    Start-Sleep -Seconds 2
  }
  return [bool](& $Probe)
}

# msiexec 的退出码：0 = 成功，3010 = 成功但要重启。其余都当失败，并把**原始码**打出来 ——
# LaunchCondition 拒绝通常报 1602（user cancel），但把这当成契约去断言会脆（版本/阶段都可能变）。
function Invoke-Msi([string[]]$Arguments) {
  $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $Arguments -Wait -PassThru
  return $proc.ExitCode
}
function Test-MsiSuccess([int]$Code) { return ($Code -eq 0 -or $Code -eq 3010) }

# ARP 条目：Tauri 模板用 `Id="*"`（自动 GUID），所以**不能**按固定路径找，只能按 DisplayName 枚举。
function Get-ArpEntries([string]$Name) {
  $roots = @(
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $found = @()
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($child in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
      $props = Get-ItemProperty $child.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $props) { continue }
      $display = $props.PSObject.Properties['DisplayName']
      if ($null -ne $display -and $display.Value -eq $Name) { $found += $child.PSPath }
    }
  }
  return $found
}

# ⚠ 从命令串里取出被引号包住的 exe 路径 —— 模板写的就是 `"<path>" "%1"`。
# 本脚本第一版把安装目录写死成 `%ProgramFiles%\vrcx-k`，结果 CI 上直接假红：
# **上游模板的 AppSearch 会优先跟随已有的 HKCU InstallDir**（同一台机器上先跑过 NSIS 验收，
# 装到 `%LOCALAPPDATA%\vrcx-k`），于是 MSI 也装到了那里 —— 而"装到哪"本来就不该由脚本假定，
# 应该**读它自己写下的命令串**。
function Get-CommandExe([string]$Command) {
  if ([string]::IsNullOrEmpty($Command)) { return $null }
  $match = [regex]::Match($Command, '^"([^"]+)"')
  if ($match.Success) { return $match.Groups[1].Value }
  return ($Command -split '\s+')[0]
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$snapDir = Join-Path $repoRoot '.temp/installer-acceptance-msi'
New-Item -ItemType Directory -Force $snapDir | Out-Null

$ownKey = "HKLM:\Software\Classes\$Scheme"
$ownKeyNative = "HKLM\Software\Classes\$Scheme"
$commandKey = "$ownKey\shell\open\command"
# ⚠ 对照键必须是**我们自己的名字**，且只能由本脚本创建/删除（NSIS 那份踩过的坑：拿真实 vrcx 键当对照
# 会把它删掉重建）。真实存在的键只做**只读**导出比对。
$controlKey = 'HKLM:\Software\Classes\vrcx-acceptance-foreign'
$realVrcxKey = 'HKCU:\Software\Classes\vrcx'   # 既有 VRCX 自己的键：只读，一个字节都不许变
$installDir = Join-Path $env:ProgramFiles $Product          # MSI 的默认（perMachine）位置：只是一个候选
$localInstallDir = Join-Path $env:LOCALAPPDATA $Product      # NSIS（perUser）的位置：AppSearch 会跟随它
$foreignCommand = '"C:\fake\other.exe" "%1"'
# 模拟"我们自己的产品**装在别处**"：升级陷阱用例会把这个路径写进类键再装一次。
$staleOldCommand = '"C:\Program Files\vrcx-k-old\tauri-app.exe" "%1"'

Stage '0. 找包 + 断言我们真有 HKLM 写权限'
$msi = Get-ChildItem (Join-Path $repoRoot $BundleDir) -Filter '*.msi' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Check ($null -ne $msi) "找到 MSI 安装包（$BundleDir）"
if ($null -eq $msi) {
  Say '没有任何 MSI 可测 —— 构建步骤失败或路径不对，直接失败而不是跳过。'
  Say '### VERDICT: 无法开始 ###'
  exit 1
}
Say "msi: $($msi.FullName) ($([math]::Round($msi.Length / 1MB, 1)) MiB)"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Check $isAdmin '以管理员身份运行（MSI 是 perMachine，要写 HKLM）'
if (-not $isAdmin) {
  Say '没有管理员权限就没法验证这条路径 —— 明确失败，而不是让后面的 HKLM 断言假装通过。'
  Say '### VERDICT: 无法验证 ###'
  exit 1
}

Stage '1. 铺对照：本脚本自有的读写对照键 + 既有 vrcx 键的只读快照'
if (Test-Path $controlKey) { Remove-Item $controlKey -Recurse -Force }
New-Item -Path "$controlKey\shell\open\command" -Force | Out-Null
Set-ItemProperty $controlKey -Name 'URL Protocol' -Value ''
Set-ItemProperty "$controlKey\shell\open\command" -Name '(default)' -Value $foreignCommand
$controlBefore = Get-RegistryExport $controlKey (Join-Path $snapDir 'control-before.reg')
Check ($controlBefore -ne '<absent>') '对照键（本脚本自有名字）已建立'
$realBefore = Get-RegistryExport $realVrcxKey (Join-Path $snapDir 'real-vrcx-before.reg')
Say "  既有 vrcx 键的起始状态: $(if ($realBefore -eq '<absent>') { '不存在（干净机器）' } else { '存在，已快照' })"

try {
  Stage '2. 同名不同归属：MSI 必须拒绝覆盖 HKLM 里的外来处理器'
  Remove-Item $ownKey -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -Path $commandKey -Force | Out-Null
  Set-ItemProperty $ownKey -Name 'URL Protocol' -Value ''
  Set-ItemProperty $commandKey -Name '(default)' -Value $foreignCommand
  $foreignBefore = Get-RegistryExport $ownKey (Join-Path $snapDir 'own-foreign-before.reg')
  Check ($foreignBefore -ne '<absent>') "已铺好一个「同名但属于别人」的 $Scheme 类键（HKLM）"
  $payloadCandidates = @((Join-Path $installDir 'tauri-app.exe'), (Join-Path $localInstallDir 'tauri-app.exe'))
  $payloadBeforeRefusal = @($payloadCandidates | Where-Object { Test-Path $_ })

  $collisionCode = Invoke-Msi @('/i', "`"$($msi.FullName)`"", '/qn', '/norestart')
  Say "msiexec exit code (collision case): $collisionCode$([string]::Empty)"
  Check (-not (Test-MsiSuccess $collisionCode)) 'MSI 在冲突时以失败退出（LaunchCondition 拒绝；1602 = user cancel 是预期形状，但这里只断言"非成功"）'
  $foreignAfter = Get-RegistryExport $ownKey (Join-Path $snapDir 'own-foreign-after.reg')
  Check ($foreignBefore -eq $foreignAfter) '被拒绝的安装没有改动那个既有的 HKLM 类键（逐字节）'
  # ⚠ 不能断言"安装目录里没有 exe"：这台机器上可能**已经**有 NSIS 装出来的 exe（两个验收脚本在同一个 job 里
  # 先后跑），所以正确的判据是"被拒绝的这次没有**改变**候选位置的状态"。
  $payloadCandidates = @((Join-Path $installDir 'tauri-app.exe'), (Join-Path $localInstallDir 'tauri-app.exe'))
  $payloadAfterRefusal = @($payloadCandidates | Where-Object { Test-Path $_ })
  Check ($payloadAfterRefusal.Count -eq $payloadBeforeRefusal.Count) '被拒绝的安装没有新增/改动任何主程序文件'
  Remove-Item $ownKey -Recurse -Force -ErrorAction SilentlyContinue

  Stage '3. 静默安装（干净路径）'
  $installCode = Invoke-Msi @('/i', "`"$($msi.FullName)`"", '/qn', '/norestart')
  Say "msiexec exit code: $installCode"
  Check (Test-MsiSuccess $installCode) 'MSI 安装成功（0 或 3010）'

  $ownKeyExists = Wait-For { Test-Path $ownKey } 60
  Check $ownKeyExists "自有类键 $ownKeyNative 出现"
  $commandValue = if (Test-Path $commandKey) { Get-RegValue $commandKey '' } else { $null }
  Say "  命令串: $commandValue"
  # ⚠ 真正的判据是"注册出来的处理器指向一个**真实存在**的文件"，而不是"它在某个我假定的目录里"。
  # ⚠ 而且比较前必须**规范化**：实测 MSI 写进注册表的是 **8.3 短路径**
  # （`C:\Users\RUNNER~1\AppData\Local\vrcx-k\TAURI-~1.EXE`），而 NSIS 写的是长路径 ——
  # 直接比字面量会假红（第一版就是这么红的）。`Get-Item` 会把它展开成长名。
  $registeredExe = Get-CommandExe ($commandValue -as [string])
  Check ($null -ne $registeredExe -and $registeredExe.Length -gt 0) '命令串里能解析出一个 exe 路径'
  $registeredLong = if ($null -ne $registeredExe -and (Test-Path $registeredExe)) { (Get-Item $registeredExe).FullName } else { $null }
  Check ($null -ne $registeredLong -and (Split-Path $registeredLong -Leaf) -eq 'tauri-app.exe') "命令串指向的文件是主程序（短名展开后：$registeredLong）"
  Check ($null -ne $registeredLong) "命令串指向的文件确实存在（$registeredExe）"
  Check ($null -ne (Get-RegValue $ownKey 'URL Protocol')) '自有类键带 URL Protocol 值（Windows 认它是协议处理器）'
  $arpEntries = @(Get-ArpEntries $Product)
  Check ($arpEntries.Count -ge 1) "ARP 里有 $Product 的卸载条目（Install 段跑到尾）"

  # ⚠ 没有这条，"卸载后键消失"就可能是空过 —— 安装阶段根本没写成键时，它也"消失"。
  $keyWasWritten = $ownKeyExists

  Stage '4. ⚠ 升级陷阱：把命令串改成"我们自己装在别处"的旧路径，再装一次 —— 必须成功'
  # ⚠ 这一格测的是规格 §2 点名的陷阱：升级/重装时**存储的命令串仍指向上一次的安装路径**
  # （我们刚把它改成 vrcx-k-old，等价于"上次装在别处"），朴素的"键存在就拒绝"会在这里
  # **拒绝我们自己的产品**，而正确的判据（`Installed` / `WIX_UPGRADE_DETECTED` 短路）会放行。
  #
  # ⚠ 两个实测教训写在这里，免得下次又试：
  #   ① `INSTALLDIR="…"` 传在命令行上**不管用** —— 上游模板的 AppSearch 会用注册表里的旧值覆盖它；
  #   ② 因此"改目录"不能靠命令行，只能靠**改写类键**来制造"旧路径"这一状态。
  $staleBefore = Get-RegistryExport $ownKey (Join-Path $snapDir 'own-stale-before.reg')
  Set-ItemProperty $commandKey -Name '(default)' -Value $staleOldCommand
  Check ((Get-RegValue $commandKey '') -eq $staleOldCommand) "已把命令串伪装成旧路径（$staleOldCommand）"

  # ⚠ 同版本再跑一次 `msiexec /i` 会被当成**空操作**（实测：exit 0，但类键一个字都没改）——
  # 那样这一格就是**空过**：LaunchCondition 根本没被求值。`REINSTALL=ALL` + `REINSTALLMODE=amus`
  # 才真的走一遍安装序列（模板自己也把 REINSTALLMODE 设成 amus），从而让判据被求值。
  $upgradeCode = Invoke-Msi @('/i', "`"$($msi.FullName)`"", '/qn', '/norestart', 'REINSTALL=ALL', 'REINSTALLMODE=amus')
  Say "msiexec exit code (upgrade case): $upgradeCode"
  Check (Test-MsiSuccess $upgradeCode) '存储的命令串指向旧路径、且本产品已安装时，重装/升级没有被归属判据误拒'
  $commandAfterUpgrade = if (Test-Path $commandKey) { Get-RegValue $commandKey '' } else { $null }
  Say "  重装后的命令串: $commandAfterUpgrade"
  $exeAfterUpgrade = Get-CommandExe ($commandAfterUpgrade -as [string])
  Check ($null -ne $exeAfterUpgrade -and (Test-Path $exeAfterUpgrade)) "重装后类键指向的文件真实存在（$exeAfterUpgrade）"
  Check (($commandAfterUpgrade -as [string]) -ne $staleOldCommand) '重装后命令串已被写回真实路径（旧的伪装值没有留下）'

  Stage '5. 静默卸载 + 断言'
  $uninstallCode = Invoke-Msi @('/x', "`"$($msi.FullName)`"", '/qn', '/norestart')
  Say "msiexec exit code (uninstall): $uninstallCode"
  Check (Test-MsiSuccess $uninstallCode) 'MSI 卸载成功'
  $gone = Wait-For { -not (Test-Path $ownKey) } 60
  if ($keyWasWritten) {
    Check $gone "卸载后自有类键 $ownKeyNative 确实被删（acceptance criterion）"
  } else {
    # ⚠ 假绿守卫：安装阶段就没写成键时，"卸载后不存在"不构成任何证据。
    Check $false '安装阶段从未写成类键 ⇒ 卸载后的「键已消失」**无法验证**（按 FAIL 记，而不是空过成 PASS）'
  }
  $arpAfter = @(Get-ArpEntries $Product)
  Check ($arpAfter.Count -eq 0) '卸载后 ARP 条目也不在了'
  Check ((Get-RegistryExport $controlKey (Join-Path $snapDir 'control-after.reg')) -eq $controlBefore) '对照键（本脚本自有名字）逐字节未变'
  $realAfter = Get-RegistryExport $realVrcxKey (Join-Path $snapDir 'real-vrcx-after.reg')
  Check ($realAfter -eq $realBefore) '既有的 vrcx 类键逐字节未变（只读对照）'
} finally {
  # 收尾：清掉本脚本创建的一切（对照键 + 可能残留的类键 + 那个伪装用不到的旧目录）。
  # ⚠ **不去删安装目录**：MSI 可能按 AppSearch 跟随了 NSIS 的目录（同一个 job 里先跑过它），
  # 删掉就会破坏另一份验收留下的现场 —— 清理是卸载自己的事（第 5 阶段已在断言它）。
  if (Test-Path $controlKey) { Remove-Item $controlKey -Recurse -Force -ErrorAction SilentlyContinue }
}

Say ''
if ($failures.Count -eq 0) {
  Say '### VERDICT: all assertions passed ###'
  exit 0
}
Say "### VERDICT: FAILURES ($($failures.Count)) ###"
foreach ($f in $failures) { Say "  - $f" }
exit 1
