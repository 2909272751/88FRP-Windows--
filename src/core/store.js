const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { DEFAULT_REMOTE_URL } = require("../shared/constants");

const DEFAULT_SETTINGS = {
  defaultRemoteUrl: DEFAULT_REMOTE_URL,
  apiTimeout: 10_000,
  autoSyncIntervalMs: 60_000,
  instanceAutoStartOnBoot: true,
};

const DEFAULT_RUNTIME = {
  status: "stopped",
  pid: null,
  lastExitCode: null,
  lastStartedAt: "",
  lastError: "",
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
    this.instancesDir = path.join(dataDir, "instances");
  }

  async initialize() {
    await fsp.mkdir(this.instancesDir, { recursive: true });
    await this.ensureJsonFile(this.instancesFile, []);
    await this.ensureJsonFile(this.settingsFile, DEFAULT_SETTINGS);
    await this.ensureTextFile(this.appLogFile, "");
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
    return { ...DEFAULT_SETTINGS, ...data };
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
    await fsp.appendFile(this.appLogFile, `${message}\n`, "utf8");
  }

  async appendInstanceLog(instanceId, message) {
    await this.ensureInstanceDirectory(instanceId);
    await fsp.appendFile(this.getLogPath(instanceId), `${message}\n`, "utf8");
  }

  async readInstanceLog(instanceId, lineLimit = 200) {
    return this.readLogTail(this.getLogPath(instanceId), lineLimit);
  }

  async readLogTail(filePath, lineLimit = 200) {
    try {
      const raw = await fsp.readFile(filePath, "utf8");
      return raw.split(/\r?\n/).filter(Boolean).slice(-lineLimit).join("\n");
    } catch {
      return "";
    }
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
  DEFAULT_RUNTIME,
  DEFAULT_SETTINGS,
  Store,
};
