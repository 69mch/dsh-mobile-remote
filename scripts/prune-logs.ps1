# prune-logs.ps1 — 手动清理旧日志（超过保留天数）
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { Write-Host "无日志目录"; exit 0 }
$retainDays = 7
$cutoff = (Get-Date).AddDays(-$retainDays)
$removed = 0
Get-ChildItem $logDir -File | ForEach-Object {
    if ($_.LastWriteTime -lt $cutoff) {
        Remove-Item $_.FullName -Force
        $removed++
    }
}
Write-Host "已清理 $removed 个过期日志文件（>$retainDays 天）"
