param(
  [string]$AppDir = '',
  [string]$ReportPath = '',
  [switch]$NoUi
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules;$env:ProgramFiles\WindowsPowerShell\Modules"

# Read-only diagnostics: never stop processes, change ACLs/attributes, decrypt, or output credentials.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class FrpInstallProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  public static int Access(string name, uint access, bool directory) {
    using (var handle = CreateFile(name, access, 7, IntPtr.Zero, 3, directory ? 0x02000000u : 0u, IntPtr.Zero)) {
      return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
    }
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct UniqueProcess { public int Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Started; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct LockOwner {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
    public uint AppType, Status, SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  static extern int RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  static extern int RmRegisterResources(uint session, uint count, string[] files, uint appCount, IntPtr apps, uint serviceCount, IntPtr services);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] LockOwner[] owners, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  public static LockOwner[] Owners(string[] files) {
    uint session; int code=RmStartSession(out session, 0, new StringBuilder(33));
    if (code!=0) throw new System.ComponentModel.Win32Exception(code);
    try {
      code=RmRegisterResources(session, (uint)files.Length, files, 0, IntPtr.Zero, 0, IntPtr.Zero);
      if (code!=0) throw new System.ComponentModel.Win32Exception(code);
      uint needed=0, count=0, reasons=0;
      code=RmGetList(session, out needed, ref count, null, ref reasons);
      for(int retry=0; code==234 && retry<5; retry++) {
        var owners=new LockOwner[needed]; count=needed;
        code=RmGetList(session, out needed, ref count, owners, ref reasons);
        if(code==0) { Array.Resize(ref owners, (int)count); return owners; }
      }
      if(code!=0) throw new System.ComponentModel.Win32Exception(code);
      return new LockOwner[0];
    } finally { RmEndSession(session); }
  }
}
'@

if (-not $AppDir) {
  if ($NoUi) { throw 'AppDir is required in non-interactive mode.' }
  Add-Type -AssemblyName System.Windows.Forms
  $picker = New-Object Windows.Forms.FolderBrowserDialog
  $picker.Description = '请选择安装报错的目录（例如 D:\88FRP），不要选择数据目录。'
  $picker.ShowNewFolderButton = $false
  if (Test-Path -LiteralPath 'D:\88FRP') { $picker.SelectedPath = 'D:\88FRP' }
  elseif (Test-Path -LiteralPath (Join-Path $env:ProgramFiles '88FRP')) { $picker.SelectedPath = Join-Path $env:ProgramFiles '88FRP' }
  try {
    if ($picker.ShowDialog() -ne 'OK') { exit 0 }
    $AppDir = $picker.SelectedPath
  } finally { $picker.Dispose() }
}
$AppDir = [IO.Path]::GetFullPath($AppDir)
if (-not (Test-Path -LiteralPath $AppDir -PathType Container)) { throw 'Selected installation directory does not exist.' }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$warnings = New-Object 'Collections.Generic.List[string]'
$files = @()
foreach ($name in @('88FRP.exe', '88frp-web.exe', 'configure-startup.ps1')) {
  $file = Join-Path $AppDir $name
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { $files += [pscustomobject]@{name=$name; exists=$false}; continue }
  $item = Get-Item -LiteralPath $file -Force
  $acl = $null
  try { $acl = Get-Acl -LiteralPath $file } catch { $warnings.Add('File ACL could not be read: ' + $name) }
  $files += [pscustomobject]@{
    name=$name; exists=$true; version=$item.VersionInfo.FileVersion
    attributes=[string]$item.Attributes; readOnly=$item.IsReadOnly
    writeAccessError=[FrpInstallProbe]::Access($file, 0x40000000, $false)
    deleteAccessError=[FrpInstallProbe]::Access($file, 0x00010000, $false)
    owner=$(if($acl){$acl.Owner}); sddl=$(if($acl){$acl.Sddl})
    sha256=$(try{(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash}catch{'unavailable'})
  }
}
if (-not @($files | Where-Object exists).Count) { throw 'No 88FRP application files were found in the selected directory.' }
$owners = @()
$targets = @($files | Where-Object exists | ForEach-Object { Join-Path $AppDir $_.name })
try {
  $owners = @([FrpInstallProbe]::Owners([string[]]$targets) | ForEach-Object {
    [pscustomobject]@{pid=$_.Process.Pid; app=$_.AppName; service=$_.ServiceName; session=$_.SessionId}
  })
} catch { $warnings.Add('Restart Manager query failed: ' + $_.Exception.Message) }
$processes = @()
try {
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='88FRP.exe' OR Name='88frp-web.exe' OR Name='88frpc.exe'" | ForEach-Object {
    [pscustomobject]@{name=$_.Name; pid=$_.ProcessId; parent=$_.ParentProcessId; session=$_.SessionId; executable=$_.ExecutablePath}
  })
} catch { $warnings.Add('Process query failed: ' + $_.Exception.Message) }
$tasks = @()
try {
  $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    $_.TaskName -in @('88FRP Backend','88FRP Desktop','88FRP Background','88FRP (boot)','88FRP','88frp')
  } | ForEach-Object {
    [pscustomobject]@{name=$_.TaskName; state=[string]$_.State; enabled=$_.Settings.Enabled; executable=@($_.Actions | ForEach-Object Execute)}
  })
} catch { $warnings.Add('Scheduled task query failed: ' + $_.Exception.Message) }
$findings = New-Object 'Collections.Generic.List[string]'
if (-not $isAdmin) { $findings.Add('当前未以管理员身份运行，SYSTEM 进程和文件权限的诊断可能不完整；请右键启动文件，选择“以管理员身份运行”。') }
if (@($files | Where-Object readOnly).Count) { $findings.Add('发现只读应用文件。只读属性会阻止覆盖安装。') }
if ($owners.Count) { $findings.Add('Windows 检测到占用应用文件的进程，详情见 lockOwners；不要直接删除这些文件。') }
if (@($files | Where-Object {$_.writeAccessError -eq 5 -or $_.deleteAccessError -eq 5}).Count) {
  $findings.Add('应用文件的写入或删除访问被拒绝。可能涉及运行中映像、文件权限或安全软件；需结合 lockOwners 和管理员身份判断。')
}
if (@($files | Where-Object {$_.writeAccessError -eq 32 -or $_.deleteAccessError -eq 32}).Count) { $findings.Add('发现文件共享冲突，文件仍被其他进程占用。') }
if (-not $findings.Count) { $findings.Add('此次只读检查未发现明确阻碍。请保留安装错误窗口及安装日志，进一步检查安装当时的拦截或占用。') }
$credential = [ordered]@{ format='not-found'; officialBackendVersion='unrecognized' }
$backend = $files | Where-Object name -eq '88frp-web.exe'
$client = $files | Where-Object name -eq '88FRP.exe'
$knownBackends = @{
  'D576AC337597251C64B6EC5E99394FDB48FAF4A4271ED9AFAFB676D5F022701B'='3.2.3'
  'E606A34B1FB44CCEEF2B6128276BF2B6A63FEFCA9163555B02228AFF5DDB79E5'='3.2.4'
  '3FB5E2B727AF3195E5F6D8219D44AB7EE67C72AB7B1F65C5421C55D24E24422F'='3.2.5'
}
if ($backend.exists -and $knownBackends.ContainsKey([string]$backend.sha256)) { $credential.officialBackendVersion=$knownBackends[[string]$backend.sha256] }
try {
  $root = Join-Path $env:LOCALAPPDATA '88frp-node'
  $machineFile = Join-Path $AppDir 'machine-config.json'
  if (Test-Path -LiteralPath $machineFile) {
    $machine = [IO.File]::ReadAllText($machineFile) | ConvertFrom-Json
    if ($machine.dataRoot) { $root = [IO.Path]::GetFullPath($machine.dataRoot) }
  }
  $accessFile = Join-Path $root 'data\access-center.json'
  if (Test-Path -LiteralPath $accessFile) {
    $encrypted = [string](([IO.File]::ReadAllText($accessFile) | ConvertFrom-Json).encryptedFrpToken)
    # Classify locally; neither decrypt nor include the value in reports/errors.
    if (-not $encrypted) { $credential.format='missing' }
    elseif ($encrypted.StartsWith('machine:')) { $credential.format='machine-dpapi' }
    elseif ($encrypted -match '^01000000d08c9ddf0115d1118c7a00c04fc297eb[0-9a-f]+$') { $credential.format='legacy-securestring-hex' }
    elseif ($encrypted -match '^AQAAANCMnd8BFdERjHoAwE/Cl\+s') { $credential.format='legacy-dpapi-base64' }
    else { $credential.format='unrecognized' }
    $encrypted=$null
  }
} catch { $warnings.Add('Credential format could not be classified; no credential value was included.') }
if ($client.version -and $credential.officialBackendVersion -ne 'unrecognized' -and -not $client.version.StartsWith($credential.officialBackendVersion+'.')) {
  $findings.Add('桌面与后台的已知官方版本不一致，需排查更新不完整。')
}
$report = [ordered]@{
  title='88FRP 安装只读诊断'; time=(Get-Date -Format o); appDir=$AppDir; administrator=$isAdmin
  scope='仅检查应用文件、占用进程、任务和凭据格式；未停止进程、改权限、删除文件、解密或输出账号/Token。'
  findings=@($findings.ToArray()); credentialFormat=$credential; files=$files; lockOwners=$owners; processes=$processes; tasks=$tasks; warnings=@($warnings.ToArray())
}
if (-not $ReportPath) { $ReportPath = Join-Path ([Environment]::GetFolderPath('Desktop')) ('88FRP-安装诊断-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt') }
$ReportPath = [IO.Path]::GetFullPath($ReportPath)
[IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($true)))
Write-Output $ReportPath
if (-not $NoUi) { Start-Process -FilePath notepad.exe -ArgumentList ('"' + $ReportPath + '"') }
