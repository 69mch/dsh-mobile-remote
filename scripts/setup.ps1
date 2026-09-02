# =============================================================
# setup.ps1 — Mobile Remote Gateway 初始化与启动（连接码模式）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
# =============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "=== DSH Mobile Remote Gateway Setup ===" -ForegroundColor Cyan

# 1) Node 检查
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host "缺少 Node.js" -ForegroundColor Red; exit 1 }
Write-Host "Node: $(node --version)" -ForegroundColor Green

# 2) 生成连接码（若无）
$pairFile = Join-Path $root 'config\pairing.json'
if (-not (Test-Path $pairFile)) {
    Write-Host "首次运行：生成连接码..." -ForegroundColor Yellow
    powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'gen-code.ps1')
} else {
    Write-Host "连接码已存在（轮换请运行 gen-code.ps1）。" -ForegroundColor Yellow
}

# 3) 启动网关
Write-Host ""
Write-Host "=== 启动网关 ===" -ForegroundColor Cyan
$startArgs = @('-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'start-gateway.ps1'))
Start-Process powershell -ArgumentList $startArgs -WindowStyle Hidden
Start-Sleep -Milliseconds 1500
try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:9443/__gw/health' -TimeoutSec 3
    Write-Host "网关运行正常: ok=$($h.ok) auth=$($h.auth)" -ForegroundColor Green
} catch {
    Write-Host "网关似乎未就绪（可访问 /__gw/health 检查）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1. 查看当前连接码：powershell -File scripts/gen-code.ps1"
Write-Host "  2. 主通道 Tailscale: powershell -File scripts/deploy-tailscale.ps1"
Write-Host "  3. 手机 App 输入连接码即可绑定本设备"
Write-Host "本机测试: http://127.0.0.1:9443/__gw/health"
