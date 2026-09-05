#Requires -Version 7.2
[CmdletBinding()]
param([switch]$ConfirmRealWeb, [switch]$ReadOnlyTools, [switch]$FileEdit)

$ErrorActionPreference = 'Stop'
if (-not $ConfirmRealWeb) {
    throw '使用 .\scripts\start-dsh-web-smoke.ps1 -ConfirmRealWeb 启动真实网页测试。'
}
if ($ReadOnlyTools -and $FileEdit) {
    throw '-ReadOnlyTools 和 -FileEdit 不能同时使用。'
}

$smokeRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$smokeDshHome = Join-Path $smokeRepo '.tmp-deepseek-live\dsh-home'
$smokeProfile = Join-Path $smokeDshHome 'profiles\deepseek-web-agent\package.json'
if (-not $ReadOnlyTools -and -not $FileEdit -and -not (Test-Path -LiteralPath $smokeProfile -PathType Leaf)) {
    throw '测试 profile 尚未准备，请按 tests/real/dsh-web-single-turn.md 的「其他 checkout」步骤初始化。'
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
$env:DSH_HOME = $smokeDshHome
$env:DSH_WEB_BROKER_PORT = '43123'
$env:DSH_WEB_PAIRING_TOKEN = $smokePairing
$env:DSH_WEB_ALLOWED_EXTENSION_ORIGINS = $smokeOrigin
$env:DSH_TELEMETRY_DISABLED = '1'

Write-Host '新配对令牌已复制到剪贴板。'
Write-Host '打开 DeepSeek++：设置 → 本机 Harness；启用桥接，端口填 43123，配对令牌按 Ctrl+V 粘贴，然后保存。'
Write-Host '此时显示「等待重试」是正常的。保持已登录的 DeepSeek 网页打开。'
if ($ReadOnlyTools -or $FileEdit) {
    if ($FileEdit) {
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
    $smokeRunner = if ($FileEdit) { 'dsh-web-file-edit-acceptance.mjs' } elseif ($ReadOnlyTools) { 'dsh-web-readonly-acceptance.mjs' } else { 'dsh-web-real-smoke.mjs' }
    & node (Join-Path $PSScriptRoot $smokeRunner) --confirm-real-web
    $smokeExit = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $smokeExit
