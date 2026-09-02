# deploy-tailscale.ps1 — 主通道：安装 Tailscale 并 serve Gateway
# 流程：安装 Tailscale → 登录（浏览器授权）→ tailscale serve 把 9443 发布为 https://<机器名>.ts.net
# 手机端：安装 Tailscale App，登录同一账号，即可访问 ts.net 地址。
$ErrorActionPreference = 'Stop'

Write-Host "=== 主通道：Tailscale 部署 ===" -ForegroundColor Cyan

# 1) 检查是否已安装
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
$tsPath = "$env:ProgramFiles\Tailscale\tailscale.exe"
if (-not $ts -and -not (Test-Path $tsPath)) {
    Write-Host "未检测到 Tailscale，尝试 winget 安装..." -ForegroundColor Yellow
    winget install --id Tailscale.Tailscale --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "winget 安装失败。请手动下载: https://tailscale.com/download" -ForegroundColor Red
        Write-Host "安装完成后重新运行本脚本。" -ForegroundColor Yellow
        exit 1
    }
    $tsPath = "$env:ProgramFiles\Tailscale\tailscale.exe"
    Start-Sleep -Seconds 3
}
$tsBin = if ($ts) { $ts.Source } else { $tsPath }
Write-Host "Tailscale: $tsBin" -ForegroundColor Green

# 2) 服务启动 + 登录
Write-Host "确保 Tailscale 服务运行..." -ForegroundColor Yellow
& $tsBin up --timeout=30s 2>&1 | Out-String | Write-Host
$status = & $tsBin status 2>&1 | Out-String
Write-Host $status

# 3) 确认本机名（手机将访问 https://<机器名>.ts.net）
$self = (& $tsBin status --json 2>&1 | ConvertFrom-Json).Self
$dnsName = $self.DNSName -replace '\.$',''
if (-not $dnsName) {
    # 退路：取 status 首行
    $first = ($status -split "`n")[0]
    $dnsName = ($first -split '\s+')[1]
}
Write-Host "本机 ts.net 名称: $dnsName" -ForegroundColor Cyan

# 4) serve Gateway（HTTP 端口 9443 → https）
Write-Host "发布 Gateway 到 ts.net (https)..." -ForegroundColor Yellow
& $tsBin serve --bg http://127.0.0.1:9443
Start-Sleep -Seconds 2
& $tsBin serve status

Write-Host ""
Write-Host "=== 完成 ===" -ForegroundColor Green
Write-Host "手机访问: https://$dnsName" -ForegroundColor Cyan
Write-Host "（需手机 Tailscale App 登录同一账号；自动签发合法 TLS 证书）"
