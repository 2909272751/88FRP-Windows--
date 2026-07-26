const { spawn } = require("node:child_process");

function isWindows() {
  return process.platform === "win32";
}

async function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
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
    return runPowerShell(
      "$plain=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString -String $plain -AsPlainText -Force; ConvertFrom-SecureString -SecureString $secure",
      value
    );
  }

  async unprotect(value) {
    if (!value) return "";
    if (!isWindows()) {
      throw new Error("88FRP 账号加密仅支持 Windows 桌面端。");
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
