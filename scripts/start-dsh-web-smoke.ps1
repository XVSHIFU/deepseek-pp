#Requires -Version 7.2
[CmdletBinding()]
param(
    [switch]$ConfirmRealWeb, [switch]$ReadOnlyTools, [switch]$FileEdit,
    [switch]$LinuxCommands,
    [string]$WslDistribution = 'Ubuntu',
    [string]$LinuxProjectRoot = '',
    [string]$LinuxNodePath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $ConfirmRealWeb) {
    throw '使用 .\scripts\start-dsh-web-smoke.ps1 -ConfirmRealWeb 启动真实网页测试。'
}
if (([int]$ReadOnlyTools.IsPresent + [int]$FileEdit.IsPresent + [int]$LinuxCommands.IsPresent) -gt 1) {
    throw '-ReadOnlyTools、-FileEdit 和 -LinuxCommands 只能选择一个。'
}

$smokeRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$smokeDshHome = Join-Path $smokeRepo '.tmp-deepseek-live\dsh-home'
$smokeProfile = Join-Path $smokeDshHome 'profiles\deepseek-web-agent\package.json'
if (-not $ReadOnlyTools -and -not $FileEdit -and -not $LinuxCommands -and -not (Test-Path -LiteralPath $smokeProfile -PathType Leaf)) {
    throw '测试 profile 尚未准备，请按 tests/real/dsh-web-single-turn.md 的「其他 checkout」步骤初始化。'
}

if ($LinuxCommands) {
    if ($WslDistribution -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'WSL 发行版名称不正确。' }
    # Resolve the default Linux user's home without loading shell startup files.
    $smokeLinuxHome = (& wsl.exe -d $WslDistribution --exec /usr/bin/timeout 10s /usr/bin/printenv HOME | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $smokeLinuxHome -notmatch '^/[^\r\n\x00]+$') { throw '无法获取 Ubuntu 用户目录。' }
    if (-not $LinuxProjectRoot) { $LinuxProjectRoot = $smokeLinuxHome + '/deepseek-web-harness' }
    if (-not $LinuxNodePath) { $LinuxNodePath = $smokeLinuxHome + '/.nvm/versions/node/v24.18.0/bin/node' }
    if ($LinuxProjectRoot -notmatch '^/[^\r\n\x00]+$' -or $LinuxNodePath -notmatch '^/[^\r\n\x00:]+/node$') {
        throw '请填写绝对 Linux 项目路径和 Node 路径。'
    }
    & wsl.exe -d $WslDistribution --cd $LinuxProjectRoot --exec /usr/bin/timeout 15s $LinuxNodePath --check scripts/dsh-web-command-acceptance.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Linux 项目或 Node 尚未准备好；请先完成 Linux 副本和依赖安装。' }
    $smokeDshHome = $LinuxProjectRoot + '/.tmp-deepseek-live/dsh-home'
}

$smokeOrigin = (Read-Host '粘贴 DeepSeek++ 扩展 ID（Chrome/Edge），或完整 moz-extension://地址（Firefox）').Trim()
if ($smokeOrigin -match '^[a-p]{32}$') {
    $smokeOrigin = 'chrome-extension://' + $smokeOrigin
}
if ($smokeOrigin -notmatch '^(?:chrome|moz)-extension://[A-Za-z0-9_-]+$') {
    throw '扩展 ID 格式不正确。Chrome/Edge 的 ID 在扩展管理页面的开发者模式中可见。'
}

