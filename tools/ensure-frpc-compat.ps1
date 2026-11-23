$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $root "dist\88frpc-compat.exe"
$runtime = Join-Path $env:LOCALAPPDATA "88frp-node\runtime\bin\amd64"
$target = Join-Path $runtime "88frpc.exe"
$real = Join-Path $runtime "88frpc-real.exe"
$logDir = Join-Path $root "logs"
$logPath = Join-Path $logDir "frpc-compat-guard.log"

if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-GuardLog([string]$message) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
    Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
}

function Get-Sha256([string]$path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($path)
    try {
        return [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-", "")
    }
    finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

try {
    if (-not (Test-Path -LiteralPath $wrapper)) {
        throw "Compatibility wrapper is missing: $wrapper"
    }

    $wrapperHash = Get-Sha256 $wrapper
    if (Test-Path -LiteralPath $target) {
        $targetHash = Get-Sha256 $target
        if ($targetHash -eq $wrapperHash) {
            exit 0
        }
    }

    if (-not (Test-Path -LiteralPath $real)) {
        if (-not (Test-Path -LiteralPath $target)) {
            throw "Original frpc binary is missing: $target"
        }
        Copy-Item -LiteralPath $target -Destination $real -Force
        Write-GuardLog "Saved original frpc as 88frpc-real.exe"
    }

    if (Test-Path -LiteralPath $target) {
        $backup = Join-Path $runtime ("88frpc-embedded-" + (Get-Date -Format "yyyyMMddHHmmss") + ".exe")
        try {
            Rename-Item -LiteralPath $target -NewName (Split-Path -Leaf $backup) -Force
            Write-GuardLog "Renamed old frpc to $(Split-Path -Leaf $backup)"
        }
        catch {
            Write-GuardLog "Rename failed; will overwrite directly: $($_.Exception.Message)"
        }
    }

    Copy-Item -LiteralPath $wrapper -Destination $target -Force
    Write-GuardLog "Restored the frpc tunnel-name compatibility wrapper"

    $restarted = $false
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        try {
            Invoke-RestMethod `
                -Uri "http://127.0.0.1:8801/api/gateway/restart" `
                -Method Post `
                -Headers @{ "X-88FRP-Desktop" = "1" } `
                -ContentType "application/json" `
                -Body "{}" `
                -TimeoutSec 30 | Out-Null
            $restarted = $true
            break
        }
        catch {
            Start-Sleep -Seconds 5
        }
    }

    if ($restarted) {
        Write-GuardLog "Gateway restarted; compatibility wrapper is active"
    }
    else {
        Write-GuardLog "Wrapper installed, but gateway is not responding yet"
    }
}
catch {
    Write-GuardLog ("Repair failed: " + $_.Exception.Message)
    exit 1
}
