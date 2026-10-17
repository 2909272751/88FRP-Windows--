const { Store } = require("./store");
const { ProcessManager } = require("./process-manager");
const { InstanceService } = require("./instance-service");
const { RuntimeService } = require("./runtime-service");
const { SyncService } = require("./sync-service");
const { TunnelService } = require("./tunnel-service");
const { FrpAccountService } = require("./frp-account-service");
const { AccessCenterService } = require("./access-center-service");
const { ConsoleAuthService } = require("./console-auth-service");
const { DomainBindingService } = require("./domain-binding-service");
const { WindowsCredentialStore } = require("./windows-credential-store");
const {
  DEFAULT_DATA_DIR,
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
  const overrides = {};
  if (process.env.AUTO_SYNC_INTERVAL_MS !== undefined) overrides.autoSyncIntervalMs = Number(process.env.AUTO_SYNC_INTERVAL_MS);
  if (process.env.INSTANCE_AUTO_START_ON_BOOT !== undefined) overrides.instanceAutoStartOnBoot = process.env.INSTANCE_AUTO_START_ON_BOOT !== "0";
  const settings = Object.keys(overrides).length ? await store.saveSettings(overrides) : await store.getSettings();

  const tunnelService = new TunnelService({ store });
  const credentialStore = options.credentialStore || new WindowsCredentialStore();
  const frpcBinaryPath = options.frpcBinaryPath || process.env.FRPC_BINARY_PATH || getDefaultFrpcBinaryPath();
  const frpAccountService = new FrpAccountService({ store, credentialStore });

  const processManager = new ProcessManager({
    store,
    logger,
    frpcBinaryPath,
    prepareConfigPath: (instanceId) => tunnelService.prepareRuntimeConfig(instanceId),
  });

  const runtimeService = new RuntimeService({
    store,
    processManager,
    logger,
  });

  const consoleAuthService = new ConsoleAuthService({ store, credentialStore });
  const domainBindingService = new DomainBindingService({
    store,
    instanceService: new InstanceService({ store }),
    tunnelService,
    credentialStore,
    logger,
  });
  const accessCenterService = new AccessCenterService({
    store, tunnelService, credentialStore, logger, frpcBinaryPath, domainBindingService,
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
    accessCenterService,
    consoleAuthService,
    domainBindingService,
  };
}

module.exports = {
  createAppContext,
};
