# Shared installer transaction helpers. This file is also shipped with the
# portable client; it never runs on its own or deletes user data.
function Test-88PathInside([string]$Path, [string]$Root) {
  $full = [IO.Path]::GetFullPath($Path)
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  return $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)
}
function Get-88InstallRoots([string]$AppDir) {
  $roots = @([IO.Path]::GetFullPath($AppDir))
  foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{E5A669AC-D974-4A47-917B-3CC5E4A3C088}_is1',
                     'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{E5A669AC-D974-4A47-917B-3CC5E4A3C088}_is1')) {
    $item = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
    if ($item.InstallLocation) { $roots += [IO.Path]::GetFullPath($item.InstallLocation) }
  }
  return @($roots | Select-Object -Unique)
}
function Get-88ServiceExecutable([string]$CommandLine) {
  if ($CommandLine -match '^\s*"([^"]+)"') { return $Matches[1] }
  if ($CommandLine -match '^\s*(.+?\.exe)(?:\s|$)') { return $Matches[1] }
  return ''
}
function Get-88LegacyServices([string[]]$InstallRoots) {
  return @(Get-CimInstance Win32_Service | Where-Object {
    $owned = $false
    $exe = Get-88ServiceExecutable $_.PathName
    if ($_.Name -match '^88frp(?:$|[-_ .])' -and $exe -and
        [IO.Path]::GetFileName($exe) -in @('88frp-service.exe','88FRP.exe','88frp-web.exe')) {
      foreach ($root in $InstallRoots) { if (Test-88PathInside $exe $root) { $owned = $true } }
    }
    $owned
  })
}
function Test-88HasInstances([string]$Root) {
  $dir = Join-Path $Root 'data\instances'
  if ((Test-Path -LiteralPath $dir -PathType Container) -and
      @((Get-ChildItem -LiteralPath $dir -Directory) | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'frpc.toml') }).Count -gt 0) { return $true }
  foreach ($name in @('88frp-account.json','access-center.json','console-auth.json')) {
    $path = Join-Path $Root ('data\' + $name)
    if (Test-Path -LiteralPath $path) {
      $value = [IO.File]::ReadAllText($path) | ConvertFrom-Json
      if ($value.encryptedToken -or $value.encryptedFrpToken -or $value.encryptedVerifier) { return $true }
    }
  }
  return $false
}
function Resolve-88UpgradeDataRoot([string]$RequestedRoot, $Services) {
  $requested = [IO.Path]::GetFullPath($RequestedRoot)
  $candidates = @()
  foreach ($service in $Services) {
    $exe = Get-88ServiceExecutable $service.PathName
    $xmlPath = [IO.Path]::ChangeExtension($exe, '.xml')
    if (Test-Path -LiteralPath $xmlPath) {
      $xml = [xml][IO.File]::ReadAllText($xmlPath)
      foreach ($entry in $xml.service.env) {
        if ($entry.name -eq 'APP_BASE_DIR' -and [IO.Path]::IsPathRooted($entry.value)) { $candidates += [IO.Path]::GetFullPath($entry.value) }
        if ($entry.name -eq 'DATA_DIR' -and [IO.Path]::IsPathRooted($entry.value) -and
            [IO.Path]::GetFileName($entry.value.TrimEnd('\')) -eq 'data') { $candidates += [IO.Path]::GetDirectoryName($entry.value.TrimEnd('\')) }
      }
    }
  }
  if (@($Services).Count) { $candidates += Join-Path $env:ProgramData '88frp-node' }
  $populated = @($candidates | Select-Object -Unique | Where-Object { Test-88HasInstances $_ })
  $others = @($populated | Where-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') -ine $requested.TrimEnd('\') })
  if ($others.Count -and (Test-88HasInstances $requested)) {
    throw 'Both the saved directory and a legacy service directory contain instances. Installation stopped to protect both copies; choose the correct data directory first.'
  }
  if ($others.Count -gt 1) { throw 'More than one legacy data directory contains instances. Installation stopped without merging or deleting data.' }
  if ($others.Count -eq 1) { return $others[0] }
  return $requested
}
function Set-88PrivateDirectory([string]$Directory, [string]$OwnerSid) {
  [IO.Directory]::CreateDirectory($Directory) | Out-Null
  $acl = [IO.Directory]::GetAccessControl($Directory, [Security.AccessControl.AccessControlSections]::Access)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($rule) }
  foreach ($sid in @($OwnerSid, 'S-1-5-18', 'S-1-5-32-544') | Where-Object { $_ } | Select-Object -Unique) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($Directory, $acl)
}
function New-88UpgradeBackup([string]$Root, [string]$AppDir, [string]$OwnerSid) {
  $backupRoot = Join-Path ([IO.Path]::GetDirectoryName($Root)) '88frp-backups'
  Set-88PrivateDirectory $backupRoot $OwnerSid
  $snapshot = Join-Path $backupRoot ('upgrade-3.2.4-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  [IO.Directory]::CreateDirectory($snapshot) | Out-Null
  $data = Join-Path $Root 'data'
  if (Test-Path -LiteralPath $data) { Copy-Item -LiteralPath $data -Destination $snapshot -Recurse }
  if (Test-Path -LiteralPath $Root) { Get-ChildItem -LiteralPath $Root -File | Copy-Item -Destination $snapshot }
  $machine = Join-Path $AppDir 'machine-config.json'
  if (Test-Path -LiteralPath $machine) { Copy-Item -LiteralPath $machine -Destination (Join-Path $snapshot 'machine-config.json') }
  return $snapshot
}
function Get-88OwnedProcesses([string[]]$InstallRoots, [string]$DataRoot) {
  return @(Get-CimInstance Win32_Process -Filter "Name='88FRP.exe' OR Name='88frp-web.exe' OR Name='88frpc.exe'" | Where-Object {
    $owned = $false
    if ($_.ExecutablePath) {
      if ($_.Name -ieq '88frpc.exe') { $owned = Test-88PathInside $_.ExecutablePath (Join-Path $DataRoot 'runtime\bin') }
      else { foreach ($root in $InstallRoots) { if (Test-88PathInside $_.ExecutablePath $root) { $owned = $true } } }
    }
    $owned
  })
}
function Test-88BackendOwnership([string]$AppDir, [int]$Port) {
  $expected = [IO.Path]::GetFullPath((Join-Path $AppDir '88frp-web.exe'))
  foreach ($listener in Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
    if ($process.ExecutablePath -and [IO.Path]::GetFullPath($process.ExecutablePath) -ieq $expected) { return $true }
  }
  return $false
}
function Start-88BackendTask($Folder, [bool]$StartupEnabled) {
  $task = $Folder.GetTask('88FRP Backend')
  if ($StartupEnabled) { $task.Run($null) | Out-Null; return }
  # Verify and resume this installation even when boot startup was unchecked.
  # Disabling a running task leaves this one launch alive but prevents boot runs.
  $task.Enabled = $true
  try { $task.Run($null) | Out-Null }
  finally { $task.Enabled = $false }
}
function Restore-88Upgrade([string]$StatePath) {
  if (-not (Test-Path -LiteralPath $StatePath)) { return }
  $state = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
  if ($state.committed) { return }
  foreach ($saved in $state.services) {
    $current = @(Get-88LegacyServices $state.installRoots | Where-Object Name -eq $saved.name)
    if (-not $current.Count) { continue }
    $mode = switch ($saved.startMode) { 'Auto' { 'Automatic' } 'Manual' { 'Manual' } 'Disabled' { 'Disabled' } default { throw 'Unknown original service startup mode.' } }
    Set-Service -Name $saved.name -StartupType $mode
    if ($saved.wasRunning -and (Get-Service -Name $saved.name).Status -ne 'Running') { Start-Service -Name $saved.name }
  }
  $state.rolledBack = $true
  Save-Json $StatePath $state
}
function Prepare-88Upgrade([string]$AppDir, [string]$Root, [string]$OwnerSid, [string]$StatePath) {
  $requestedRoot = $Root
  $roots = @(Get-88InstallRoots $AppDir)
  $services = @(Get-88LegacyServices $roots)
  $root = Resolve-88UpgradeDataRoot $Root $services
  $state = [ordered]@{ dataRoot=$root; profileRoot=$requestedRoot; userSid=$OwnerSid; installRoots=$roots; backup=''; committed=$false; rolledBack=$false; services=@($services | ForEach-Object {
    [ordered]@{name=$_.Name; startMode=$_.StartMode; wasRunning=($_.State -eq 'Running'); executable=(Get-88ServiceExecutable $_.PathName)}
  }) }
  Save-Json $StatePath $state
  $resume = @()
  $instances = Join-Path $root 'data\instances'
  if (Test-Path -LiteralPath $instances) {
    foreach ($dir in Get-ChildItem -LiteralPath $instances -Directory) {
      $runtime = Join-Path $dir.FullName 'runtime.json'
      if (Test-Path -LiteralPath $runtime) {
        $value = [IO.File]::ReadAllText($runtime) | ConvertFrom-Json
        if ($value.status -eq 'running' -or $value.resumeOnBackendStart) { $resume += $runtime }
      }
    }
  }
  foreach ($service in $services) { Set-Service -Name $service.Name -StartupType Disabled }
  $backends = @(Get-88OwnedProcesses $roots $root | Where-Object Name -ieq '88frp-web.exe' | ForEach-Object ProcessId)
  Stop-BackendForUpgrade $root $backends
  foreach ($service in $services) {
    if ((Get-Service -Name $service.Name).Status -ne 'Stopped') { Stop-Service -Name $service.Name -Force }
    (Get-Service -Name $service.Name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
  }
  foreach ($process in Get-88OwnedProcesses $roots $root) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
  for ($i=0; $i -lt 20; $i++) {
    if (-not @(Get-88OwnedProcesses $roots $root).Count) { break }
    Start-Sleep -Milliseconds 250
  }
  if (@(Get-88OwnedProcesses $roots $root).Count) { throw 'Application processes are still running. No application files have been replaced.' }
  foreach ($runtime in $resume) {
    $value = [IO.File]::ReadAllText($runtime) | ConvertFrom-Json
    $value | Add-Member -NotePropertyName resumeOnBackendStart -NotePropertyValue $true -Force
    Save-Json $runtime $value
  }
  $state.backup = New-88UpgradeBackup $root $AppDir $OwnerSid
  Save-Json $StatePath $state
  return $state
}
function Copy-88UpgradeUiPreferences($State) {
  if (-not $State.profileRoot -or $State.profileRoot -ieq $State.dataRoot) { return }
  foreach ($name in @('native-client-theme.txt','native-client-collapsed-tunnel-groups.json','native-client-update-state.json')) {
    $source = Join-Path $State.profileRoot $name
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $archive = Join-Path $State.backup 'previous-profile-ui'
    [IO.Directory]::CreateDirectory($archive) | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $archive $name) -Force
    $destination = Join-Path $State.dataRoot $name
    if (-not (Test-Path -LiteralPath $destination) -or (Get-Item -LiteralPath $source).LastWriteTimeUtc -gt (Get-Item -LiteralPath $destination).LastWriteTimeUtc) {
      Copy-Item -LiteralPath $source -Destination $destination -Force
    }
  }
}
function Test-88UpgradeFiles([string]$AppDir) {
  if (-not ('FrpUpgradeAccess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FrpUpgradeAccess {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
  public static int Check(string p) {
    using(var h=CreateFile(p,0x40010000,7,IntPtr.Zero,3,0,IntPtr.Zero)) { return h.IsInvalid ? Marshal.GetLastWin32Error() : 0; }
  }
}
'@
  }
  foreach ($name in @('88FRP.exe','88frp-web.exe','configure-startup.ps1','windows-upgrade.ps1','88frp-logo.png','88frp-logo.ico','README.txt')) {
    $path = Join-Path $AppDir $name
    if (-not (Test-Path -LiteralPath $path)) { continue }
    if ((Get-Item -LiteralPath $path -Force).IsReadOnly) { throw "Application file is read-only: $name. No files have been replaced." }
    $errorCode = [FrpUpgradeAccess]::Check($path)
    if ($errorCode) { throw "Application file cannot be replaced: $name (Windows error $errorCode). No files have been replaced." }
  }
  $parent = $AppDir
  while (-not (Test-Path -LiteralPath $parent -PathType Container)) { $parent = [IO.Path]::GetDirectoryName($parent) }
  $probe = Join-Path $parent ('88frp-write-test-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $stream = New-Object IO.FileStream($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
  $stream.Dispose()
}
function Complete-88Upgrade([string]$StatePath) {
  if (-not (Test-Path -LiteralPath $StatePath)) { return }
  $state = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
  # The new backend has passed readiness. From this point never restart the
  # obsolete host alongside it, even if optional file archiving fails.
  $state.committed = $true
  Save-Json $StatePath $state
  $cleanupErrors = @()
  foreach ($saved in $state.services) {
    try {
      $current = @(Get-88LegacyServices $state.installRoots | Where-Object Name -eq $saved.name)
      if (-not $current.Count) { continue }
      if ($current[0].State -ne 'Stopped' -or $current[0].StartMode -ne 'Disabled') { throw 'The legacy service is not safely retired.' }
      $archive = ''
      if ([IO.Path]::GetFileName($saved.executable) -ieq '88frp-service.exe' -and (Test-Path -LiteralPath $saved.executable)) {
        $inside = @($state.installRoots | Where-Object { Test-88PathInside $saved.executable $_ }).Count -gt 0
        if (-not $inside -or -not [IO.Path]::IsPathRooted($state.backup)) { throw 'Unsafe legacy wrapper archive path.' }
        $destination = Join-Path $state.backup 'retired-service'
        [IO.Directory]::CreateDirectory($destination) | Out-Null
        $archive = Join-Path $destination ([IO.Path]::GetFileName($saved.executable))
        Copy-Item -LiteralPath $saved.executable -Destination $archive -Force
      }
      $result = Invoke-CimMethod -InputObject $current[0] -MethodName Delete
      if ($result.ReturnValue -notin @(0, 16)) { throw ('Legacy service cleanup failed: ' + $result.ReturnValue) }
      if ($archive) { Remove-Item -LiteralPath $saved.executable -Force }
    } catch { $cleanupErrors += $_.Exception.Message }
  }
  $state | Add-Member -NotePropertyName cleanupErrors -NotePropertyValue @($cleanupErrors) -Force
  Save-Json $StatePath $state
  if ($cleanupErrors.Count) { throw ($cleanupErrors -join '; ') }
}
