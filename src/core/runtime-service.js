class RuntimeService {
  constructor({ store, processManager, logger }) {
    this.store = store;
    this.processManager = processManager;
    this.logger = logger;
  }

  async getStatus(instanceId) {
    const instance = await this.store.getInstance(instanceId);
    if (!instance) {
      throw new Error("实例不存在。");
    }

    return this.store.getRuntime(instanceId);
  }

  async start(instanceId) {
    const instance = await this.store.getInstance(instanceId);
    if (!instance) {
      throw new Error("实例不存在。");
    }
    return this.processManager.start(instance);
  }

  async stop(instanceId) {
    const instance = await this.store.getInstance(instanceId);
    if (!instance) {
      throw new Error("实例不存在。");
    }
    return this.processManager.stop(instanceId);
  }

  async restart(instanceId) {
    const instance = await this.store.getInstance(instanceId);
    if (!instance) {
      throw new Error("实例不存在。");
    }
    return this.processManager.restart(instance);
  }

  async restoreOnBoot() {
    const settings = await this.store.getSettings();
    const instances = await this.store.listInstances();
    const started = [];
    for (const instance of instances) {
      const runtime = await this.store.getRuntime(instance.id);
      const resumeAfterBackendRestart = Boolean(runtime.resumeOnBackendStart);
      const startAtBoot = settings.instanceAutoStartOnBoot && instance.autoStartEnabled;
      if ((!resumeAfterBackendRestart && !startAtBoot) || !instance.hasConfig) {
        continue;
      }

      if (runtime.pid && this.processManager.checkPid(runtime.pid)) {
        continue;
      }

      try {
        await this.processManager.start(instance);
        started.push(instance.id);
      } catch (error) {
        await this.logger.error(`自动恢复实例 ${instance.name} 失败: ${error.message}`);
      }
    }
    if (!settings.instanceAutoStartOnBoot && !started.length) {
      await this.logger.info("已跳过实例自动恢复。");
    }
    return started;
  }

  async prepareForBackendShutdown({ resumeInstances = true } = {}) {
    await this.processManager.stopAll({ resume: resumeInstances });
  }
}

module.exports = {
  RuntimeService,
};
