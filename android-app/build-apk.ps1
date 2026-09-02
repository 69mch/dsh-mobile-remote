# =============================================================
# build-apk.ps1 — 构建 DSH 远程 WebView 壳 APK（无 Android Studio）
# 依赖：
#   1. JDK 17+（winget: EclipseAdoptium.Temurin.17.JDK）
#   2. Android cmdline-tools + platform android-34 + build-tools
#      （已由 scripts/install-android-sdk.ps1 安装到 android-sdk/）
# 产物：dist/dsh-remote-v1.0.0.apk（debug 自签名）
# =============================================================
$ErrorActionPreference = 'Stop'
$proj = $PSScriptRoot                               # android-app/
$root = Split-Path -Parent $proj                    # mobile-remote/
# SDK 位置：优先显式参数 / 环境变量，其次 apps\android-tools\sdk（本机实际位置）
$sdk = $env:ANDROID_SDK_HOME
if (-not $sdk) {
  $cand = @(
    (Join-Path (Split-Path $root -Parent) 'android-tools\sdk'),   # apps/android-tools/sdk
    (Join-Path $root 'android-tools\sdk'),
    "$env:LOCALAPPDATA\Android\Sdk"
  )
  $sdk = $cand | Where-Object { Test-Path (Join-Path $_ 'platforms') } | Select-Object -First 1
}
if (-not $sdk) { throw '未定位到 Android SDK，请设置 $env:ANDROID_SDK_HOME' }
$dist = Join-Path $proj 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# ---- 定位 JDK ----
$candidates = @(
  "$env:ProgramFiles\Eclipse Adoptium",
  "$env:ProgramFiles\Microsoft",
  "$env:ProgramFiles\Java"
)
$javac = $null
foreach ($c in $candidates) {
  if (Test-Path $c) {
    $f = Get-ChildItem $c -Recurse -Filter 'javac.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($f) { $javac = $f.FullName; break }
  }
}
if (-not $javac) { $javac = (Get-Command javac -ErrorAction SilentlyContinue).Source }
if (-not $javac) { throw '未找到 JDK (javac)。请先安装 JDK 17' }
$javaHome = Split-Path (Split-Path $javac -Parent) -Parent
Write-Host "JDK: $javaHome"

# ---- 定位 SDK 组件 ----
$platform = Get-ChildItem "$sdk\platforms" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if (-not $platform) { throw '未找到 android platform，请先运行 install-android-sdk.ps1' }
$bt = Get-ChildItem "$sdk\build-tools" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if (-not $bt) { throw '未找到 build-tools' }
$androidJar = Join-Path $platform.FullName 'android.jar'
$aapt2 = Join-Path $bt.FullName 'aapt2.exe'
$d8 = Join-Path $bt.FullName 'd8.bat'
$zipalign = Join-Path $bt.FullName 'zipalign.exe'
$apksigner = Join-Path $bt.FullName 'apksigner.bat'
Write-Host "platform: $($platform.Name)"
Write-Host "build-tools: $($bt.Name)"

$build = Join-Path $proj 'build'
$genDir = Join-Path $build 'gen'
$classDir = Join-Path $build 'classes'
$outApk = Join-Path $build 'app.unaligned.apk'
New-Item -ItemType Directory -Force -Path $genDir,$classDir | Out-Null
# 清理旧产物
Remove-Item "$build\*.apk","$build\*.dex","$build\*.zip" -Force -ErrorAction SilentlyContinue

# ---- 1. aapt2 compile 资源 ----
Write-Host "== aapt2 compile =="
$compiled = Join-Path $build 'compiled'
New-Item -ItemType Directory -Force -Path $compiled | Out-Null
$resZip = Join-Path $compiled 'res.zip'
Remove-Item $resZip -Force -ErrorAction SilentlyContinue
& $aapt2 compile --dir "$proj\res" -o $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile 失败' }

# ---- 2. aapt2 link ----
Write-Host "== aapt2 link =="
& $aapt2 link -o $outApk `
  -I $androidJar `
  --manifest "$proj\AndroidManifest.xml" `
  --java $genDir `
  $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link 失败' }

# ---- 3. javac 编译（Android 字节码：-source/-target 8 + android.jar bootclasspath）----
Write-Host "== javac =="
$javaFiles = (Get-ChildItem "$proj\src" -Recurse -Filter '*.java' | ForEach-Object { "`"$($_.FullName)`"" }) -join ' '
$javacArgs = "-encoding UTF-8 -source 8 -target 8 -Xlint:-options -bootclasspath `"$androidJar`" -classpath `"$androidJar`" -d `"$classDir`" $javaFiles"
# cmd 包装：避免 PowerShell 把 javac 的 stderr 警告当作终止错误
cmd /c "`"$javac`" $javacArgs 2>&1" | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'javac 失败' }

# ---- 4. d8 dex ----
Write-Host "== d8 =="
$classFiles = Get-ChildItem $classDir -Recurse -Filter '*.class' | ForEach-Object { $_.FullName }
& cmd /c "`"$d8`" --lib $androidJar --release --output $build $classFiles 2>&1"
if ($LASTEXITCODE -ne 0) { throw 'd8 失败' }
$dex = Join-Path $build 'classes.dex'

# ---- 5. 把 dex 打入 apk ----
Write-Host "== add dex =="
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($outApk, 'Update')
$entry = $zip.CreateEntry('classes.dex', [System.IO.Compression.CompressionLevel]::Optimal)
$es = $entry.Open()
$bytes = [System.IO.File]::ReadAllBytes($dex)
$es.Write($bytes, 0, $bytes.Length)
$es.Dispose()
$zip.Dispose()

# ---- 6. zipalign ----
Write-Host "== zipalign =="
$aligned = Join-Path $build 'app.aligned.apk'
& $zipalign -f 4 $outApk $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }

# ---- 7. 自签名 ----
# 安全：签名口令从环境变量 DSH_KEYSTORE_PASS 读取，严禁写死在仓库里（keystore 已 .gitignore，不随仓库分发）。
Write-Host "== keystore + apksigner =="
$storePass = $env:DSH_KEYSTORE_PASS
if (-not $storePass) {
  Write-Host "缺少签名口令：请先设置 \$env:DSH_KEYSTORE_PASS 再构建。" -ForegroundColor Red
  throw 'DSH_KEYSTORE_PASS 未设置'
}
$ks = Join-Path $proj 'dsh-release.keystore'
if (-not (Test-Path $ks)) {
  $keytool = Join-Path $javaHome 'bin\keytool.exe'
  & $keytool -genkeypair -v -keystore $ks -alias dsh -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass $storePass -keypass $storePass -dname 'CN=DSH Remote,O=DSH,C=CN'
}
$signed = Join-Path $dist 'dsh-remote-v1.0.0.apk'
& cmd /c "`"$apksigner`" sign --ks $ks --ks-pass pass:$storePass --key-pass pass:$storePass --out $signed $aligned 2>&1"
if ($LASTEXITCODE -ne 0) { throw 'apksigner 失败' }

# 校验
& cmd /c "`"$apksigner`" verify $signed 2>&1" | Out-String | Write-Host
Write-Host ""
Write-Host "APK 完成: $signed ($((Get-Item $signed).Length) bytes)" -ForegroundColor Green
