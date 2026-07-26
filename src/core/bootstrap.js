const { Store } = require("./store");
const { ProcessManager } = require("./process-manager");
const { InstanceService } = require("./instance-service");
const { RuntimeService } = require("./runtime-service");
const { SyncService } = require("./sync-service");
const { TunnelService } = require("./tunnel-service");
const { FrpAccountService } = require("./frp-account-service");
const { WindowsCredentialStore } = require("./windows-credential-store");
const {
  DEFAULT_AUTO_SYNC_INTERVAL_MS,
  DEFAULT_DATA_DIR,
  DEFAULT_INSTANCE_AUTO_START_ON_BOOT,
  getDefaultFrpcBinaryPath,
} = require("../shared/constants");

function createLogger(store) {
  return {
    info(message) {
      return store.appendAppLog(`[${new Date().toISOString()}] [INFO] ${message}`);
    },
    warn(message) {
      return store.appendAppLog(`[${new Date().toISOString()}] [WARN] ${message}`);
    },
    error(message) {
      return store.appendAppLog(`[${new Date().toISOString()}] [ERROR] ${message}`);
    },
  };
}

async function createAppContext(options = {}) {
  const store = new Store({
    dataDir: options.dataDir || process.env.DATA_DIR || DEFAULT_DATA_DIR,
  });
  await store.initialize();

  const logger = createLogger(store);
  const settings = await store.saveSettings({
    autoSyncIntervalMs: Number(process.env.AUTO_SYNC_INTERVAL_MS || DEFAULT_AUTO_SYNC_INTERVAL_MS),
    instanceAutoStartOnBoot:
      String(process.env.INSTANCE_AUTO_START_ON_BOOT ?? Number(DEFAULT_INSTANCE_AUTO_START_ON_BOOT ? 1 : 0)) !== "0",
  });

  const tunnelService = new TunnelService({ store });
  const frpAccountService = new FrpAccountService({ store, credentialStore: new WindowsCredentialStore() });

  const processManager = new ProcessManager({
    store,
    logger,
    frpcBinaryPath: options.frpcBinaryPath || process.env.FRPC_BINARY_PATH || getDefaultFrpcBinaryPath(),
    prepareConfigPath: (instanceId) => tunnelService.prepareRuntimeConfig(instanceId),
  });

  const runtimeService = new RuntimeService({
    store,
    processManager,
    logger,
  });

  return {
    logger,
    processManager,
    runtimeService,
    settings,
    store,
    instanceService: new InstanceService({ store }),
    syncService: new SyncService({ store, runtimeService, logger, tunnelService, frpAccountService }),
    frpAccountService,
    tunnelService,
  };
}

module.exports = {
  createAppContext,
};
