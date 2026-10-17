param(
  [string]$PublishDir = "",
  [string]$ZipPath = ""
)

$ErrorActionPreference = "Stop"

# Never trust the process CWD for relative paths: PowerShell's own cmdlets use
# $PWD, but .NET APIs and native tools use the process working directory, which
# stays where the shell started. Anchor everything to the script location.
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Source = Join-Path $ProjectRoot "src\windows-launcher\WpfClient.cs"
$DomainSource = Join-Path $ProjectRoot "src\windows-launcher\DomainTab.cs"
$ConsoleSecuritySource = Join-Path $ProjectRoot "src\windows-launcher\ConsoleSecurityWindow.cs"
$ThemeSource = Join-Path $ProjectRoot "src\windows-launcher\ClientThemePalette.cs"
$UiStylesSource = Join-Path $ProjectRoot "src\windows-launcher\ClientUiStyles.cs"
$DistDir = Join-Path $ProjectRoot "dist"
$DefaultPublishDir = Join-Path $DistDir "88FRP-Windows"
$BackendExe = Join-Path $DistDir "88frp-web.exe"
$Csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$WpfDir = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\WPF"
$IconPath = Join-Path $ProjectRoot "assets\88frp-logo.ico"
$ManifestPath = Join-Path $ProjectRoot "src\windows-launcher\app.manifest"

if (-not $PublishDir) { $PublishDir = $DefaultPublishDir }
if (-not $ZipPath) { $ZipPath = Join-Path $DistDir "88FRP-Windows.zip" }
$OutputExe = Join-Path $PublishDir "88FRP.exe"

if (-not (Test-Path $Csc)) { throw "Cannot find .NET Framework C# compiler: $Csc" }
if (-not (Test-Path $IconPath)) { throw "Cannot find app icon: $IconPath" }
if (-not (Test-Path $ManifestPath)) { throw "Cannot find app manifest: $ManifestPath" }
if (-not (Test-Path $DomainSource)) { throw "Cannot find DomainTab.cs: $DomainSource" }

if (-not (Test-Path $BackendExe)) {
  Push-Location $ProjectRoot
  try { npm run build:web:single } finally { Pop-Location }
}

New-Item -ItemType Directory -Force -Path $PublishDir | Out-Null

# Build the reference list explicitly. Passing "/reference:(expr)" does not work:
# csc receives the literal parentheses and fails with CS2005.
$refs = @(
  "System.dll",
  "System.Core.dll",
  "Microsoft.CSharp.dll",
  "System.Drawing.dll",
  "System.Windows.Forms.dll",
  "System.Web.Extensions.dll",
  (Join-Path $WpfDir "WindowsBase.dll"),
  (Join-Path $WpfDir "PresentationCore.dll"),
  (Join-Path $WpfDir "PresentationFramework.dll"),
  "System.Xaml.dll"
)

$argList = New-Object System.Collections.Generic.List[string]
$argList.Add("/nologo")
$argList.Add("/target:winexe")
$argList.Add("/platform:x64")
$argList.Add("/codepage:65001")
$argList.Add("/win32icon:$IconPath")
$argList.Add("/win32manifest:$ManifestPath")
$argList.Add("/out:$OutputExe")
foreach ($r in $refs) { $argList.Add("/reference:$r") }
$argList.Add($Source)
$argList.Add($DomainSource)
$argList.Add($ConsoleSecuritySource)
$argList.Add($ThemeSource)
$argList.Add($UiStylesSource)

Write-Host "Compiling native client..."
& $Csc $argList.ToArray()
if ($LASTEXITCODE -ne 0) { throw "Native client compilation failed." }

Copy-Item -Force (Join-Path $ProjectRoot "scripts\configure-startup.ps1") (Join-Path $PublishDir "configure-startup.ps1")
Copy-Item -Force $BackendExe (Join-Path $PublishDir "88frp-web.exe")
Copy-Item -Force (Join-Path $ProjectRoot "assets\88frp-logo.png") (Join-Path $PublishDir "88frp-logo.png")
Copy-Item -Force $IconPath (Join-Path $PublishDir "88frp-logo.ico")

$Readme = @(
  "88FRP Windows 3.2.3",
  "",
  "使用方法：",
  "1. 双击 88FRP.exe 打开原生桌面客户端。",
  "2. 首次启动可设置开机自动运行，之后可在全局设置中调整。",
  "3. 关闭窗口后保持托盘后台运行；右键托盘可打开、重启后台或退出。",
  "4. 修改隧道选择与手动分组后，点击保存更改。",
  "",
  "安装与升级：",
  "推荐安装包，按向导选择安装目录、快捷方式和自启动选项。",
  "升级请直接覆盖安装，不要先卸载；安装前会备份，保留账号、实例与历史配置。",
  "便携版解压后运行 88FRP.exe，不要单独运行隐藏后台核心 88frp-web.exe。",
  "",
  "数据与文件：",
  "默认数据目录为 %LOCALAPPDATA%\88frp-node；已安装时以 machine-config.json 记录的原目录为准。",
  "迁移到其他电脑前请先备份数据，Windows 加密凭据需要重新授权。"
) -join [Environment]::NewLine
Set-Content -Path (Join-Path $PublishDir "README.txt") -Value $Readme -Encoding UTF8

if (Test-Path $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
Compress-Archive -Path (Join-Path $PublishDir "*") -DestinationPath $ZipPath

Write-Host "Native Windows client built:"
Write-Host "  $OutputExe"
Write-Host "Package:"
Write-Host "  $ZipPath"
