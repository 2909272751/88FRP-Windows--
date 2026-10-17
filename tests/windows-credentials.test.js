const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { WindowsCredentialStore } = require("../src/core/windows-credential-store");

test("旧 Windows 服务的无前缀 DPAPI 凭据能直接读取，不误走 SecureString 格式", { skip: process.platform !== "win32" }, async () => {
  const value = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference='Stop'
    Add-Type -AssemblyName System.Security
    [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('legacy-raw-fixture'),$null,'LocalMachine'))
  `], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim();
  assert.equal(await new WindowsCredentialStore().unprotect(value), "legacy-raw-fixture");
});

test("升级预检通过保存端口请求正常退出，并保留隧道恢复状态", { skip: process.platform !== "win32" }, () => {
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference='Stop'
    $ast=[Management.Automation.Language.Parser]::ParseFile($env:STARTUP_SCRIPT,[ref]$null,[ref]$null)
    $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Stop-BackendForUpgrade'},$true)
    . ([scriptblock]::Create($fn.Extent.Text))
    $root=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
    [IO.Directory]::CreateDirectory($root) | Out-Null
    try {
      [IO.File]::WriteAllText((Join-Path $root 'native-client-service-ports.json'),'{"consolePort":18801}')
      $script:requests=@(); $script:healthChecks=0; $script:wrongService=$false
      function Start-Sleep { param($Milliseconds) }
      function Invoke-RestMethod {
        param($Uri,$Method,$ContentType,$Body,$Headers,$TimeoutSec,[switch]$UseBasicParsing)
        $script:requests += @{uri=$Uri; method=$Method; body=$Body; desktop=$(if($Headers){$Headers['X-88FRP-Desktop']})}
        if($Uri -like '*/api/system/shutdown') { return @{success=$true} }
        $script:healthChecks++
        if($script:wrongService) { return @{data=@{service='other'}} }
        if($script:healthChecks -gt 2) { throw 'Backend exited' }
        return @{data=@{service='88frp-node-web'}}
      }
      Stop-BackendForUpgrade $root
      $writes=@($script:requests | Where-Object {$_.method -eq 'Post'})
      $script:wrongService=$true; $rejected=$false
      try { Stop-BackendForUpgrade $root } catch { $rejected=$true }
      @{writes=$writes; checks=$script:healthChecks; otherServiceRejected=$rejected} | ConvertTo-Json -Depth 8 -Compress
    } finally { [IO.Directory]::Delete($root,$true) }
  `], { encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, STARTUP_SCRIPT: path.join(__dirname, "../scripts/configure-startup.ps1") },
  });
  const result = JSON.parse(output);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].uri, "http://127.0.0.1:18801/api/system/shutdown");
  assert.deepEqual(JSON.parse(result.writes[0].body), { stopInstances: false });
  assert.equal(result.writes[0].desktop, "1");
  assert.equal(result.otherServiceRejected, true);
  assert.equal(result.checks, 4);
});

