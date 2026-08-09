const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { DEFAULT_AUTO_SYNC_INTERVAL_MS, DEFAULT_REMOTE_URL } = require("../shared/constants");
const { RotatingLogWriter, readLogTail } = require("../shared/log-files");

const DEFAULT_SETTINGS = {
  defaultRemoteUrl: DEFAULT_REMOTE_URL,
  apiTimeout: 10_000,
  autoSyncIntervalMs: DEFAULT_AUTO_SYNC_INTERVAL_MS,
  instanceAutoStartOnBoot: true,
};

const DEFAULT_RUNTIME = {
  status: "stopped",
  pid: null,
  ownerPid: null,
  binaryPath: "",
  lastExitCode: null,
  lastStartedAt: "",
  lastError: "",
  recoveryPending: false,
  resumeOnBackendStart: false,
  outageSince: "",
  nextRetryAt: "",
  reconnectAttempt: 0,
  updatedAt: "",
};

const DEFAULT_ACCESS_CENTER = {
  enabled: false,
  name: "",
  serverAddr: "",
  serverPort: 0,
  remotePort: 0,
  localHost: "127.0.0.1",
  localPort: 8802,
  proxyName: "",
  publicUrl: "",
  encryptedFrpToken: "",
  linkProfiles: {},
  createdAt: "",
  updatedAt: "",
};

const DEFAULT_ACCESS_CENTER_RUNTIME = {
  status: "stopped",
  pid: null,
  ownerPid: null,
  binaryPath: "",
  lastStartedAt: "",
  lastError: "",
  recoveryPending: false,
  outageSince: "",
  nextRetryAt: "",
  reconnectAttempt: 0,
  updatedAt: "",
};

const DEFAULT_CONSOLE_AUTH = {
  username: "",
  passwordSalt: "",
  passwordIterations: 210000,
  encryptedVerifier: "",
  sessions: [],
  createdAt: "",
  updatedAt: "",
};

function normalizeInstance(instance) {
  return {
    id: instance.id,
    name: instance.name || "",
    remoteUrl: instance.remoteUrl || "",
    secretKey: instance.secretKey || "",
    autoSyncEnabled: Boolean(instance.autoSyncEnabled),
    autoStartEnabled: instance.autoStartEnabled !== false,
    createdAt: instance.createdAt || "",
    updatedAt: instance.updatedAt || "",
  };
}

