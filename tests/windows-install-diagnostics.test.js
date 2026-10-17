const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("安装诊断区分只读文件与真实共享占用，且不改动应用和配置", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "88frp-install-diagnostic-"));
  fs.writeFileSync(path.join(root, "88frp-web.exe"), "application-fixture");
  fs.writeFileSync(path.join(root, "88FRP.exe"), "read-only-fixture");
  const machine = JSON.stringify({ dataRoot: root, keep: "private-settings" });
  fs.writeFileSync(path.join(root, "machine-config.json"), machine);
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data/access-center.json"), JSON.stringify({ encryptedFrpToken: "machine:private-test-cipher", serverAddr: "private-host" }));
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `
      $ErrorActionPreference='Stop'
      $env:PSModulePath="$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules;$env:ProgramFiles\\WindowsPowerShell\\Modules"
      $file=Join-Path $env:DIAG_ROOT '88FRP.exe'
      $originalHash=(Get-FileHash -LiteralPath $file).Hash
      [IO.File]::SetAttributes($file,[IO.FileAttributes]::ReadOnly)
      try {
        & $env:DIAG_SCRIPT -AppDir $env:DIAG_ROOT -ReportPath (Join-Path $env:DIAG_ROOT 'readonly.txt') -NoUi | Out-Null
        $readonly=Get-Content -LiteralPath (Join-Path $env:DIAG_ROOT 'readonly.txt') -Raw -Encoding UTF8 | ConvertFrom-Json
        $probe=$readonly.files | Where-Object name -eq '88FRP.exe'
        $lock=[IO.File]::Open((Join-Path $env:DIAG_ROOT '88frp-web.exe'),'Open','ReadWrite','None')
        try {
          & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:DIAG_SCRIPT -AppDir $env:DIAG_ROOT -ReportPath (Join-Path $env:DIAG_ROOT 'locked.txt') -NoUi | Out-Null
          if($LASTEXITCODE -ne 0){throw 'Locked-file diagnostic failed'}
          $locked=Get-Content -LiteralPath (Join-Path $env:DIAG_ROOT 'locked.txt') -Raw -Encoding UTF8 | ConvertFrom-Json
          $lockedProbe=$locked.files | Where-Object name -eq '88frp-web.exe'
        } finally {$lock.Dispose()}
        @{readOnly=$probe.readOnly; readonlyWriteError=$probe.writeAccessError; lockedError=$lockedProbe.writeAccessError;
          lockOwnerFound=(@($locked.lockOwners | Where-Object pid -eq $PID).Count -gt 0);
          hashPreserved=((Get-FileHash -LiteralPath $file).Hash -eq $originalHash);
          readonlyPreserved=((Get-Item -LiteralPath $file -Force).IsReadOnly);
          configPreserved=(([IO.File]::ReadAllText((Join-Path $env:DIAG_ROOT 'machine-config.json')) | ConvertFrom-Json).keep -eq 'private-settings');
          credentialFormat=$locked.credentialFormat.format;
          credentialNotLeaked=(-not ([IO.File]::ReadAllText((Join-Path $env:DIAG_ROOT 'locked.txt')) -match 'private-settings|private-test-cipher|private-host'))} | ConvertTo-Json -Compress
      } finally {[IO.File]::SetAttributes($file,[IO.FileAttributes]::Normal)}
    `], { encoding: "utf8", windowsHide: true, timeout: 60000, env: {
      ...process.env, DIAG_ROOT: root,
      DIAG_SCRIPT: path.join(__dirname, "../scripts/diagnose-windows-install.ps1"),
    } });
    const result = JSON.parse(output);
    assert.equal(result.readOnly, true);
    assert.equal(result.readonlyWriteError, 5);
    assert.equal(result.lockedError, 32);
    assert.equal(result.lockOwnerFound, true);
    assert.equal(result.hashPreserved, true);
    assert.equal(result.readonlyPreserved, true);
    assert.equal(result.configPreserved, true);
    assert.equal(result.credentialFormat, "machine-dpapi");
    assert.equal(result.credentialNotLeaked, true);
    assert.equal(fs.readFileSync(path.join(root, "machine-config.json"), "utf8"), machine);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