test("Windows 旧账号和旧域名凭据可迁移为 SYSTEM 可读的本机 DPAPI，保留其他字段", { skip: process.platform !== "win32" }, async () => {
  const script = `
    $ErrorActionPreference='Stop'
    $env:PSModulePath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules;$env:ProgramFiles\\WindowsPowerShell\\Modules"
    Add-Type -AssemblyName System.Security
    $ast = [Management.Automation.Language.Parser]::ParseFile($env:STARTUP_SCRIPT,[ref]$null,[ref]$null)
    $functions = $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
    foreach($f in $functions) { . ([scriptblock]::Create($f.Extent.Text)) }
    $secure = ConvertTo-SecureString 'account-test' -AsPlainText -Force
    $account = [pscustomobject]@{ encryptedPassword = (ConvertFrom-SecureString $secure); username = 'keep'; enabled = $false }
    $raw = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('domain-test'),$null,'CurrentUser'))
    $domain = [pscustomobject]@{ encryptedToken = $raw; canWrite = $false; recordIds = @('old') }
    $legacyService = [pscustomobject]@{ encryptedFrpToken = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('legacy-service-test'),$null,'LocalMachine')); enabled=$true }
    Convert-Credentials $account $false
    Convert-Credentials $legacyService $false
    Convert-Credentials $domain $true
    $first = $domain.encryptedToken
    Convert-Credentials $domain $true
    $file=[IO.Path]::Combine([IO.Path]::GetTempPath(),[Guid]::NewGuid().ToString()+'.json')
    try {
      Save-Json $file @{ old='preserve-original' }
      Save-Json $file $domain
      $domain=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
      if((Get-Content -LiteralPath ($file+'.previous') -Raw | ConvertFrom-Json).old -ne 'preserve-original') { throw 'Original file was not preserved' }
    } finally {
      foreach($item in @($file,($file+'.previous'),($file+'.new'))) { if([IO.File]::Exists($item)) { [IO.File]::Delete($item) } }
    }
    @{ account = $account; domain = $domain; legacyService=$legacyService; idempotent = ($first -eq $domain.encryptedToken) } | ConvertTo-Json -Depth 8 -Compress
  `;
  const result = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, STARTUP_SCRIPT: path.join(__dirname, "../scripts/configure-startup.ps1") },
  }));
  const credentials = new WindowsCredentialStore();
  assert.equal(await credentials.unprotect(result.account.encryptedPassword), "account-test");
  assert.equal(await credentials.unprotect(result.domain.encryptedToken), "domain-test");
  assert.equal(await credentials.unprotect(result.legacyService.encryptedFrpToken), "legacy-service-test");
  assert.equal(result.legacyService.enabled, true);
  assert.equal(result.account.username, "keep");
  assert.equal(result.domain.canWrite, false);
  assert.deepEqual(result.domain.recordIds, ["old"]);
  assert.equal(result.idempotent, true);
});

test("免登录任务定义可由 Windows 解析，开机后台与登录桌面身份分离", { skip: process.platform !== "win32" }, () => {
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference='Stop'
    $ast = [Management.Automation.Language.Parser]::ParseFile($env:STARTUP_SCRIPT,[ref]$null,[ref]$null)
    $taskEnabled='true'; $exe='C:\\Program Files\\88FRP\\88FRP.exe'; $working='C:\\Program Files\\88FRP'
    $sidXml=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach($name in @('commonSettings','backendXml','desktopXml')) {
      $assignment=$ast.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq ('$'+$name)},$true)
      . ([scriptblock]::Create($assignment.Extent.Text))
    }
    $service=New-Object -ComObject Schedule.Service; $service.Connect()
    $backend=$service.NewTask(0); $backend.XmlText=$backendXml
    $backend.Principal.LogonType=5
    $desktop=$service.NewTask(0); $desktop.XmlText=$desktopXml
    @{ bootType=$backend.Triggers.Item(1).Type; bootDelay=$backend.Triggers.Item(1).Delay;
       principal=$backend.Principal.UserId; logonType=$backend.Principal.LogonType;
       desktopType=$desktop.Triggers.Item(1).Type; desktopUser=$desktop.Principal.UserId;
       desktopLogon=$desktop.Principal.LogonType; noTimeLimit=($backend.Settings.ExecutionTimeLimit -eq 'PT0S') } | ConvertTo-Json -Compress
  `], { encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, STARTUP_SCRIPT: path.join(__dirname, "../scripts/configure-startup.ps1") } });
  const task = JSON.parse(result);
  assert.equal(task.bootType, 8);
  assert.equal(task.bootDelay, "PT45S");
  assert.ok(["SYSTEM", "S-1-5-18"].includes(task.principal));
  assert.equal(task.logonType, 5);
  assert.equal(task.desktopType, 9);
  assert.equal(task.desktopLogon, 3);
  assert.equal(task.noTimeLimit, true);
});
