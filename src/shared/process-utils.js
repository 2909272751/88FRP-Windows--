const { spawn } = require("child_process");
const path = require("path");

function areSamePath(first, second, platform = process.platform) {
  if (!first || !second) return false;
  const left = path.resolve(String(first));
  const right = path.resolve(String(second));
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isPidAlive(pid, signalProcess = process.kill.bind(process)) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    signalProcess(numericPid, 0);
    return true;
  } catch (error) {
    // Windows reports EPERM for an existing process in a higher-integrity session.
    return Boolean(error && error.code === "EPERM");
  }
}

async function inspectWindowsProcess(pid, spawnProcess = spawn) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  const script = [
    `$p = Get-Process -Id ${numericPid} -ErrorAction SilentlyContinue`,
    "if ($p) {",
    "  $pathValue = $null",
    "  try { $pathValue = $p.Path } catch {}",
    "  [pscustomobject]@{ Name = $p.ProcessName; Path = $pathValue; StartTime = $p.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress",
    "}",
  ].join("; ");
  return new Promise((resolve, reject) => {
    const child = spawnProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error("无法读取进程信息。"));
      try {
        if (!output.trim()) return resolve(null);
        const info = JSON.parse(output.trim());
        resolve({
          name: info.name || info.Name || "",
          path: info.path || info.Path || "",
          startTime: info.startTime || info.StartTime || "",
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = {
  areSamePath,
  inspectWindowsProcess,
  isPidAlive,
};
