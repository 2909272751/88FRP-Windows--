param(
  [ValidateSet('Enable', 'Disable', 'Install', 'Remove', 'PrepareUpgrade')][string]$Mode = 'Enable',
  [Parameter(Mandatory = $true)][string]$AppDir,
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [string]$UserSid = '',
  [int]$EnableStartup = 1
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules;$env:ProgramFiles\WindowsPowerShell\Modules"

function Escape-Xml([string]$Value) { [Security.SecurityElement]::Escape($Value) }
function Stop-BackendForUpgrade([string]$Root) {
  $port = 8801
  $portsFile = Join-Path $Root 'native-client-service-ports.json'
  if (Test-Path -LiteralPath $portsFile) {
    $port = [int](Get-Content -LiteralPath $portsFile -Raw -Encoding UTF8 | ConvertFrom-Json).consolePort
    if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid saved console port.' }
  }
  $baseUrl = "http://127.0.0.1:$port"
  try { $health = Invoke-RestMethod -Uri ($baseUrl + '/api/health') -TimeoutSec 2 -UseBasicParsing }
  catch { return }
  if ($health.data.service -ne '88frp-node-web') { throw 'Console port belongs to another service.' }
  Invoke-RestMethod -Uri ($baseUrl + '/api/system/shutdown') -Method Post -ContentType 'application/json' -Body '{"stopInstances":false}' -Headers @{'X-88FRP-Desktop'='1'} -TimeoutSec 5 -UseBasicParsing | Out-Null
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod -Uri ($baseUrl + '/api/health') -TimeoutSec 1 -UseBasicParsing | Out-Null }
    catch { return }
  }
  throw 'The running backend did not stop; no application files were replaced.'
}
function Save-Json([string]$File, $Value) {
  $temp = $File + '.new'
  [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 60), (New-Object Text.UTF8Encoding($false)))
  if ([IO.File]::Exists($File)) { [IO.File]::Replace($temp, $File, ($File + '.previous')) }
  else { [IO.File]::Move($temp, $File) }
}
function Convert-Credentials($Value, [bool]$RawDpapi) {
  if ($null -eq $Value) { return }
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    foreach ($property in $Value.PSObject.Properties) {
      if ($property.Name -like 'encrypted*' -and $property.Value -is [string] -and $property.Value) {
        $cipher = [string]$property.Value
        if ($cipher.StartsWith('machine:')) { continue }
        if ($RawDpapi) {
          $plain = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($cipher), $null, 'CurrentUser')
        } else {
          $secure = ConvertTo-SecureString -String $cipher
          $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
          try { $plain = [Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
          finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
        }
        try { $property.Value = 'machine:' + [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($plain, $null, 'LocalMachine')) }
        finally { if ($plain) { [Array]::Clear($plain, 0, $plain.Length) } }
      } else { Convert-Credentials $property.Value $RawDpapi }
    }
  } elseif ($Value -is [array]) { foreach ($item in $Value) { Convert-Credentials $item $RawDpapi } }
}

