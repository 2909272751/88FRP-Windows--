param([Parameter(Mandatory=$true)][string]$DataRoot, [Parameter(Mandatory=$true)][int]$Port, [switch]$NoLaunch)
$ErrorActionPreference='Stop'
$projectRoot=Resolve-Path (Join-Path $PSScriptRoot '..')
$previewDir=Join-Path $DataRoot 'native-preview'
[IO.Directory]::CreateDirectory($previewDir) | Out-Null
[IO.File]::WriteAllText((Join-Path $previewDir 'machine-config.json'),(@{dataRoot=$DataRoot} | ConvertTo-Json))
[IO.File]::WriteAllText((Join-Path $DataRoot 'native-client-service-ports.json'),(@{consolePort=$Port} | ConvertTo-Json))
Copy-Item -LiteralPath (Join-Path $projectRoot 'assets\88frp-logo.png') -Destination $previewDir -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'assets\88frp-logo.ico') -Destination $previewDir -Force
$previewManifest=Join-Path $previewDir 'preview.manifest'
[IO.File]::WriteAllText($previewManifest,'<?xml version="1.0" encoding="utf-8"?><assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1"><assemblyIdentity version="1.0.0.0" name="88FRP.NativeClient.preview"/><trustInfo xmlns="urn:schemas-microsoft-com:asm.v2"><security><requestedPrivileges xmlns="urn:schemas-microsoft-com:asm.v3"><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>')
$framework=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$arguments=@('/nologo','/target:winexe','/platform:x64','/codepage:65001','/main:NativeUiPreview',('/win32manifest:'+$previewManifest),('/out:'+(Join-Path $previewDir '88FRP-Preview.exe')))
foreach($assembly in @('System.dll','System.Core.dll','Microsoft.CSharp.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','System.Xaml.dll')) { $arguments+=('/reference:'+$assembly) }
foreach($assembly in @('WindowsBase','PresentationCore','PresentationFramework')) { $arguments+=('/reference:'+(Join-Path $framework ('WPF\'+$assembly+'.dll'))) }
foreach($file in @('WpfClient.cs','GatewayWorkspace.cs','DomainTab.cs','ConsoleSecurityWindow.cs','ClientThemePalette.cs','ClientUiStyles.cs')) { $arguments+=(Join-Path $projectRoot ('src\windows-launcher\'+$file)) }
$arguments+=(Join-Path $PSScriptRoot 'native-ui-preview.cs')
& (Join-Path $framework 'csc.exe') $arguments
if($LASTEXITCODE -ne 0) { throw 'Preview compilation failed' }
# This is an interactive design preview, not a background service.
if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $previewDir '88FRP-Preview.exe') -ArgumentList @($Port) -WindowStyle Normal }
Write-Output ('Preview: '+$previewDir)
