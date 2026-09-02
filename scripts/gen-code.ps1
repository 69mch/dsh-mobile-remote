# gen-code.ps1 — 轮换连接码（旧码作废 + 解除设备绑定）
# 用法: powershell -ExecutionPolicy Bypass -File scripts/gen-code.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pairFile = Join-Path $root 'config\pairing.json'
$pairLib = Join-Path $root 'gateway\lib\pairing.js'

$nodeScript = @"
const { Pairing } = require(process.env.PAIR_LIB);
const p = new Pairing(process.env.PAIR_FILE, null);
const code = p.rotateCode();
console.log('NEW_CODE=' + code);
console.log(JSON.stringify(p.status(), null, 2));
"@
$tmp = Join-Path $env:TEMP 'gen-code.js'
[IO.File]::WriteAllText($tmp, $nodeScript)
$env:PAIR_LIB = $pairLib.Replace('\', '/')
$env:PAIR_FILE = $pairFile
$out = node $tmp
Remove-Item $tmp
Remove-Item Env:PAIR_LIB, Env:PAIR_FILE -ErrorAction SilentlyContinue
$codeLine = $out | Where-Object { $_ -match '^NEW_CODE=' }
Write-Host ""
Write-Host "=== 新连接码（旧码已作废，设备绑定已清除）===" -ForegroundColor Cyan
Write-Host "   $($codeLine -replace '^NEW_CODE=','')" -ForegroundColor Green
Write-Host ""
Write-Host "提示：如 Gateway 正在运行，新码立即生效（每次配对实时读 pairing.json）。" -ForegroundColor Yellow
Write-Host "此码仅本次显示，请立即在手机 App 输入。" -ForegroundColor Yellow
