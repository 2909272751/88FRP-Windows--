const { DEFAULT_AUTO_SYNC_INTERVAL_MS } = require("../shared/constants");

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const MAX_AUTO_SYNC_BACKOFF_MS = 60 * 60_000;

function normalizeAutoSyncInterval(value) {
  return Math.max(DEFAULT_AUTO_SYNC_INTERVAL_MS, Number(value) || DEFAULT_AUTO_SYNC_INTERVAL_MS);
}

function parseRetryAfter(value, now = Date.now()) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

class RemoteSyncError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "RemoteSyncError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function normalizeConfigForCompare(text) {
  return String(text || "").replace(/\r\n/g, "\n").trimEnd();
}

function validateConfigText(configText) {
  const errors = [];
  const warnings = [];
  const text = String(configText || "").trim();

  if (!text) {
    errors.push("配置内容不能为空。");
  }

  if (!text.includes("[[proxies]]") && !text.includes("[common]")) {
    warnings.push("配置中未检测到常见 frpc 段落，请确认内容正确。");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

class SyncService {
  constructor({ store, runtimeService, logger, tunnelService, frpAccountService, fetchImpl = null }) {
    this.store = store;
    this.runtimeService = runtimeService;
    this.logger = logger;
    this.tunnelService = tunnelService;
    this.frpAccountService = frpAccountService;
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.syncTasks = new Map();
  }

  async saveConfig(instanceId, configText) {
    const validation = validateConfigText(configText);
    if (!validation.valid) {
      throw new Error(validation.errors.join(" "));
    }

    await this.store.saveConfig(instanceId, configText);
    if (this.tunnelService) {
      await this.tunnelService.reconcileSelection(instanceId);
    }
    await this.store.saveRuntime(instanceId, {
      ...(await this.store.getRuntime(instanceId)),
      updatedAt: new Date().toISOString(),
    });
    return validation;
  }

  async fetchRemoteConfig(instance) {
    if (!instance.remoteUrl || !instance.secretKey) {
      throw new Error("远程同步缺少 remoteUrl 或 secretKey。");
    }

    const settings = await this.store.getSettings();
    const url = instance.remoteUrl.replaceAll("{{secret}}", encodeURIComponent(instance.secretKey));
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": "88frp-node/3.0.0",
      },
      signal: AbortSignal.timeout(settings.apiTimeout),
    });

    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(
        response.headers && typeof response.headers.get === "function"
          ? response.headers.get("retry-after")
          : ""
      );
      throw new RemoteSyncError(`远程接口请求失败: HTTP ${response.status}`, {
        status: response.status,
        retryAfterMs,
      });
    }

    const configText = await response.text();
    const validation = validateConfigText(configText);
    if (!validation.valid) {
      throw new Error(validation.errors.join(" "));
    }

    return {
      configText,
      validation,
    };
  }

  async syncInstance(instanceId, options = {}) {
    if (this.syncTasks.has(instanceId)) {
      return this.syncTasks.get(instanceId);
    }

    const task = this.performSync(instanceId, options);
    this.syncTasks.set(instanceId, task);
    try {
      return await task;
    } finally {
      if (this.syncTasks.get(instanceId) === task) {
        this.syncTasks.delete(instanceId);
      }
    }
  }

  async performSync(instanceId, options = {}) {
    const instance = await this.store.getInstance(instanceId);
    if (!instance) {
      throw new Error("实例不存在。");
    }

    const currentText = await this.store.readConfig(instanceId);
    const remote = await this.fetchRemoteConfig(instance);
    const changed = normalizeConfigForCompare(currentText) !== normalizeConfigForCompare(remote.configText);

    if (!changed) {
      return {
        changed: false,
        runtimeAction: "unchanged",
        validation: remote.validation,
      };
    }

    await this.store.saveConfig(instanceId, remote.configText);
    if (this.tunnelService) {
      await this.tunnelService.reconcileSelection(instanceId);
    }
    let labelRefresh = { attempted: false, reason: "not-connected" };
    if (this.frpAccountService && this.tunnelService) {
      labelRefresh = await this.frpAccountService.refreshTunnelLabels();
      if (labelRefresh.reason === "updated") {
        await this.tunnelService.applyLabels(instanceId, labelRefresh.labels);
      } else if (labelRefresh.reason === "failed") {
        await this.logger.warn(`实例 ${instance.name} 名称同步失败: ${labelRefresh.error}`);
      }
    }

    if (!options.restartOnChange) {
      return {
        changed: true,
        runtimeAction: "saved",
        validation: remote.validation,
        labelRefresh,
      };
    }

    const runtime = await this.store.getRuntime(instanceId);
    if (runtime.pid) {
      await this.runtimeService.restart(instanceId);
      return {
        changed: true,
        runtimeAction: "restarted",
        validation: remote.validation,
        labelRefresh,
      };
    }

    await this.runtimeService.start(instanceId);
    return {
      changed: true,
      runtimeAction: "started",
      validation: remote.validation,
      labelRefresh,
    };
  }

  startAutoSyncScheduler() {
    let running = false;
    let timer = null;
    let intervalMs = DEFAULT_AUTO_SYNC_INTERVAL_MS;
    const failures = new Map();

    const tick = async () => {
      if (running) {
        return;
      }

      running = true;
      try {
        const instances = await this.store.listInstances();
        for (const instance of instances.filter((item) => item.autoSyncEnabled)) {
          const failure = failures.get(instance.id);
          if (failure && failure.retryAt > Date.now()) {
            continue;
          }
          try {
            const result = await this.syncInstance(instance.id, { restartOnChange: true });
            if (failure && this.logger.info) {
              await this.logger.info(`实例 ${instance.name} 自动同步已恢复。`);
            }
            failures.delete(instance.id);
            if (result.changed) {
              await this.logger.info(`实例 ${instance.name} 自动同步完成，动作: ${result.runtimeAction}`);
            }
          } catch (error) {
            const failureCount = (failure ? failure.count : 0) + 1;
            const exponentialDelay = Math.min(intervalMs * (2 ** (failureCount - 1)), MAX_AUTO_SYNC_BACKOFF_MS);
            const rateLimitDelay = error.status === 429 && !error.retryAfterMs ? DEFAULT_RATE_LIMIT_BACKOFF_MS : 0;
            const retryDelay = Math.min(
              Math.max(exponentialDelay, error.retryAfterMs || 0, rateLimitDelay),
              MAX_AUTO_SYNC_BACKOFF_MS
            );
            const now = Date.now();
            const shouldLog = !failure
              || failure.message !== error.message
              || now - failure.lastLoggedAt >= MAX_AUTO_SYNC_BACKOFF_MS;
            failures.set(instance.id, {
              count: failureCount,
              retryAt: now + retryDelay,
              message: error.message,
              lastLoggedAt: shouldLog ? now : failure.lastLoggedAt,
            });
            if (shouldLog && this.logger.error) {
              await this.logger.error(`实例 ${instance.name} 自动同步失败，将在约 ${Math.ceil(retryDelay / 60_000)} 分钟后重试: ${error.message}`);
            }
          }
        }
      } finally {
        running = false;
      }
    };

    const start = async () => {
      const settings = await this.store.getSettings();
      intervalMs = normalizeAutoSyncInterval(settings.autoSyncIntervalMs);
      if (timer) clearInterval(timer);
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    };

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    return {
      start,
      stop,
      tick,
    };
  }
}

module.exports = {
  RemoteSyncError,
  SyncService,
  normalizeAutoSyncInterval,
  normalizeConfigForCompare,
  parseRetryAfter,
  validateConfigText,
};