# The pairing value is local Broker authentication, not a DeepSeek credential.
# Capture it directly; never print it or put it in a command argument or file.
$smokePairing = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
Set-Clipboard -Value $smokePairing
$smokeSavedLaunchEnvironment = @{}
if ($LinuxCommands) {
    foreach ($smokeKey in @('DSH_HOME', 'DSH_WEB_BROKER_PORT', 'DSH_WEB_PAIRING_TOKEN', 'DSH_WEB_ALLOWED_EXTENSION_ORIGINS', 'DSH_WEB_REAL_BROWSER_ATTESTATION', 'DSH_TELEMETRY_DISABLED')) {
        $smokeSavedLaunchEnvironment[$smokeKey] = [Environment]::GetEnvironmentVariable($smokeKey)
    }
}
try {
$env:DSH_HOME = $smokeDshHome
$env:DSH_WEB_BROKER_PORT = '43123'
$env:DSH_WEB_PAIRING_TOKEN = $smokePairing
$env:DSH_WEB_ALLOWED_EXTENSION_ORIGINS = $smokeOrigin
$env:DSH_TELEMETRY_DISABLED = '1'

Write-Host '新配对令牌已复制到剪贴板。'
Write-Host '打开 DeepSeek++：设置 → 本机 Harness；启用桥接，端口填 43123，配对令牌按 Ctrl+V 粘贴，然后保存。'
Write-Host '此时显示「等待重试」是正常的。保持已登录的 DeepSeek 网页打开。'
if ($ReadOnlyTools -or $FileEdit -or $LinuxCommands) {
    if ($LinuxCommands) {
        Write-Host '本次在 Ubuntu 新建临时项目，测试本机命令读取、写入并验证文件；不修改你的项目，不自动重试命令。'
    }
    elseif ($FileEdit) {
        Write-Host '本次只让模型读取并修改新建的临时文件一次，不改你的项目，不执行终端命令。失败后不会自动重试修改。'
    }
    else {
        Write-Host '本次自动创建临时文件，只测试本机读取→网页终答；不会读取你的项目文件。'
    }
    Write-Host '按回车后会先准备本地工具；若扩展已显示离线，看到准备完成提示后再点一次「保存」。'
}
$null = Read-Host '完成上述配置后按回车开始测试（Ctrl+C 退出）'
$env:DSH_WEB_REAL_BROWSER_ATTESTATION = 'logged-in-and-broker-enabled'

Push-Location -LiteralPath $smokeRepo
try {
    if ($LinuxCommands) {
        $smokeSavedWslEnv = [Environment]::GetEnvironmentVariable('WSLENV')
        try {
            # WSLENV /u is Windows -> WSL. Share only Broker setup, not arbitrary
            # Windows paths, model credentials or the caller's WSLENV entries.
            # The pairing secret stays in the environment, never argv or a file.
            $env:WSLENV = 'DSH_HOME/u:DSH_WEB_BROKER_PORT/u:DSH_WEB_PAIRING_TOKEN/u:DSH_WEB_ALLOWED_EXTENSION_ORIGINS/u:DSH_WEB_REAL_BROWSER_ATTESTATION/u:DSH_TELEMETRY_DISABLED/u'
            $smokeLinuxPath = $LinuxNodePath.Substring(0, $LinuxNodePath.LastIndexOf('/')) + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
            & wsl.exe -d $WslDistribution --cd $LinuxProjectRoot --exec /usr/bin/timeout --kill-after=5s 240s /usr/bin/env "PATH=$smokeLinuxPath" $LinuxNodePath scripts/dsh-web-command-acceptance.mjs --confirm-real-web
            $smokeExit = $LASTEXITCODE
        }
        finally {
            if ($null -eq $smokeSavedWslEnv) { Remove-Item -LiteralPath 'Env:WSLENV' -ErrorAction SilentlyContinue }
            else { [Environment]::SetEnvironmentVariable('WSLENV', $smokeSavedWslEnv) }
        }
    }
    else {
        $smokeRunner = if ($FileEdit) { 'dsh-web-file-edit-acceptance.mjs' } elseif ($ReadOnlyTools) { 'dsh-web-readonly-acceptance.mjs' } else { 'dsh-web-real-smoke.mjs' }
        & node (Join-Path $PSScriptRoot $smokeRunner) --confirm-real-web
        $smokeExit = $LASTEXITCODE
    }
}
finally {
    Pop-Location
}
}
finally {
    # Linux launch values are borrowed for this run, including when the
    # confirmation prompt is interrupted. Keep the established Windows modes.
    if ($LinuxCommands) {
        foreach ($smokeKey in $smokeSavedLaunchEnvironment.Keys) {
            if ($null -eq $smokeSavedLaunchEnvironment[$smokeKey]) { Remove-Item -LiteralPath ('Env:' + $smokeKey) -ErrorAction SilentlyContinue }
            else { [Environment]::SetEnvironmentVariable($smokeKey, $smokeSavedLaunchEnvironment[$smokeKey]) }
        }
    }
}
exit $smokeExit
