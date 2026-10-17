const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function runFixture(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "88frp-upgrade-"));
  const runner = path.join(root, "test.ps1");
  fs.writeFileSync(runner, "\ufeff" + `
    $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
    $env:PSModulePath="$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules;$env:ProgramFiles\\WindowsPowerShell\\Modules"
    $ast=[Management.Automation.Language.Parser]::ParseFile($env:STARTUP_SCRIPT,[ref]$null,[ref]$null)
    foreach($f in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){ . ([scriptblock]::Create($f.Extent.Text)) }
    . $env:UPGRADE_MODULE
    $root=$env:UPGRADE_TEST_ROOT
    $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    ${script}
  `);
  try {
    return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner], {
      encoding: "utf8", windowsHide: true, timeout: 30000,
      env: { ...process.env, UPGRADE_TEST_ROOT: root,
        STARTUP_SCRIPT: path.join(__dirname, "../scripts/configure-startup.ps1"),
        UPGRADE_MODULE: path.join(__dirname, "../scripts/windows-upgrade.ps1") },
    }));
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("旧服务升级识别真实数据，先禁用再停止，失败恢复，成功清理且不碰其他服务", { skip: process.platform !== "win32" }, () => {
  const r = runFixture(`
    $app=Join-Path $root 'installed'; $env:ProgramData=Join-Path $root 'programdata'
    $actual=Join-Path $env:ProgramData '88frp-node'; $empty=Join-Path $root 'profile\\88frp-node'
    $instance=Join-Path $actual 'data\\instances\\one'
    foreach($dir in @($app,$instance,$empty)){[IO.Directory]::CreateDirectory($dir)|Out-Null}
    [IO.File]::WriteAllText((Join-Path $empty 'native-client-theme.txt'),'dark')
    [IO.File]::WriteAllText((Join-Path $app '88frp-service.exe'),'old-wrapper')
    [IO.File]::WriteAllText((Join-Path $instance 'frpc.toml'),'serverAddr="192.0.2.1"')
    [IO.File]::WriteAllText((Join-Path $instance 'selection.json'),'{"keep":true,"new":false}')
    [IO.File]::WriteAllText((Join-Path $instance 'runtime.json'),'{"status":"running","resumeOnBackendStart":false}')
    $script:services=@(
      [pscustomobject]@{Name='88FRP';PathName=('"'+(Join-Path $app '88frp-service.exe')+'"');State='Running';StartMode='Auto'},
      [pscustomobject]@{Name='88frp-other';PathName=(Join-Path $root 'unrelated\\88frp-service.exe');State='Running';StartMode='Auto'}
    )
    $script:actions=@(); $script:failShutdown=$false
    function Get-ItemProperty {param($LiteralPath,$ErrorAction) return $null}
    function Get-CimInstance {param($ClassName,$Filter) if($ClassName -eq 'Win32_Service'){return $script:services};return @()}
    function Set-Service {param($Name,$StartupType) $s=$script:services|Where-Object Name -eq $Name; $s.StartMode=$(if($StartupType -eq 'Automatic'){'Auto'}else{$StartupType});$script:actions+=($Name+':'+$StartupType)}
    function Stop-Service {param($Name,[switch]$Force) ($script:services|Where-Object Name -eq $Name).State='Stopped';$script:actions+=($Name+':stop')}
    function Start-Service {param($Name) ($script:services|Where-Object Name -eq $Name).State='Running'}
    function Get-Service {param($Name) $s=$script:services|Where-Object Name -eq $Name; $o=[pscustomobject]@{Status=$s.State};$o|Add-Member ScriptMethod WaitForStatus {param($state,$timeout) if($this.Status -ne $state){throw 'Stop failed'}};return $o}
    function Stop-BackendForUpgrade {param($Root,$ExpectedProcessIds) $script:actions+='graceful';if($script:failShutdown){throw 'Backend refused shutdown'}}
    function Invoke-CimMethod {param($InputObject,$MethodName) $script:services=@($script:services|Where-Object Name -ne $InputObject.Name);return @{ReturnValue=0}}
    $journal=Join-Path $root 'transaction.json'
    $state=Prepare-88Upgrade $app $empty $owner $journal
    Copy-88UpgradeUiPreferences $state
    $theme=([IO.File]::ReadAllText((Join-Path $actual 'native-client-theme.txt')) -eq 'dark') -and (Test-Path -LiteralPath (Join-Path $state.backup 'previous-profile-ui\\native-client-theme.txt'))
    $selected=([IO.File]::ReadAllText((Join-Path $state.backup 'data\\instances\\one\\selection.json')) -eq '{"keep":true,"new":false}')
    $order=($script:actions[0] -eq '88FRP:Disabled' -and $script:actions[1] -eq 'graceful' -and $script:actions[2] -eq '88FRP:stop')
    $resume=([IO.File]::ReadAllText((Join-Path $instance 'runtime.json'))|ConvertFrom-Json).resumeOnBackendStart
    Restore-88Upgrade $journal
    $restored=($script:services[0].State -eq 'Running' -and $script:services[0].StartMode -eq 'Auto')
    $script:failShutdown=$true; $failed=$false
    try {Prepare-88Upgrade $app $empty $owner $journal|Out-Null}catch{$failed=$true;Restore-88Upgrade $journal}
    $failureRestored=($script:services[0].State -eq 'Running' -and $script:services[0].StartMode -eq 'Auto')
    $script:failShutdown=$false
    $state=Prepare-88Upgrade $app $empty $owner $journal
    Complete-88Upgrade $journal
    $final=Get-Content -LiteralPath $journal -Raw|ConvertFrom-Json
    @{correctRoot=($state.dataRoot -eq $actual);themePreserved=$theme;selectionPreserved=$selected;order=$order;resumePreserved=$resume;
      rollbackRestored=$restored;failureDetected=$failed;failureRestored=$failureRestored;
      committed=$final.committed;oldServiceRemoved=(@($script:services|Where-Object Name -eq '88FRP').Count -eq 0);
      unrelatedPreserved=($script:services[0].Name -eq '88frp-other' -and $script:services[0].State -eq 'Running' -and $script:services[0].StartMode -eq 'Auto');
      wrapperArchived=(Test-Path -LiteralPath (Join-Path $state.backup 'retired-service\\88frp-service.exe'));
      wrapperRetired=(!(Test-Path -LiteralPath (Join-Path $app '88frp-service.exe')))}|ConvertTo-Json -Compress
  `);
  for (const [key, value] of Object.entries(r)) assert.equal(value, true, key);
});

