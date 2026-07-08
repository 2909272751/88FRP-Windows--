param(
  [string]$ServiceName = "88FRP",
  [switch]$RemoveLogs
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ServiceDir = Join-Path $ProjectRoot "dist\service"
$ServiceExe = Join-Path $ServiceDir "$ServiceName.exe"

if (-not (Test-Path $ServiceExe)) {
  throw "Cannot find service wrapper: $ServiceExe"
}

Push-Location $ServiceDir
try {
  & $ServiceExe stop
  & $ServiceExe uninstall
} finally {
  Pop-Location
}

if ($RemoveLogs) {
  Remove-Item -LiteralPath (Join-Path $ServiceDir "logs") -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "88FRP service uninstalled."
