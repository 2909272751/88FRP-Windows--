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
  constructor({ store, runtimeService, logger, tunnelService, frpAccountService }) {
    this.store = store;
    this.runtimeService = runtimeService;
    this.logger = logger;
    this.tunnelService = tunnelService;
    this.frpAccountService = frpAccountService;
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
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "88frp-node/2.0.2",
      },
      signal: AbortSignal.timeout(settings.apiTimeout),
    });

    if (!response.ok) {
      throw new Error(`远程接口请求失败: HTTP ${response.status}`);
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
            failures.delete(instance.id);
            if (result.changed) {
              await this.logger.info(`实例 ${instance.name} 自动同步完成，动作: ${result.runtimeAction}`);
            }
          } catch (error) {
            const failureCount = (failure ? failure.count : 0) + 1;
            const retryDelay = Math.min(60_000 * (2 ** (failureCount - 1)), 15 * 60_000);
            failures.set(instance.id, {
              count: failureCount,
              retryAt: Date.now() + retryDelay,
            });
            await this.logger.error(`实例 ${instance.name} 自动同步失败: ${error.message}`);
          }
        }
      } finally {
        running = false;
      }
    };

    const start = async () => {
      const settings = await this.store.getSettings();
      timer = setInterval(tick, settings.autoSyncIntervalMs);
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
  SyncService,
  normalizeConfigForCompare,
  validateConfigText,
};
