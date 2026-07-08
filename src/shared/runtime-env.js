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

module.exports = {
  APP_SLUG,
  getAppBaseDir,
  getArchDir,
  getDefaultDataDir,
  getDefaultFrpcBinaryName,
  getDefaultFrpcBinaryPath,
  getProjectRoot,
  getPublicDir,
  getRuntimeFrpcBinaryPath,
  getRuntimePublicDir,
  getRuntimeRoot,
  getSeaModule,
  getSourceProjectRoot,
  isSeaRuntime,
};
