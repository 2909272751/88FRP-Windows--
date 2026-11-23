param(
  [string]$OutputPath = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ToolsDir = Join-Path $ProjectRoot ".tools"
$CaddyVersion = "v2.11.9"
$CloudflarePluginVersion = "v0.2.4"
$XcaddyVersion = "v0.4.7"
$GoToolchain = "go1.26.0"
$OutputPath = if ($OutputPath) {
  [IO.Path]::GetFullPath($OutputPath)
} else {
  Join-Path $ProjectRoot "bin\amd64\caddy.exe"
}

function Write-Step([string]$Message) {
  Write-Host "[caddy] $Message"
}

if (-not $Force -and (Test-Path -LiteralPath $OutputPath)) {
  $version = (& $OutputPath version 2>$null) -join "`n"
  if ($LASTEXITCODE -eq 0 -and $version -like "*$CaddyVersion*") {
    $modules = (& $OutputPath list-modules 2>$null) -join "`n"
    if ($LASTEXITCODE -eq 0 -and $modules -match "dns\.providers\.cloudflare") {
      Write-Step "已存在固定版本 $CaddyVersion（含 Cloudflare DNS），跳过构建。"
      exit 0
    }
  }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

$go = Join-Path $ToolsDir "go\bin\go.exe"
if (-not (Test-Path -LiteralPath $go)) {
  $goCommand = Get-Command go.exe -ErrorAction SilentlyContinue
  if (-not $goCommand) {
    throw "未找到 Go。请安装 Go 1.24+，或把 Go 解压到 .tools\go。"
  }
  $go = $goCommand.Source
}

$env:GOTOOLCHAIN = "$GoToolchain+auto"
$env:CGO_ENABLED = "0"
$env:GOOS = "windows"
$env:GOARCH = "amd64"
$env:GOBIN = Join-Path $ToolsDir "bin"
New-Item -ItemType Directory -Force -Path $env:GOBIN | Out-Null

$xcaddy = Join-Path $env:GOBIN "xcaddy.exe"
if (-not (Test-Path -LiteralPath $xcaddy)) {
  Write-Step "安装固定版本 xcaddy $XcaddyVersion"
  & $go install "github.com/caddyserver/xcaddy/cmd/xcaddy@$XcaddyVersion"
  if ($LASTEXITCODE -ne 0) { throw "xcaddy 安装失败。" }
}

Write-Step "构建 Caddy $CaddyVersion + cloudflare $CloudflarePluginVersion（$GoToolchain）"
$temporary = "$OutputPath.$PID.tmp.exe"
try {
  & $xcaddy build $CaddyVersion `
    --with "github.com/caddy-dns/cloudflare@$CloudflarePluginVersion" `
    --output $temporary
  if ($LASTEXITCODE -ne 0) { throw "Caddy 构建失败。" }

  $version = (& $temporary version 2>$null) -join "`n"
  if ($LASTEXITCODE -ne 0 -or $version -notlike "*$CaddyVersion*") {
    throw "构建产物版本校验失败：$version"
  }
  $modules = (& $temporary list-modules 2>$null) -join "`n"
  if ($LASTEXITCODE -ne 0 -or $modules -notmatch "dns\.providers\.cloudflare") {
    throw "构建产物缺少 Cloudflare DNS 模块。"
  }
  Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
  Write-Step "完成：$OutputPath"
} finally {
  if (Test-Path -LiteralPath $temporary) {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}
