# =============================================================
# install-autostart.ps1 - Register Gateway silent autostart
# Scheduled task triggers at user logon; runs silent-start.ps1 (no window,
# 30s health watchdog -> auto restart).
#   install:  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   remove:   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
# =============================================================
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$silent = Join-Path $root 'scripts\silent-start.ps1'
$taskName = 'DSHRemoteGateway'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host ("Removed scheduled task: " + $taskName) -ForegroundColor Green
  exit 0
}

if (-not (Test-Path $silent)) { Write-Host ("Missing: " + $silent) -ForegroundColor Red; exit 1 }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$silent`"") `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn

$principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\" + $env:USERNAME) `
  -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'DSH Mobile Remote Gateway (pairing + proxy Harness GUI) silent autostart' -Force | Out-Null

Write-Host ("Registered scheduled task: " + $taskName) -ForegroundColor Green
Write-Host "  Trigger: at user logon" -ForegroundColor Cyan
Write-Host "  Action: silent gateway + 30s health watchdog" -ForegroundColor Cyan
Write-Host ""
Write-Host "Manual test run: powershell -File scripts\silent-start.ps1" -ForegroundColor Yellow
Write-Host "Inspect task:    powershell -Command Get-ScheduledTask -TaskName DSHRemoteGateway" -ForegroundColor Yellow
Write-Host "Remove task:     powershell -File scripts\install-autostart.ps1 -Uninstall" -ForegroundColor Yellow
