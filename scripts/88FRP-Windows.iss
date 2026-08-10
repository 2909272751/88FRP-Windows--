#define AppName "88FRP"
#define AppVersion "3.0.0"
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
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=88FRP-Windows-Setup-3.0.0
SetupIconFile=..\assets\88frp-logo.ico
UninstallDisplayIcon={app}\88FRP.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional options:"; Flags: unchecked

[Files]
Source: "{#BuildDir}\88FRP.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\88frp-web.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\88frp-logo.png"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\88frp-logo.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\README.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\88FRP"; Filename: "{app}\88FRP.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\88FRP"; Filename: "{app}\88FRP.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN ""88frp"" /F"; Flags: runhidden waituntilterminated; StatusMsg: "正在清理旧版后台任务..."; Check: LegacyTaskExists
Filename: "{app}\88FRP.exe"; Description: "Launch 88FRP"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{app}\88FRP.exe"; Parameters: "--uninstall"; Flags: runhidden waituntilterminated; StatusMsg: "正在安全停止 88FRP 后台服务..."; Check: AppExeExists; RunOnceId: "88FRPStopBeforeUninstall"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\88frp-node"; Check: ShouldDeleteDataDir

[Code]
var
  PreserveData: Boolean;

function AppExeExists(): Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\88FRP.exe'));
end;

function InitializeUninstall(): Boolean;
begin
  PreserveData :=
    MsgBox(
      '保留 88FRP 数据？' + #13#10 +
      '选择“是”将保留 %LOCALAPPDATA%\88frp-node 下的实例、日志、加密账号与会话数据、' + #13#10 +
      '访问中心设置、端口与客户端界面状态，便于日后迁移或重新安装。' + #13#10 +
      '选择“否”（默认）将删除这些数据。',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = mrYes;
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
