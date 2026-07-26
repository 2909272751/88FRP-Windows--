param(
  [string]$InnoSetupCompiler = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$NativeBuild = Join-Path $ProjectRoot "scripts\build-windows-native.ps1"
$InstallerScript = Join-Path $ProjectRoot "scripts\88FRP-Windows.iss"
$DistDir = Join-Path $ProjectRoot "dist"
$InstallerPublishDir = Join-Path $DistDir "88FRP-Windows-installer-files"
$InstallerZip = Join-Path $DistDir "88FRP-Windows-installer-files.zip"

if (-not $InnoSetupCompiler) {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 7\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 7\ISCC.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
  )
  $InnoSetupCompiler = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $InnoSetupCompiler -or -not (Test-Path $InnoSetupCompiler)) {
  throw "Inno Setup compiler ISCC.exe was not found."
}

Push-Location $ProjectRoot
try {
  npm run build:web:single
  if ($LASTEXITCODE -ne 0) {
    throw "Web backend build failed."
  }
} finally {
  Pop-Location
}

& powershell -ExecutionPolicy Bypass -File $NativeBuild -PublishDir $InstallerPublishDir -ZipPath $InstallerZip
if ($LASTEXITCODE -ne 0) {
  throw "Windows client build failed."
}

& $InnoSetupCompiler ("/DBuildDir=" + $InstallerPublishDir) $InstallerScript
if ($LASTEXITCODE -ne 0) {
  throw "Installer build failed."
}

Write-Host "Windows installer built:"
Write-Host (Join-Path $ProjectRoot "dist\88FRP-Windows-Setup-1.1.0.exe")