class Store {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.instancesFile = path.join(dataDir, "instances.json");
    this.settingsFile = path.join(dataDir, "settings.json");
    this.appLogFile = path.join(dataDir, "app.log");
    this.frpAccountFile = path.join(dataDir, "88frp-account.json");
    this.accessCenterFile = path.join(dataDir, "access-center.json");
    this.accessCenterRuntimeFile = path.join(dataDir, "access-center-runtime.json");
    this.consoleAuthFile = path.join(dataDir, "console-auth.json");
    this.accessCenterDir = path.join(dataDir, "access-center");
    this.instancesDir = path.join(dataDir, "instances");
    this.logWriters = new Map();
  }

  async initialize() {
    await fsp.mkdir(this.instancesDir, { recursive: true });
    await this.ensureJsonFile(this.instancesFile, []);
    await this.ensureJsonFile(this.settingsFile, DEFAULT_SETTINGS);
    await this.ensureTextFile(this.appLogFile, "");
    await this.ensureJsonFile(this.frpAccountFile, {});
    await this.ensureJsonFile(this.accessCenterFile, DEFAULT_ACCESS_CENTER);
    await this.ensureJsonFile(this.accessCenterRuntimeFile, DEFAULT_ACCESS_CENTER_RUNTIME);
    await this.ensureJsonFile(this.consoleAuthFile, DEFAULT_CONSOLE_AUTH);
    await fsp.mkdir(this.accessCenterDir, { recursive: true });
  }

  async ensureJsonFile(filePath, fallbackValue) {
    try {
      await fsp.access(filePath, fs.constants.F_OK);
    } catch {
      await this.writeJson(filePath, fallbackValue);
    }
  }

  async ensureTextFile(filePath, fallbackValue) {
    try {
      await fsp.access(filePath, fs.constants.F_OK);
    } catch {
      await fsp.writeFile(filePath, fallbackValue, "utf8");
    }
  }

  async readJson(filePath, fallbackValue) {
    try {
      const raw = await fsp.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return fallbackValue;
    }
  }

  async writeJson(filePath, value) {
    await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  }

  async getSettings() {
    const data = await this.readJson(this.settingsFile, DEFAULT_SETTINGS);
    const settings = { ...DEFAULT_SETTINGS, ...data };
    settings.autoSyncIntervalMs = Math.max(
      DEFAULT_AUTO_SYNC_INTERVAL_MS,
      Number(settings.autoSyncIntervalMs) || DEFAULT_AUTO_SYNC_INTERVAL_MS
    );
    return settings;
  }

  async saveSettings(nextValue) {
    const value = { ...(await this.getSettings()), ...nextValue };
    await this.writeJson(this.settingsFile, value);
    return value;
  }

  async listInstances() {
    const items = (await this.readJson(this.instancesFile, [])).map(normalizeInstance);
    return Promise.all(
      items.map(async (instance) => ({
        ...instance,
        runtime: await this.getRuntime(instance.id),
        hasConfig: await this.fileExists(this.getConfigPath(instance.id)),
      }))
    );
  }

  async getInstance(instanceId) {
    const instances = (await this.readJson(this.instancesFile, [])).map(normalizeInstance);
    const instance = instances.find((item) => item.id === instanceId);
    if (!instance) {
      return null;
    }

    return {
      ...instance,
      runtime: await this.getRuntime(instanceId),
      configText: await this.readConfig(instanceId),
      hasConfig: await this.fileExists(this.getConfigPath(instanceId)),
    };
  }

  async createInstance(payload) {
    const items = await this.readJson(this.instancesFile, []);
    const settings = await this.getSettings();
    const now = new Date().toISOString();
    const instance = normalizeInstance({
      id: crypto.randomUUID(),
      name: String(payload.name || "").trim(),
      remoteUrl: payload.remoteUrl || settings.defaultRemoteUrl || DEFAULT_REMOTE_URL,
      secretKey: payload.secretKey || "",
      autoSyncEnabled: Boolean(payload.autoSyncEnabled),
      autoStartEnabled: payload.autoStartEnabled !== false,
      createdAt: now,
      updatedAt: now,
    });

    items.push(instance);
    await this.writeJson(this.instancesFile, items);
    await this.ensureInstanceDirectory(instance.id);
    await this.saveRuntime(instance.id, { ...DEFAULT_RUNTIME, updatedAt: now });
    await this.ensureTextFile(this.getLogPath(instance.id), "");
    return this.getInstance(instance.id);
  }

  async updateInstance(instanceId, payload) {
    const items = (await this.readJson(this.instancesFile, [])).map(normalizeInstance);
    const index = items.findIndex((item) => item.id === instanceId);
    if (index < 0) {
      return null;
    }

    const nextValue = normalizeInstance({
      ...items[index],
      ...payload,
      id: instanceId,
      updatedAt: new Date().toISOString(),
    });
    items[index] = nextValue;
    await this.writeJson(this.instancesFile, items);
    return this.getInstance(instanceId);
  }

  async deleteInstance(instanceId) {
    const items = await this.readJson(this.instancesFile, []);
    const nextItems = items.filter((item) => item.id !== instanceId);
    if (items.length === nextItems.length) {
      return false;
    }

    await this.writeJson(this.instancesFile, nextItems);
    await fsp.rm(this.getInstanceDir(instanceId), { recursive: true, force: true });
    return true;
  }

  async readConfig(instanceId) {
    try {
      return await fsp.readFile(this.getConfigPath(instanceId), "utf8");
    } catch {
      return "";
    }
  }

  async saveConfig(instanceId, configText) {
    await this.ensureInstanceDirectory(instanceId);
    await fsp.writeFile(this.getConfigPath(instanceId), String(configText || ""), "utf8");
  }

  async saveRuntimeConfig(instanceId, configText) {
    await this.ensureInstanceDirectory(instanceId);
    await fsp.writeFile(this.getRuntimeConfigPath(instanceId), String(configText || ""), "utf8");
  }

  async getTunnelSelection(instanceId) {
    return this.readJson(this.getTunnelSelectionPath(instanceId), {});
  }

  async saveTunnelSelection(instanceId, selection) {
    await this.ensureInstanceDirectory(instanceId);
    await this.writeJson(this.getTunnelSelectionPath(instanceId), selection || {});
    return selection || {};
  }

  async getTunnelGroupOverrides(instanceId) {
    const groups = await this.readJson(this.getTunnelGroupOverridesPath(instanceId), {});
    return groups && typeof groups === "object" && !Array.isArray(groups) ? groups : {};
  }

  async saveTunnelGroupOverrides(instanceId, groupOverrides) {
    await this.ensureInstanceDirectory(instanceId);
    const nextValue = groupOverrides && typeof groupOverrides === "object" && !Array.isArray(groupOverrides)
      ? groupOverrides
      : {};
    await this.writeJson(this.getTunnelGroupOverridesPath(instanceId), nextValue);
    return nextValue;
  }

  async getTunnelLabels(instanceId) {
    return this.readJson(this.getTunnelLabelsPath(instanceId), {});
  }

  async saveTunnelLabels(instanceId, labels) {
    await this.ensureInstanceDirectory(instanceId);
    await this.writeJson(this.getTunnelLabelsPath(instanceId), labels || {});
    return labels || {};
  }

  async getFrpAccount() {
    return this.readJson(this.frpAccountFile, {});
  }

  async saveFrpAccount(account) {
    await this.writeJson(this.frpAccountFile, account || {});
    return account || {};
  }

  async clearFrpAccount() {
    await this.writeJson(this.frpAccountFile, {});
  }

  async getAccessCenter() {
    const data = await this.readJson(this.accessCenterFile, DEFAULT_ACCESS_CENTER);
    const {
      passwordRequired: _legacyPasswordRequired,
      authSalt: _legacyAuthSalt,
      passwordIterations: _legacyPasswordIterations,
      encryptedAccessKey: _legacyAccessKey,
      ...current
    } = data || {};
    return {
      ...DEFAULT_ACCESS_CENTER,
      ...current,
      linkProfiles: current && typeof current.linkProfiles === "object" && current.linkProfiles ? current.linkProfiles : {},
    };
  }

  async getConsoleAuth() {
    const data = await this.readJson(this.consoleAuthFile, DEFAULT_CONSOLE_AUTH);
    return {
      ...DEFAULT_CONSOLE_AUTH,
      ...data,
      sessions: Array.isArray(data && data.sessions) ? data.sessions : [],
    };
  }

  async saveConsoleAuth(nextValue) {
    const current = await this.getConsoleAuth();
    const value = { ...current, ...nextValue, updatedAt: new Date().toISOString() };
    if (!value.createdAt) value.createdAt = value.updatedAt;
    await this.writeJson(this.consoleAuthFile, value);
    return this.getConsoleAuth();
  }

  async saveAccessCenter(nextValue) {
    const current = await this.getAccessCenter();
    const value = {
      ...current,
      ...nextValue,
      updatedAt: new Date().toISOString(),
    };
    if (!value.createdAt) value.createdAt = value.updatedAt;
    await this.writeJson(this.accessCenterFile, value);
    return this.getAccessCenter();
  }

  async getAccessCenterRuntime() {
    return {
      ...DEFAULT_ACCESS_CENTER_RUNTIME,
      ...(await this.readJson(this.accessCenterRuntimeFile, DEFAULT_ACCESS_CENTER_RUNTIME)),
    };
  }

  async saveAccessCenterRuntime(runtime) {
    const value = {
      ...DEFAULT_ACCESS_CENTER_RUNTIME,
      ...runtime,
      updatedAt: runtime.updatedAt || new Date().toISOString(),
    };
    await this.writeJson(this.accessCenterRuntimeFile, value);
    return value;
  }

  getAccessCenterConfigPath() {
    return path.join(this.accessCenterDir, "frpc.toml");
  }

  getAccessCenterLogPath() {
    return path.join(this.accessCenterDir, "runtime.log");
  }

  async getRuntime(instanceId) {
    return this.readJson(this.getRuntimePath(instanceId), DEFAULT_RUNTIME);
  }

  async saveRuntime(instanceId, runtime) {
    await this.ensureInstanceDirectory(instanceId);
    const nextValue = {
      ...DEFAULT_RUNTIME,
      ...runtime,
      updatedAt: runtime.updatedAt || new Date().toISOString(),
    };
    await this.writeJson(this.getRuntimePath(instanceId), nextValue);
    return nextValue;
  }

  async appendAppLog(message) {
    await this.getLogWriter(this.appLogFile).write(`${message}\n`);
  }

  async appendInstanceLog(instanceId, message) {
    await this.ensureInstanceDirectory(instanceId);
    await this.getLogWriter(this.getLogPath(instanceId)).write(`${message}\n`);
  }

  async readInstanceLog(instanceId, lineLimit = 200) {
    return this.readLogTail(this.getLogPath(instanceId), lineLimit);
  }

  async readLogTail(filePath, lineLimit = 200) {
    return readLogTail(filePath, lineLimit);
  }

  getLogWriter(filePath) {
    if (!this.logWriters.has(filePath)) {
      this.logWriters.set(filePath, new RotatingLogWriter(filePath));
    }
    return this.logWriters.get(filePath);
  }

  getInstanceDir(instanceId) {
    return path.join(this.instancesDir, instanceId);
  }

  getConfigPath(instanceId) {
    return path.join(this.getInstanceDir(instanceId), "frpc.toml");
  }

  getRuntimeConfigPath(instanceId) {
    return path.join(this.getInstanceDir(instanceId), "runtime-frpc.toml");
  }

  getTunnelSelectionPath(instanceId) {
    return path.join(this.getInstanceDir(instanceId), "selection.json");
  }

  getTunnelGroupOverridesPath(instanceId) {
    return path.join(this.getInstanceDir(instanceId), "tunnel-groups.json");
  }

  getTunnelLabelsPath(instanceId) {
    return path.join(this.getInstanceDir(instanceId), "tunnel-labels.json");
  }

  getRuntimePath(instanceId) {
    return path.join(this.getInstanceDir(instanceId), "runtime.json");
  }

  getLogPath(instanceId) {
    return path.join(this.getInstanceDir(instanceId), "runtime.log");
  }

  async ensureInstanceDirectory(instanceId) {
    await fsp.mkdir(this.getInstanceDir(instanceId), { recursive: true });
  }

  async fileExists(filePath) {
    try {
      await fsp.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = {
  DEFAULT_ACCESS_CENTER,
  DEFAULT_ACCESS_CENTER_RUNTIME,
  DEFAULT_CONSOLE_AUTH,
  DEFAULT_RUNTIME,
  DEFAULT_SETTINGS,
  Store,
};
