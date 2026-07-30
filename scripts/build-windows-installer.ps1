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
  $candidates = @()

  if ($env:INNO_SETUP_COMPILER) {
    $candidates += $env:INNO_SETUP_COMPILER
  }

  $pathCommand = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
  if ($pathCommand) {
    $candidates += $pathCommand.Source
  }

  $appPathKeys = @(
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ISCC.exe",
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ISCC.exe"
  )
  foreach ($key in $appPathKeys) {
    $appPath = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue)."(default)"
    if ($appPath) {
      $candidates += $appPath
    }
  }

  $uninstallRoots = @(
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($root in $uninstallRoots) {
    Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object {
      $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
      if ($entry.DisplayName -like "Inno Setup*" -and $entry.InstallLocation) {
        $candidates += (Join-Path $entry.InstallLocation "ISCC.exe")
      }
    }
  }

  $candidates += @(
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 7\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 7\ISCC.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 7\ISCC.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
  )
  $InnoSetupCompiler = $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -Unique |
    ForEach-Object { Get-Item -LiteralPath $_ } |
    Sort-Object { $_.VersionInfo.FileVersionRaw } -Descending |
    Where-Object {
      Test-Path -LiteralPath (Join-Path $_.DirectoryName "Languages\ChineseSimplified.isl") -PathType Leaf
    } |
    Select-Object -ExpandProperty FullName |
    Select-Object -First 1
}

if (-not $InnoSetupCompiler -or -not (Test-Path $InnoSetupCompiler)) {
  throw "Inno Setup compiler ISCC.exe was not found. Install Inno Setup 6/7, add ISCC.exe to PATH, set INNO_SETUP_COMPILER, or pass -InnoSetupCompiler."
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
Write-Host (Join-Path $ProjectRoot "dist\88FRP-Windows-Setup-3.0.0.exe")
