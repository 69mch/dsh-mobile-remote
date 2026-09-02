# =============================================================
# silent-start.ps1 — 静默启动 Gateway（无窗口，守护常驻）
# 供计划任务调用；检测 9443 健康，未启动则拉起 node gateway/server.js。
# 每 30s 心跳检测，进程崩溃自动重启。
# =============================================================
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$serverJs = Join-Path $root 'gateway\server.js'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$watchLog = Join-Path $logDir 'silent-watchdog.log'

function Write-Log($m) { "$(Get-Date -Format o) $m" | Out-File -FilePath $watchLog -Append -Encoding utf8 }
function Get-HealthOk {
  try { $r = Invoke-RestMethod 'http://127.0.0.1:9443/__gw/health' -TimeoutSec 3; return ($r.ok -eq $true) } catch { return $false }
}
function Start-Gw {
  # 无窗口后台启动 node
  $p = Start-Process node -ArgumentList @($serverJs) -WindowStyle Hidden -PassThru
  Write-Log "start gateway pid=$($p.Id)"
}

# 启动时确保运行
if (-not (Get-HealthOk)) {
  Start-Gw
}

# 守护循环：每 30s 检查，挂了重启
while ($true) {
  Start-Sleep -Seconds 30
  if (-not (Get-HealthOk)) {
    Write-Log "health check failed, restarting"
    Start-Gw
  }
}
