const DEFAULT_AGENT_HOST = "127.0.0.1";
const DEFAULT_AGENT_PORT = 19688;
const DEFAULT_AUTO_SYNC_INTERVAL_MS = 60_000;
const DEFAULT_INSTANCE_AUTO_START_ON_BOOT = true;
const DEFAULT_REMOTE_URL = "https://auth.88frp.com/config?secret={{secret}}";
const {
  getArchDir,
  getDefaultDataDir,
  getDefaultFrpcBinaryName,
  getDefaultFrpcBinaryPath,
  getProjectRoot,
} = require("./runtime-env");

const PROJECT_ROOT = getProjectRoot();
const DEFAULT_DATA_DIR = getDefaultDataDir();

module.exports = {
  DEFAULT_AGENT_HOST,
  DEFAULT_AGENT_PORT,
  DEFAULT_AUTO_SYNC_INTERVAL_MS,
  DEFAULT_DATA_DIR,
  DEFAULT_INSTANCE_AUTO_START_ON_BOOT,
  DEFAULT_REMOTE_URL,
  PROJECT_ROOT,
  getArchDir,
  getDefaultFrpcBinaryName,
  getDefaultFrpcBinaryPath,
};
