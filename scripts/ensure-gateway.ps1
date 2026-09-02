# ensure-gateway.ps1 - one-shot check-and-start, called by scheduled task every 1 min.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$serverJs = Join-Path $root 'gateway\server.js'
$log = Join-Path $root 'logs\ensure-gateway.log'
$ok = $false
try {
  $r = Invoke-RestMethod 'http://127.0.0.1:9443/__gw/health' -TimeoutSec 3
  $ok = ($r.ok -eq $true)
} catch { $ok = $false }
if ($ok) { exit 0 }
$p = Start-Process node -ArgumentList @($serverJs) -WorkingDirectory $root -WindowStyle Hidden -PassThru
try { ("$(Get-Date -Format o) gateway down -> started pid=" + $p.Id) | Out-File -FilePath $log -Append -Encoding utf8 } catch {}
exit 0
