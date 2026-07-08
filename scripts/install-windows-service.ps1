param(
  [string]$ServiceName = "88FRP",
  [string]$DisplayName = "88FRP Background Service",
  [string]$AppExe = "",
  [string]$WinSWExe = "",
  [string]$DataDir = "",
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8801
)

$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return ""
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $PathValue))
}

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$DefaultAppExe = Join-Path $ProjectRoot "dist\88frp-web.exe"
$AppExe = Resolve-FullPath $(if ($AppExe) { $AppExe } else { $DefaultAppExe })
$WinSWExe = Resolve-FullPath $(if ($WinSWExe) { $WinSWExe } else { Join-Path $ProjectRoot "dist\winsw.exe" })

if (-not (Test-Path $AppExe)) {
  throw "Cannot find app executable: $AppExe. Build it first with: npm run build:web:single"
}

if (-not (Test-Path $WinSWExe)) {
  throw "Cannot find WinSW wrapper: $WinSWExe. Put winsw.exe there, or pass -WinSWExe C:\path\winsw.exe"
}

$ServiceDir = Join-Path $ProjectRoot "dist\service"
$LogDir = Join-Path $ServiceDir "logs"
New-Item -ItemType Directory -Force -Path $ServiceDir, $LogDir | Out-Null

$ServiceExe = Join-Path $ServiceDir "$ServiceName.exe"
$ServiceXml = Join-Path $ServiceDir "$ServiceName.xml"
Copy-Item -Force $WinSWExe $ServiceExe

if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $DataDir = Join-Path $env:LOCALAPPDATA "88frp-node\data"
}
$DataDir = Resolve-FullPath $DataDir
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$AppDir = Split-Path -Parent $AppExe
$Xml = @"
<service>
  <id>$ServiceName</id>
  <name>$DisplayName</name>
  <description>Runs 88FRP web control service and keeps selected tunnels online.</description>
  <executable>$AppExe</executable>
  <workingdirectory>$AppDir</workingdirectory>
  <env name="HOST" value="$HostName" />
  <env name="PORT" value="$Port" />
  <env name="DATA_DIR" value="$DataDir" />
  <env name="INSTANCE_AUTO_START_ON_BOOT" value="1" />
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>
  <log mode="roll-by-size">
    <directory>$LogDir</directory>
    <sizeThreshold>10485760</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
"@
Set-Content -Path $ServiceXml -Value $Xml -Encoding UTF8

Push-Location $ServiceDir
try {
  & $ServiceExe install
  & $ServiceExe start
} finally {
  Pop-Location
}

$ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "88FRP 控制台.url"
$Shortcut = @"
[InternetShortcut]
URL=http://$HostName`:$Port
"@
Set-Content -Path $ShortcutPath -Value $Shortcut -Encoding ASCII

Write-Host "88FRP service installed and started."
Write-Host "Console: http://$HostName`:$Port"
Write-Host "Data dir: $DataDir"
