#define AppName "88FRP"
#define AppVersion "3.2.4"
#define AppPublisher "88FRP Windows"
#define AppURL "https://github.com/2909272751/88FRP-Windows--"
#define AppExeName "88FRP.exe"
#ifndef BuildDir
  #define BuildDir "..\\dist\\88FRP-Windows"
#endif

[Setup]
AppId={{E5A669AC-D974-4A47-917B-3CC5E4A3C088}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\88FRP
DefaultGroupName=88FRP
DisableWelcomePage=no
DisableDirPage=no
DisableReadyPage=no
DisableFinishedPage=no
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=88FRP-Windows-Setup-3.2.4
SetupIconFile=..\assets\88frp-logo.ico
UninstallDisplayIcon={app}\88FRP.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Stop owned Windows services and scheduled tasks before replacing files.
; The shared upgrade helper preserves the original data root, snapshots data,
; checks replacement access and restores the old startup state on failure.
CloseApplications=no
RestartApplications=no
AllowNoIcons=yes
; 单文件解压目录跟随安装位置，避免落到用户 Temp（管理员身份下可能被拒）
UsePreviousAppDir=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: unchecked
Name: "autostart"; Description: "开机自动启动 88FRP"; GroupDescription: "附加任务："

[Files]
Source: "{#BuildDir}\88FRP.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\88frp-web.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\88frp-logo.png"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\88frp-logo.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\README.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\windows-upgrade.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\configure-startup.ps1"; DestDir: "{app}"; Flags: ignoreversion; AfterInstall: ConfigureInstalledStartup

[Icons]
Name: "{group}\88FRP"; Filename: "{app}\88FRP.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\88FRP"; Filename: "{app}\88FRP.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; 清理历史遗留的旧任务名
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN ""88frp"" /F"; Flags: runhidden waituntilterminated; StatusMsg: "正在清理旧版后台任务..."; Check: LegacyTaskExists
; 安装结束启动（静默安装时也启动，否则装完服务是停的）
Filename: "{app}\88FRP.exe"; Description: "启动 88FRP"; Flags: nowait postinstall runasoriginaluser; Check: ShouldLaunchVisible
Filename: "{app}\88FRP.exe"; Flags: nowait runasoriginaluser; Check: ShouldLaunchSilent

[UninstallRun]
Filename: "{app}\88FRP.exe"; Parameters: "--uninstall"; Flags: runhidden waituntilterminated; StatusMsg: "正在安全停止 88FRP 后台服务..."; Check: AppExeExists; RunOnceId: "88FRPStopBeforeUninstall"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\88frp-node"; Check: ShouldDeleteDataDir

[Code]
var
  PreserveData: Boolean;
  StartupFailed: Boolean;
  StartupConfigured: Boolean;
  PausedEnabledTasks: TArrayOfString;
  PausedRunningTasks: TArrayOfString;
  UpgradePrepared: Boolean;

function RunAndWait(const Exe, Params: String): Integer;
var
  ResultCode: Integer;
begin
  ResultCode := -1;
  Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := ResultCode;
end;

{ 通过 schtasks 停止 + 禁用一个任务；任务不存在时返回 False }
function StopAndDisableTask(const TaskName: String): Boolean;
var
  Code: Integer;
  Scheduler, Task: Variant;
  Count: Integer;
  WasRunning: Boolean;
begin
  Result := False;
  { 先查存不存在 }
  if not Exec(ExpandConstant('{sys}\schtasks.exe'),
    '/Query /TN "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Exit;
  if Code <> 0 then
    Exit;

  try
    Scheduler := CreateOleObject('Schedule.Service');
    Scheduler.Connect();
    Task := Scheduler.GetFolder('\').GetTask(TaskName);
    WasRunning := Task.State = 4;
    if WasRunning then
    begin
      Count := GetArrayLength(PausedRunningTasks);
      SetArrayLength(PausedRunningTasks, Count + 1);
      PausedRunningTasks[Count] := TaskName;
    end;
    if Task.Enabled then
    begin
      Count := GetArrayLength(PausedEnabledTasks);
      SetArrayLength(PausedEnabledTasks, Count + 1);
      PausedEnabledTasks[Count] := TaskName;
    end;
  except
    RaiseException('无法读取旧任务状态，尚未替换任何文件：' + TaskName);
  end;

  if not Exec(ExpandConstant('{sys}\schtasks.exe'),
    '/Change /TN "' + TaskName + '" /DISABLE', '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    RaiseException('无法暂停旧版后台任务，尚未替换任何文件：' + TaskName);
  if WasRunning then
    if not Exec(ExpandConstant('{sys}\schtasks.exe'),
      '/End /TN "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
      RaiseException('无法停止旧版后台任务，尚未替换任何文件：' + TaskName);
  Result := True;
end;

function EnableTask(const TaskName: String): Boolean;
var
  Code: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\schtasks.exe'),
    '/Change /TN "' + TaskName + '" /ENABLE', '', SW_HIDE, ewWaitUntilTerminated, Code)
    and (Code = 0);
end;

procedure RestorePausedTasks;
var
  Index, Code: Integer;
begin
  for Index := 0 to GetArrayLength(PausedEnabledTasks) - 1 do
    EnableTask(PausedEnabledTasks[Index]);
  for Index := 0 to GetArrayLength(PausedRunningTasks) - 1 do
    Exec(ExpandConstant('{sys}\schtasks.exe'),
      '/Run /TN "' + PausedRunningTasks[Index] + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  SetArrayLength(PausedEnabledTasks, 0);
  SetArrayLength(PausedRunningTasks, 0);
end;

function RunUpgradeStep(const Mode: String): Boolean;
var
  Code: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\configure-startup.ps1') +
    '" -Mode ' + Mode + ' -AppDir "' + ExpandConstant('{app}') +
    '" -DataRoot "' + ExpandConstant('{localappdata}\88frp-node') +
    '" -UpgradeStatePath "' + ExpandConstant('{tmp}\88frp-upgrade-state.json') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

procedure DeinitializeSetup;
begin
  if not StartupConfigured then
  begin
    if UpgradePrepared then RunUpgradeStep('RollbackUpgrade');
    RestorePausedTasks;
  end;
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  WizardForm.StatusLabel.Caption := '正在检查旧服务、备份配置并停止旧后台...';
  WizardForm.StatusLabel.Update;

  StopAndDisableTask('88FRP Backend');
  StopAndDisableTask('88FRP Desktop');
  StopAndDisableTask('88FRP Background');
  StopAndDisableTask('88FRP (boot)');
  StopAndDisableTask('88FRP');
  StopAndDisableTask('88frp');

  ExtractTemporaryFile('windows-upgrade.ps1');
  ExtractTemporaryFile('configure-startup.ps1');
  UpgradePrepared := True;
  if not RunUpgradeStep('PrepareUpgrade') then
  begin
    RunUpgradeStep('RollbackUpgrade');
    RestorePausedTasks;
    Result := '无法安全停止旧后台或确认原数据目录，尚未替换应用文件。请查看原数据目录中的 startup-config.log。';
    Exit;
  end;
  if not RunUpgradeStep('VerifyUpgrade') then
  begin
    RunUpgradeStep('RollbackUpgrade');
    RestorePausedTasks;
    Result := '应用文件仍被占用、只读或没有替换权限，尚未替换任何应用文件。请查看原数据目录中的 startup-config.log 后重试。';
    Exit;
  end;
end;
procedure ConfigureInstalledStartup;
var
  Code: Integer;
  EnabledArg: String;
begin
  EnabledArg := '0';
  if WizardIsTaskSelected('autostart') then EnabledArg := '1';
  StartupFailed := not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\configure-startup.ps1') +
    '" -Mode Install -AppDir "' + ExpandConstant('{app}') +
    '" -DataRoot "' + ExpandConstant('{localappdata}\88frp-node') + '" -EnableStartup ' + EnabledArg +
    ' -UpgradeStatePath "' + ExpandConstant('{tmp}\88frp-upgrade-state.json') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  if not StartupFailed then StartupFailed := Code <> 0;
  StartupConfigured := not StartupFailed;
  if StartupFailed then
    Log('后台启动配置失败，已保留全部数据并使用桌面入口恢复。请检查 startup-config.log。');
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := 0;
  if StartupFailed then Result := 1;
end;

function ShouldLaunchVisible: Boolean;
begin
  Result := (not WizardSilent) and ((not WizardIsTaskSelected('autostart')) or StartupFailed);
end;

function ShouldLaunchSilent: Boolean;
begin
  Result := WizardSilent and ((not WizardIsTaskSelected('autostart')) or StartupFailed);
end;

{ ------------------------------------------------------------------ 卸载 --- }

function AppExeExists(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\88FRP.exe'));
end;

function InitializeUninstall(): Boolean;
begin
  PreserveData := True;
  if not UninstallSilent then PreserveData :=
    MsgBox(
      '保留 88FRP 数据？' + #13#10 +
      '选择“是”将保留 %LOCALAPPDATA%\88frp-node 下的实例、日志、加密账号与会话数据、' + #13#10 +
      '访问中心设置、端口与客户端界面状态，便于日后迁移或重新安装。' + #13#10 +
      '选择“否”将删除这些数据；默认保留。',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON1) = mrYes;
  Result := True;
end;

function ShouldDeleteDataDir(): Boolean;
begin
  Result := not PreserveData;
end;

function LegacyTaskExists(): Boolean;
var
  ResultCode: Integer;
begin
  Result :=
    Exec(
      ExpandConstant('{sys}\schtasks.exe'),
      '/Query /TN "88frp"',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode
    ) and (ResultCode = 0);
end;
