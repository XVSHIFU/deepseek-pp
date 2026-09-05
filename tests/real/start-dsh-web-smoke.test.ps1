#Requires -Version 7.2
$ErrorActionPreference = 'Stop'
$smokeScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\scripts\start-dsh-web-smoke.ps1'))
$smokeRepo = Split-Path (Split-Path $smokeScript -Parent) -Parent
$smokeProbe = @{ prompts = 0; clipboard = 0; runner = 0; pairing = $null }
$smokeExpectedRunner = 'dsh-web-real-smoke.mjs'

# Replace user interaction and model execution. This test never changes the
# actual clipboard, starts DSH, or connects to a browser.
function Read-Host {
    param([string]$Prompt)
    $smokeProbe.prompts++
    if ($smokeProbe.prompts -eq 1) { return 'abcdefghijklmnopabcdefghijklmnop' }
    if ($smokeProbe.clipboard -ne 1) { throw 'Pairing must precede browser confirmation.' }
    return ''
}
function Set-Clipboard {
    param([string]$Value)
    $smokeProbe.clipboard++
    $smokeProbe.pairing = $Value
}
function Test-Path { return $true }
function node {
    $smokeProbe.runner++
    if ($args.Count -ne 2 -or $args[1] -ne '--confirm-real-web') { throw 'Wrong runner arguments.' }
    if ($args[0] -ne (Join-Path (Split-Path $smokeScript -Parent) $smokeExpectedRunner)) { throw 'Wrong runner.' }
    if ((Get-Location).Path -ne $smokeRepo) { throw 'Wrong working directory.' }
    if ($env:DSH_HOME -ne (Join-Path $smokeRepo '.tmp-deepseek-live\dsh-home')) { throw 'Wrong isolated home.' }
    if ($env:DSH_WEB_BROKER_PORT -ne '43123') { throw 'Wrong port.' }
    if ($env:DSH_WEB_ALLOWED_EXTENSION_ORIGINS -ne 'chrome-extension://abcdefghijklmnopabcdefghijklmnop') { throw 'Wrong origin.' }
    if ($env:DSH_WEB_PAIRING_TOKEN -cne $smokeProbe.pairing -or $smokeProbe.pairing -cnotmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid pairing value.' }
    if ($smokeProbe.prompts -ne 2 -or $env:DSH_WEB_REAL_BROWSER_ATTESTATION -ne 'logged-in-and-broker-enabled') { throw 'Missing browser confirmation.' }
    $global:LASTEXITCODE = 0
}

$smokeSavedEnvironment = @{}
foreach ($name in @('DSH_HOME', 'DSH_WEB_BROKER_PORT', 'DSH_WEB_ALLOWED_EXTENSION_ORIGINS', 'DSH_WEB_PAIRING_TOKEN', 'DSH_WEB_REAL_BROWSER_ATTESTATION', 'DSH_TELEMETRY_DISABLED')) {
    $smokeSavedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$smokeOriginalLocation = (Get-Location).Path
try {
    $refused = $false
    try { & $smokeScript } catch { $refused = $true }
    if (-not $refused -or $smokeProbe.prompts -ne 0 -or $smokeProbe.clipboard -ne 0 -or $smokeProbe.runner -ne 0) {
        throw 'Invocation without explicit opt-in must have no effects.'
    }
    $refused = $false
    try { & $smokeScript -ReadOnlyTools } catch { $refused = $true }
    if (-not $refused -or $smokeProbe.prompts -ne 0 -or $smokeProbe.clipboard -ne 0 -or $smokeProbe.runner -ne 0) {
        throw 'Read-only invocation without explicit opt-in must have no effects.'
    }
    $captured = (& $smokeScript -ConfirmRealWeb 6>&1 | Out-String)
    if ($smokeProbe.runner -ne 1 -or $LASTEXITCODE -ne 0) { throw 'Runner was not invoked exactly once.' }
    if ($captured.Contains($smokeProbe.pairing)) { throw 'Pairing value printed to the terminal.' }
    if ((Get-Location).Path -ne $smokeOriginalLocation) { throw 'Working directory was not restored.' }
    $smokeProbe = @{ prompts = 0; clipboard = 0; runner = 0; pairing = $null }
    $smokeExpectedRunner = 'dsh-web-readonly-acceptance.mjs'
    $captured = (& $smokeScript -ConfirmRealWeb -ReadOnlyTools 6>&1 | Out-String)
    if ($smokeProbe.runner -ne 1 -or $LASTEXITCODE -ne 0) { throw 'Read-only runner was not invoked exactly once.' }
    if ($captured.Contains($smokeProbe.pairing)) { throw 'Pairing value printed to the terminal.' }
    if ((Get-Location).Path -ne $smokeOriginalLocation) { throw 'Working directory was not restored.' }
    Write-Output 'PASS: both modes refuse without opt-in and route paired launches without printing the token.'
}
finally {
    foreach ($name in $smokeSavedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $smokeSavedEnvironment[$name])
    }
}
