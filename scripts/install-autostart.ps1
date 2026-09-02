# =============================================================
# install-autostart.ps1 - Register Gateway silent autostart
# Scheduled tasks run via wscript.exe + run-hidden.vbs so NOTHING ever
# flashes a console window (powershell -WindowStyle Hidden alone still shows
# a brief "little black window" under Interactive scheduled tasks).
#   1) DSHRemoteGateway  : at user logon; silent-start.ps1 (30s watchdog loop)
#   2) DSHGatewayMonitor : every 1 minute; ensure-gateway.ps1 (one-shot guard)
#   install:  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   remove:   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
# =============================================================
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$silent = Join-Path $root 'scripts\silent-start.ps1'
$ensure = Join-Path $root 'scripts\ensure-gateway.ps1'
$vbs    = Join-Path $root 'scripts\run-hidden.vbs'
$taskGw  = 'DSHRemoteGateway'
$taskMon = 'DSHGatewayMonitor'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskGw  -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskMon -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host ("Removed scheduled tasks: " + $taskGw + ", " + $taskMon) -ForegroundColor Green
  exit 0
}

foreach ($f in @($silent, $ensure, $vbs)) {
  if (-not (Test-Path $f)) { Write-Host ("Missing: " + $f) -ForegroundColor Red; exit 1 }
}

$principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\" + $env:USERNAME) `
  -LogonType Interactive -RunLevel Limited

# ---- DSHRemoteGateway: at logon, silent-start.ps1 (30s watchdog, stays resident)
$actionGw = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument ('"{0}" "{1}"' -f $vbs, $silent) -WorkingDirectory $root
$triggerGw = New-ScheduledTaskTrigger -AtLogOn
$settingsGw = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $taskGw -Action $actionGw -Trigger $triggerGw `
  -Principal $principal -Settings $settingsGw `
  -Description 'DSH Mobile Remote Gateway (pairing + proxy Harness GUI) silent autostart' -Force | Out-Null
Write-Host ("Registered scheduled task: " + $taskGw) -ForegroundColor Green
Write-Host "  Trigger: at user logon (wscript hidden wrapper)" -ForegroundColor Cyan

# ---- DSHGatewayMonitor: every 1 minute, ensure-gateway.ps1 (one-shot guard)
$actionMon = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument ('"{0}" "{1}"' -f $vbs, $ensure) -WorkingDirectory $root
$triggerMon = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration ([TimeSpan]::MaxValue)
$settingsMon = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskMon -Action $actionMon -Trigger $triggerMon `
  -Principal $principal -Settings $settingsMon `
  -Description 'DSH Mobile Remote Gateway minute guard (wscript hidden wrapper)' -Force | Out-Null
Write-Host ("Registered scheduled task: " + $taskMon) -ForegroundColor Green
Write-Host "  Trigger: every 1 minute (wscript hidden wrapper)" -ForegroundColor Cyan
Write-Host ""
Write-Host "Manual test run: powershell -File scripts\silent-start.ps1" -ForegroundColor Yellow
Write-Host "Inspect task:    powershell -Command Get-ScheduledTask -TaskName DSHRemoteGateway" -ForegroundColor Yellow
Write-Host "Remove task:     powershell -File scripts\install-autostart.ps1 -Uninstall" -ForegroundColor Yellow
