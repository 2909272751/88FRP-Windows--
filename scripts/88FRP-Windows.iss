#define AppName "88FRP"
#define AppVersion "2.0.2"
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
OutputBaseFilename=88FRP-Windows-Setup-2.0.2
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

[Code]
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
