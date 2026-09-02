# start-gateway.ps1 — 前台启动网关（供 setup / 手动 / 计划任务使用）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
node (Join-Path $root 'gateway\server.js')
