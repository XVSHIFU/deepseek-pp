#Requires -Version 7.2
$ErrorActionPreference = 'Stop'
$entry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts/start-dsh-web-smoke.ps1'))
$probe = @{ prompts = 0; clipboard = 0; wsl = 0; runs = 0; pairing = ''; failPreflight = $false; throwRun = $false; failConfirmation = $false; linuxHome = '/home/test-worker' }
function Read-Host {
    param([string]$Prompt)
    $probe.prompts++
    if ($probe.prompts -eq 1) { return 'abcdefghijklmnopabcdefghijklmnop' }
    if ($probe.failConfirmation) { throw 'Mock confirmation interruption.' }
    return ''
}
function Set-Clipboard { param([string]$Value) $probe.clipboard++; $probe.pairing = $Value }
function node { throw 'Linux mode must not run Windows Node.' }
function wsl.exe {
    $probe.wsl++
    $global:LASTEXITCODE = 0
    if ($args[0] -ne '-d' -or $args[1] -ne 'Ubuntu') { throw 'Wrong distribution.' }
    if ($args -contains '/usr/bin/printenv') { return $probe.linuxHome }
    if ($args -contains '--check') {
        if ($args -notcontains ($probe.linuxHome + '/.nvm/versions/node/v24.18.0/bin/node')) { throw 'Wrong Linux Node.' }
        if ($probe.failPreflight) { $global:LASTEXITCODE = 2 }
        return
    }
    $probe.runs++
    if ($probe.prompts -ne 2 -or $probe.clipboard -ne 1) { throw 'Missing pairing/confirmation.' }
    if ($args -notcontains ($probe.linuxHome + '/deepseek-web-harness') -or $args -notcontains 'scripts/dsh-web-command-acceptance.mjs' -or $args[-1] -ne '--confirm-real-web') { throw 'Wrong runner.' }
    if ($args -notcontains '/usr/bin/timeout' -or $args -notcontains '240s') { throw 'Missing independent Linux deadline.' }
    if ($env:DSH_HOME -ne ($probe.linuxHome + '/deepseek-web-harness/.tmp-deepseek-live/dsh-home')) { throw 'Wrong Linux home.' }
    if ($args -notcontains ('PATH=' + $probe.linuxHome + '/.nvm/versions/node/v24.18.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')) { throw 'Linux PATH must stay one argument, including spaces.' }
    if ($env:DSH_WEB_PAIRING_TOKEN -cne $probe.pairing -or ($args -join ' ').Contains($probe.pairing)) { throw 'Pairing leaked into argv or mismatched.' }
    if ($env:WSLENV -ne 'DSH_HOME/u:DSH_WEB_BROKER_PORT/u:DSH_WEB_PAIRING_TOKEN/u:DSH_WEB_ALLOWED_EXTENSION_ORIGINS/u:DSH_WEB_REAL_BROWSER_ATTESTATION/u:DSH_TELEMETRY_DISABLED/u') { throw 'Unexpected environment sharing.' }
    if ($env:DSH_WEB_REAL_BROWSER_ATTESTATION -ne 'logged-in-and-broker-enabled') { throw 'Missing attestation.' }
    if ($probe.throwRun) { throw 'Mock Linux launch failure.' }
}
$saved = @{}
foreach ($key in @('WSLENV','DSH_HOME','DSH_WEB_BROKER_PORT','DSH_WEB_PAIRING_TOKEN','DSH_WEB_ALLOWED_EXTENSION_ORIGINS','DSH_WEB_REAL_BROWSER_ATTESTATION','DSH_TELEMETRY_DISABLED')) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key)
}
$originalDirectory = (Get-Location).Path
$callerLaunchValues = @{}
function Assert-CallerRestored {
    if ($env:WSLENV -ne 'EXISTING_LOCAL_VARIABLE/u' -or (Get-Location).Path -ne $originalDirectory) { throw 'Caller location or WSLENV not restored.' }
    foreach ($key in $callerLaunchValues.Keys) {
        if ([Environment]::GetEnvironmentVariable($key) -cne $callerLaunchValues[$key]) { throw "Caller variable not restored: $key" }
    }
}
try {
    foreach ($arguments in @(@{ LinuxCommands = $true }, @{ ConfirmRealWeb = $true; LinuxCommands = $true; FileEdit = $true }, @{ ConfirmRealWeb = $true; LinuxCommands = $true; WslDistribution = '../wrong' })) {
        $refused = $false
        try { & $entry @arguments } catch { $refused = $true }
        if (-not $refused -or $probe.wsl -ne 0 -or $probe.prompts -ne 0 -or $probe.clipboard -ne 0) { throw 'Invalid launch must fail before effects.' }
    }
    $probe.failPreflight = $true
    $refused = $false
    try { & $entry -ConfirmRealWeb -LinuxCommands } catch { $refused = $true }
    if (-not $refused -or $probe.prompts -ne 0 -or $probe.clipboard -ne 0 -or $probe.runs -ne 0) { throw 'Missing Linux checkout must fail before pairing.' }
    $probe.failPreflight = $false
    $env:WSLENV = 'EXISTING_LOCAL_VARIABLE/u'
    foreach ($key in $saved.Keys | Where-Object { $_ -ne 'WSLENV' }) {
        # Also cover an originally absent value, not only existing strings.
        $callerLaunchValues[$key] = if ($key -eq 'DSH_WEB_REAL_BROWSER_ATTESTATION') { $null } else { 'caller-' + $key }
        if ($null -eq $callerLaunchValues[$key]) { Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($key, $callerLaunchValues[$key]) }
    }
    $captured = (& $entry -ConfirmRealWeb -LinuxCommands 6>&1 | Out-String)
    if ($probe.runs -ne 1 -or $LASTEXITCODE -ne 0 -or $captured.Contains($probe.pairing)) { throw 'Paired Linux route failed.' }
    Assert-CallerRestored
    $probe.prompts = 0; $probe.clipboard = 0; $probe.throwRun = $true
    $refused = $false
    try { & $entry -ConfirmRealWeb -LinuxCommands 6>&1 | Out-Null } catch { $refused = $true }
    if (-not $refused) { throw 'Expected launch failure.' }
    Assert-CallerRestored
    $probe.prompts = 0; $probe.clipboard = 0; $probe.throwRun = $false; $probe.failConfirmation = $true
    $runsBeforeConfirmation = $probe.runs
    $refused = $false
    try { & $entry -ConfirmRealWeb -LinuxCommands 6>&1 | Out-Null } catch { $refused = $true }
    if (-not $refused -or $probe.runs -ne $runsBeforeConfirmation) { throw 'Interrupted confirmation must not launch Linux command.' }
    Assert-CallerRestored
    $probe.prompts = 0; $probe.clipboard = 0; $probe.failConfirmation = $false; $probe.linuxHome = '/home/test worker with spaces'
    $captured = (& $entry -ConfirmRealWeb -LinuxCommands 6>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $captured.Contains($probe.pairing)) { throw 'Space-containing Linux paths failed.' }
    Assert-CallerRestored
    Write-Output 'PASS: Linux launch, pairing, argument boundaries, environment restoration and interrupted confirmation cleanup.'
}
finally {
    foreach ($key in $saved.Keys) {
        if ($null -eq $saved[$key]) { Remove-Item -LiteralPath ('Env:' + $key) -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
    }
}
