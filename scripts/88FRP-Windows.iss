#define AppName "88FRP"
#define AppVersion "3.2.2"
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
OutputBaseFilename=88FRP-Windows-Setup-3.2.2
SetupIconFile=..\assets\88frp-logo.ico
UninstallDisplayIcon={app}\88FRP.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; ---------------------------------------------------------------------------
; 升级/覆盖安装的关键设置
;
; 之前的坑：88FRP 由计划任务在后台启动，不是安装程序拉起的，
; 所以 Inno 的 CloseApplications 认不出它，替换 88FRP.exe 时
; 直接报「DeleteFile 失败；错误代码 5。拒绝访问。」
;
; 这三项配合 [Code] 里的 PrepareToInstall 一起解决：
;   - CloseApplications=no：不让 Inno 自己去猜，交给我们精确处理
;   - RestartApplications=no：重启由我们在 [Run] 里显式做
;   - 安装前由 [Code] 停任务、杀进程，安装后再恢复
; ---------------------------------------------------------------------------
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

{ -------------------------------------------------------------------------
  通用适配：覆盖安装时把「正在运行」的 88FRP 全部停干净。

  为什么需要这段：
  88FRP 通常由它自己注册的计划任务在后台（Session 0）启动，
  Inno Setup 的 CloseApplications 只认「由安装程序或用户直接启动」的进程，
  对计划任务拉起的进程无能为力，结果是替换 88FRP.exe 时报
  「DeleteFile 失败；错误代码 5。拒绝访问。」，用户只能取消安装。

  这段代码在复制文件之前：
    1. 停止并禁用 88FRP 的计划任务（禁用是为了防止杀掉后又被拉起）
    2. 循环强杀 88FRP / 88frp-web / 88frpc（frpc 会自我重启，所以要重试）
    3. 清理 runtime 锁文件，避免新版起来时误判「已有实例在跑」
  安装完成后再由 RestoreAfterInstall 重新启用任务。
  ------------------------------------------------------------------------- }

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
    if Task.Enabled then
    begin
      Count := GetArrayLength(PausedEnabledTasks);
      SetArrayLength(PausedEnabledTasks, Count + 1);
      PausedEnabledTasks[Count] := TaskName;
    end;
  except
    Log('无法读取原任务启用状态：' + TaskName);
  end;

  Exec(ExpandConstant('{sys}\schtasks.exe'),
    '/Change /TN "' + TaskName + '" /DISABLE', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\schtasks.exe'),
    '/End /TN "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
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
  Index: Integer;
begin
  for Index := 0 to GetArrayLength(PausedEnabledTasks) - 1 do
    EnableTask(PausedEnabledTasks[Index]);
  SetArrayLength(PausedEnabledTasks, 0);
end;

procedure DeinitializeSetup;
begin
  if not StartupConfigured then RestorePausedTasks;
end;

{
  真正判断「还有没有这个进程」。
  taskkill 和 tasklist 的返回码都不够可靠（tasklist 找不到进程时仍返回 0），
  所以直接看 tasklist 的输出里有没有映像名。
}
function ProcessStillRunning(const ExeName: String): Boolean;
var
  Code: Integer;
  TmpFile: String;
  Content: AnsiString;
begin
  Result := False;
  TmpFile := ExpandConstant('{tmp}\probe-' + ExeName + '.txt');
  if not Exec(ExpandConstant('{sys}\cmd.exe'),
    '/C tasklist /FI "IMAGENAME eq ' + ExeName + '" /NH > "' + TmpFile + '" 2>&1',
    '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Exit;

  if LoadStringFromFile(TmpFile, Content) then
    { tasklist 输出里含有映像名就说明还在跑；「信息: 没有运行的任务」之类不含 }
    Result := Pos(Lowercase(ExeName), Lowercase(String(Content))) > 0;

  DeleteFile(TmpFile);
end;

{ 杀掉指定进程名的全部实例，重试若干轮（frpc 会自动重启一次） }
procedure KillProcessByName(const ExeName: String);
var
  Code: Integer;
  Round: Integer;
begin
  for Round := 1 to 5 do
  begin
    if not ProcessStillRunning(ExeName) then
      Exit;
    Exec(ExpandConstant('{sys}\taskkill.exe'),
      '/F /IM "' + ExeName + '" /T', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(900);
  end;
end;

{ 清理 runtime 锁：新版启动时会读它判断是否已有实例。

  坑：锁文件里存的是上一个进程的 PID。进程被强杀后锁不会自动清，
  新版启动时读到陈旧 PID 就报「88frp web backend is already running」然后退出，
  表现是「装完了但服务没起来」。

  更麻烦的是判断时机：必须在 [Run] 启动进程**之前**清，
  所以这个函数在两处调用：
    1. PrepareToInstall —— 复制文件前清一次
    2. ssPostInstall（在 [Run] 之前）—— 再清一次，防止期间又被写脏
}
procedure ClearRuntimeLock;
var
  LockPath, RuntimeDir: String;
begin
  RuntimeDir := ExpandConstant('{localappdata}\88frp-node\runtime');
  LockPath := RuntimeDir + '\web-backend.lock';
  if FileExists(LockPath) then
    DeleteFile(LockPath);

  { 顺带清掉同目录下可能残留的 pid 文件 }
  if FileExists(RuntimeDir + '\web-backend.pid') then
    DeleteFile(RuntimeDir + '\web-backend.pid');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';

  { 只有覆盖安装才需要停服务；全新安装没有进程要动 }
  if not DirExists(ExpandConstant('{app}')) then
    Exit;

  WizardForm.StatusLabel.Caption := '正在停止旧版 88FRP...';
  WizardForm.StatusLabel.Update;

  StopAndDisableTask('88FRP Backend');
  StopAndDisableTask('88FRP Desktop');
  StopAndDisableTask('88FRP Background');
  StopAndDisableTask('88FRP (boot)');
  StopAndDisableTask('88FRP');
  StopAndDisableTask('88frp');

  { The SYSTEM host can leave its backend child alive after task termination.
    Ask the backend to stop itself and preserve instance resume markers first. }
  ExtractTemporaryFile('configure-startup.ps1');
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\configure-startup.ps1') +
    '" -Mode PrepareUpgrade -AppDir "' + ExpandConstant('{app}') +
    '" -DataRoot "' + ExpandConstant('{localappdata}\88frp-node') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
  begin
    RestorePausedTasks;
    Result := '无法安全停止旧后台，尚未替换应用文件。请重试安装。';
    Exit;
  end;

  KillProcessByName('88FRP.exe');
  KillProcessByName('88frp-web.exe');
  KillProcessByName('88frpc.exe');

  if ProcessStillRunning('88FRP.exe') or ProcessStillRunning('88frp-web.exe') or ProcessStillRunning('88frpc.exe') then
  begin
    RestorePausedTasks;
    Result := '旧进程仍在运行，尚未替换应用文件。请稍后重试。';
    Exit;
  end;

  ClearRuntimeLock;
end;

procedure ConfigureInstalledStartup;
var
  Code: Integer;
  EnabledArg: String;
begin
  ClearRuntimeLock;
  EnabledArg := '0';
  if WizardIsTaskSelected('autostart') then EnabledArg := '1';
  StartupFailed := not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\configure-startup.ps1') +
    '" -Mode Install -AppDir "' + ExpandConstant('{app}') +
    '" -DataRoot "' + ExpandConstant('{localappdata}\88frp-node') + '" -EnableStartup ' + EnabledArg,
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
