const { spawn } = require("node:child_process");
const path = require("node:path");

function isWindows() {
  return process.platform === "win32";
}

async function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); " + script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PSModulePath: [path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/Modules"), path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsPowerShell/Modules")].join(";") },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Windows 凭据处理超时，请稍后重试。")); }, 15000);
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || "Windows 凭据加密失败。"));
    });
    child.stdin.end(String(input || ""));
  });
}

class WindowsCredentialStore {
  async protect(value) {
    if (!isWindows()) {
      throw new Error("88FRP 账号加密仅支持 Windows 桌面端。");
    }
    const encrypted = await runPowerShell(
      "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'LocalMachine'))", value);
    return `machine:${encrypted}`;
  }

  async unprotect(value, { rawDpapi = false } = {}) {
    if (!value) return "";
    if (!isWindows()) {
      throw new Error("88FRP 账号加密仅支持 Windows 桌面端。");
    }
    if (value.startsWith("machine:") || rawDpapi) {
      return runPowerShell("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $e=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($e,$null,'"
        + (value.startsWith("machine:") ? "LocalMachine" : "CurrentUser") + "'))", value.replace(/^machine:/, ""));
    }
    return runPowerShell(
      "$secure=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) ; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }",
      value
    );
  }
}

module.exports = {
  WindowsCredentialStore,
};
