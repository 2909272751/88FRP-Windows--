param(
  [string]$PublishDir = "",
  [string]$ZipPath = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Source = Join-Path $ProjectRoot "src\windows-launcher\WpfClient.cs"
$ConsoleSecuritySource = Join-Path $ProjectRoot "src\windows-launcher\ConsoleSecurityWindow.cs"
$DistDir = Join-Path $ProjectRoot "dist"
$DefaultPublishDir = Join-Path $DistDir "88FRP-Windows"
$BackendExe = Join-Path $DistDir "88frp-web.exe"
$Csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$WpfDir = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\WPF"
$IconPath = Join-Path $ProjectRoot "assets\88frp-logo.ico"
$ManifestPath = Join-Path $ProjectRoot "src\windows-launcher\app.manifest"

if (-not $PublishDir) {
  $PublishDir = $DefaultPublishDir
}
if (-not $ZipPath) {
  $ZipPath = Join-Path $DistDir "88FRP-Windows.zip"
}
$OutputExe = Join-Path $PublishDir "88FRP.exe"

if (-not (Test-Path $Csc)) {
  throw "Cannot find .NET Framework C# compiler: $Csc"
}

if (-not (Test-Path $IconPath)) {
  throw "Cannot find app icon: $IconPath"
}

if (-not (Test-Path $ManifestPath)) {
  throw "Cannot find app manifest: $ManifestPath"
}

if (-not (Test-Path $BackendExe)) {
  Push-Location $ProjectRoot
  try {
    npm run build:web:single
  } finally {
    Pop-Location
  }
}

New-Item -ItemType Directory -Force -Path $PublishDir | Out-Null

& $Csc `
  /nologo `
  /target:winexe `
  /platform:x64 `
  /codepage:65001 `
  /win32icon:$IconPath `
  /win32manifest:$ManifestPath `
  /out:$OutputExe `
  /reference:System.dll `
  /reference:System.Core.dll `
  /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll `
  /reference:System.Web.Extensions.dll `
  /reference:$(Join-Path $WpfDir "WindowsBase.dll") `
  /reference:$(Join-Path $WpfDir "PresentationCore.dll") `
  /reference:$(Join-Path $WpfDir "PresentationFramework.dll") `
  /reference:System.Xaml.dll `
  $Source `
  $ConsoleSecuritySource

if ($LASTEXITCODE -ne 0) {
  throw "Native client compilation failed."
}

Copy-Item -Force $BackendExe (Join-Path $PublishDir "88frp-web.exe")
Copy-Item -Force (Join-Path $ProjectRoot "assets\88frp-logo.png") (Join-Path $PublishDir "88frp-logo.png")
Copy-Item -Force $IconPath (Join-Path $PublishDir "88frp-logo.ico")

$Readme = @(
  "88FRP Windows native client",
  "",
  "Usage:",
  "1. Double click 88FRP.exe.",
  "2. The first launch asks whether to enable auto start.",
  "3. Closing the window keeps 88FRP running in the tray.",
  "4. Right click the tray icon to open, restart backend, or exit.",
  "",
  "Files:",
  "- 88FRP.exe is the native Windows desktop client.",
  "- 88frp-web.exe is the hidden backend core.",
  "- Data is saved in %LOCALAPPDATA%\88frp-node by default."
) -join [Environment]::NewLine
Set-Content -Path (Join-Path $PublishDir "README.txt") -Value $Readme -Encoding UTF8

if (Test-Path $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}
Compress-Archive -Path (Join-Path $PublishDir "*") -DestinationPath $ZipPath

Write-Host "Native Windows client built:"
Write-Host "  $OutputExe"
Write-Host "Package:"
Write-Host "  $ZipPath"