test("两个目录都有历史实例时停止升级，不把旧数据覆盖或合并", { skip: process.platform !== "win32" }, () => {
  const r = runFixture(`
    $env:ProgramData=Join-Path $root 'programdata';$saved=Join-Path $root 'saved';$legacy=Join-Path $env:ProgramData '88frp-node'
    foreach($r in @($saved,$legacy)){$dir=Join-Path $r 'data\\instances\\one';[IO.Directory]::CreateDirectory($dir)|Out-Null;[IO.File]::WriteAllText((Join-Path $dir 'frpc.toml'),'keep-original')}
    $svc=[pscustomobject]@{PathName=(Join-Path $root 'missing-service.exe')}
    $blocked=$false;try{Resolve-88UpgradeDataRoot $saved @($svc)|Out-Null}catch{$blocked=$_.Exception.Message -like '*Both*'}
    @{blocked=$blocked;savedPreserved=([IO.File]::ReadAllText((Join-Path $saved 'data\\instances\\one\\frpc.toml')) -eq 'keep-original');legacyPreserved=([IO.File]::ReadAllText((Join-Path $legacy 'data\\instances\\one\\frpc.toml')) -eq 'keep-original')}|ConvertTo-Json -Compress
  `);
  assert.deepEqual(r, { blocked: true, savedPreserved: true, legacyPreserved: true });
});

test("安装预检真正检测只读和文件占用，检查失败时不替换文件", { skip: process.platform !== "win32" }, () => {
  const r = runFixture(`
    $app=Join-Path $root 'app';[IO.Directory]::CreateDirectory($app)|Out-Null
    $file=Join-Path $app '88frp-web.exe';[IO.File]::WriteAllText($file,'original-app')
    $normal=$true;try{Test-88UpgradeFiles $app}catch{$normal=$false}
    [IO.File]::SetAttributes($file,[IO.FileAttributes]::ReadOnly)
    $readonly=$false;try{Test-88UpgradeFiles $app}catch{$readonly=$_.Exception.Message -like '*read-only*'}finally{[IO.File]::SetAttributes($file,[IO.FileAttributes]::Normal)}
    $lock=[IO.File]::Open($file,'Open','ReadWrite','None')
    $locked=$false;try{Test-88UpgradeFiles $app}catch{$locked=$_.Exception.Message -like '*Windows error 32*'}finally{$lock.Dispose()}
    @{normal=$normal;readonlyBlocked=$readonly;lockBlocked=$locked;originalPreserved=([IO.File]::ReadAllText($file) -eq 'original-app');noProbeRemains=(@(Get-ChildItem -LiteralPath $app -Filter '88frp-write-test-*').Count -eq 0)}|ConvertTo-Json -Compress
  `);
  for (const [key, value] of Object.entries(r)) assert.equal(value, true, key);
});

test("未勾选开机启动时也验证本次后台，但保持任务禁用状态", { skip: process.platform !== "win32" }, () => {
  const r = runFixture(`
    $task=[pscustomobject]@{Enabled=$false;Runs=0}
    $task|Add-Member ScriptMethod Run {param($argument) if(-not $this.Enabled){throw 'Task is disabled'};$this.Runs++}
    $folder=[pscustomobject]@{Task=$task}
    $folder|Add-Member ScriptMethod GetTask {param($name) return $this.Task}
    Start-88BackendTask $folder $false
    @{launchedOnce=($task.Runs -eq 1);startupRemainsDisabled=(-not $task.Enabled)}|ConvertTo-Json -Compress
  `);
  assert.deepEqual(r, { launchedOnce: true, startupRemainsDisabled: true });
});
