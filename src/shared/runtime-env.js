const os = require("os");
const path = require("path");

const APP_SLUG = "88frp-node";

function getSeaModule() {
  try {
    return require("node:sea");
  } catch {
    return null;
  }
}

function isSeaRuntime() {
  const sea = getSeaModule();
  return Boolean(sea && typeof sea.isSea === "function" && sea.isSea());
}

function getArchDir() {
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    case "arm":
      return "arm";
    default:
      return process.arch;
  }
}

function getDefaultFrpcBinaryName() {
  return process.platform === "win32" ? "88frpc.exe" : "88frpc";
}

function getSourceProjectRoot() {
  return path.resolve(__dirname, "..", "..");
}

function getWritableBaseParentDir() {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  }

  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

function getAppBaseDir() {
  return process.env.APP_BASE_DIR || path.join(getWritableBaseParentDir(), APP_SLUG);
}

function getRuntimeRoot() {
  return process.env.APP_RUNTIME_DIR || path.join(getAppBaseDir(), "runtime");
}

function getProjectRoot() {
  return isSeaRuntime() ? getAppBaseDir() : getSourceProjectRoot();
}

function getDefaultDataDir() {
  return path.join(getAppBaseDir(), "data");
}

function getSourcePublicDir() {
  return path.join(getSourceProjectRoot(), "src", "web", "public");
}

function getRuntimePublicDir() {
  return path.join(getRuntimeRoot(), "public");
}

function getPublicDir() {
  return isSeaRuntime() ? getRuntimePublicDir() : getSourcePublicDir();
}

function getSourceFrpcBinaryPath() {
  return path.join(getSourceProjectRoot(), "bin", getArchDir(), getDefaultFrpcBinaryName());
}

function getRuntimeFrpcBinaryPath() {
  return path.join(getRuntimeRoot(), "bin", getArchDir(), getDefaultFrpcBinaryName());
}

function getDefaultFrpcBinaryPath() {
  return isSeaRuntime() ? getRuntimeFrpcBinaryPath() : getSourceFrpcBinaryPath();
}

function getDefaultCaddyBinaryName() {
  return process.platform === "win32" ? "caddy.exe" : "caddy";
}

function getSourceCaddyBinaryPath() {
  return path.join(getSourceProjectRoot(), "bin", getArchDir(), getDefaultCaddyBinaryName());
}

function getPackagedCaddyBinaryPath() {
  return path.join(path.dirname(process.execPath), getDefaultCaddyBinaryName());
}

function getDefaultCaddyBinaryPath() {
  const candidates = [
    getPackagedCaddyBinaryPath(),
    getSourceCaddyBinaryPath(),
  ];
  for (const candidate of candidates) {
    try {
      if (require("fs").existsSync(candidate)) return candidate;
    } catch {
      // Continue to the next candidate.
    }
  }
  return candidates[candidates.length - 1];
}

module.exports = {
  APP_SLUG,
  getAppBaseDir,
  getArchDir,
  getDefaultCaddyBinaryName,
  getDefaultCaddyBinaryPath,
  getDefaultDataDir,
  getDefaultFrpcBinaryName,
  getDefaultFrpcBinaryPath,
  getPackagedCaddyBinaryPath,
  getProjectRoot,
  getPublicDir,
  getRuntimeFrpcBinaryPath,
  getRuntimePublicDir,
  getRuntimeRoot,
  getSeaModule,
  getSourceCaddyBinaryPath,
  getSourceProjectRoot,
  isSeaRuntime,
};