try {
  $AppDir = [IO.Path]::GetFullPath($AppDir)
  $DataRoot = [IO.Path]::GetFullPath($DataRoot)
  $settingsFile = Join-Path $AppDir 'machine-config.json'
  if (Test-Path -LiteralPath $settingsFile) {
    $saved = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $DataRoot = [IO.Path]::GetFullPath($saved.dataRoot)
    $UserSid = $saved.userSid
  }
  if ($Mode -eq 'PrepareUpgrade') {
    Stop-BackendForUpgrade $DataRoot
    exit 0
  }
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  $folder = $scheduler.GetFolder('\')
  $legacy = @('88FRP Background', '88FRP (boot)', '88FRP', '88frp')
  if ($Mode -eq 'Disable' -or $Mode -eq 'Remove') {
    foreach ($name in (@('88FRP Backend', '88FRP Desktop') + $legacy)) {
      try { $folder.DeleteTask($name, 0) } catch { }
    }
    if ($UserSid) { Remove-ItemProperty -LiteralPath "Registry::HKEY_USERS\$UserSid\Software\Microsoft\Windows\CurrentVersion\Run" -Name '88FRP' -ErrorAction SilentlyContinue }
    exit 0
  }
  if (-not $UserSid) { $UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
  if ($Mode -eq 'Enable' -and -not (Test-Path -LiteralPath (Join-Path $AppDir 'unins000.exe'))) {
    throw 'Please install 88FRP with the installer before enabling SYSTEM boot startup.'
  }
  [IO.Directory]::CreateDirectory($DataRoot) | Out-Null
  if ($Mode -eq 'Install') {
    $backupRoot = Join-Path ([IO.Path]::GetDirectoryName($DataRoot)) '88frp-backups'
    $snapshot = Join-Path $backupRoot ('upgrade-3.2.2-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    [IO.Directory]::CreateDirectory($snapshot) | Out-Null
    $existingData = Join-Path $DataRoot 'data'
    if (Test-Path -LiteralPath $existingData) { Copy-Item -LiteralPath $existingData -Destination $snapshot -Recurse }
    Get-ChildItem -LiteralPath $DataRoot -File | Copy-Item -Destination $snapshot
  }
  # Machine DPAPI permits SYSTEM startup; restrict credential files to the owning
  # user, SYSTEM and Administrators before converting any secrets.
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($UserSid, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
    $identity = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $DataRoot -AclObject $acl
  Add-Type -AssemblyName System.Security
  $files = @()
  $dataDir = Join-Path $DataRoot 'data'
  if (Test-Path -LiteralPath $dataDir) { $files = @(Get-ChildItem -LiteralPath $dataDir -Filter '*.json' -File -Recurse) }
  $pending = @()
  # Decrypt everything before writing anything. A different administrator cannot
  # decrypt the previous user's credentials: fail explicitly, preserving them.
  foreach ($file in $files) {
    $content = [IO.File]::ReadAllText($file.FullName)
    if ($content -notmatch '"encrypted[^" ]*"\s*:') { continue }
    $value = $content | ConvertFrom-Json
    Convert-Credentials $value ($file.Name -eq 'domain-binding.json')
    $pending += @{ File = $file.FullName; Value = $value }
  }
  $backup = Join-Path $DataRoot ('credential-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  foreach ($item in $pending) {
    $relative = $item.File.Substring($DataRoot.Length).TrimStart('\')
    $destination = Join-Path $backup $relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    Copy-Item -LiteralPath $item.File -Destination $destination
    Save-Json $item.File $item.Value
  }
  Save-Json $settingsFile @{ dataRoot = $DataRoot; userSid = $UserSid }
  # A SYSTEM task must only execute files in an administrator-controlled folder.
  $appAcl = New-Object Security.AccessControl.DirectorySecurity
  $appAcl.SetAccessRuleProtection($true, $false)
  $appAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @($UserSid, 'ReadAndExecute'))) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($entry[0])), $entry[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $appAcl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $AppDir -AclObject $appAcl
  $exe = Escape-Xml (Join-Path $AppDir '88FRP.exe')
  $working = Escape-Xml $AppDir
  $sidXml = Escape-Xml $UserSid
  $taskEnabled = if ($Mode -eq 'Install' -and $EnableStartup -eq 0) { 'false' } else { 'true' }
  $commonSettings = "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>$taskEnabled</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"
  $backendXml = @"
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><BootTrigger><Enabled>true</Enabled><Delay>PT45S</Delay></BootTrigger></Triggers>
<Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
<Settings>$commonSettings<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="System"><Exec><Command>$exe</Command><Arguments>--backend-host</Arguments><WorkingDirectory>$working</WorkingDirectory></Exec></Actions>
</Task>
"@
  $desktopXml = @"
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$sidXml</UserId></LogonTrigger></Triggers>
<Principals><Principal id="User"><UserId>$sidXml</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings>$commonSettings</Settings>
<Actions Context="User"><Exec><Command>$exe</Command><WorkingDirectory>$working</WorkingDirectory></Exec></Actions>
</Task>
"@
  $taskAcl = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$UserSid)"
  $folder.RegisterTask('88FRP Backend', $backendXml, 6, 'SYSTEM', $null, 5, $taskAcl) | Out-Null
  $folder.RegisterTask('88FRP Desktop', $desktopXml, 6, $UserSid, $null, 3, $null) | Out-Null
  foreach ($name in $legacy) { try { $folder.DeleteTask($name, 0) } catch { } }
  Remove-ItemProperty -LiteralPath "Registry::HKEY_USERS\$UserSid\Software\Microsoft\Windows\CurrentVersion\Run" -Name '88FRP' -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText((Join-Path $DataRoot 'native-client-first-run.flag'), $(if ($taskEnabled -eq 'true') { 'enabled' } else { 'declined' }))
  if ($taskEnabled -eq 'true') {
    $folder.GetTask('88FRP Backend').Run($null) | Out-Null
    $port = 8801
    $portsFile = Join-Path $DataRoot 'native-client-service-ports.json'
    if (Test-Path -LiteralPath $portsFile) { $port = (Get-Content -LiteralPath $portsFile -Raw -Encoding UTF8 | ConvertFrom-Json).consolePort }
    $ready = $false
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
      try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1
        if ($health.success -and $health.data.service -eq '88frp-node-web') { $ready = $true; break }
      } catch { }
      Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'The SYSTEM backend did not become ready. See backend-host.log and data/app.log.' }
    if ($Mode -eq 'Install') { $folder.GetTask('88FRP Desktop').Run($null) | Out-Null }
  }
  exit 0
} catch {
  try { [IO.File]::AppendAllText((Join-Path $DataRoot 'startup-config.log'), (Get-Date -Format s) + ' ' + $_.Exception.Message + [Environment]::NewLine) } catch { }
  Write-Error $_ -ErrorAction Continue
  exit 1
}
