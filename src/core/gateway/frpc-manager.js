"use strict";

const fs = require("node:fs");
const { ManagedProcess } = require("./managed-process");

class FrpcManager {
  constructor({ store, binaryPath, logger, spawnImpl }) {
    this.store = store;
    this.binaryPath = binaryPath;
    this.logger = logger;
    this.process = new ManagedProcess({
      name: "frpc",
      statusKey: "frpc",
      binaryPath,
      args: ["-c", store.frpcConfigPath],
      env: {},
      store,
      logAppender: (text) => store.appendFrpcLog(text),
      spawnImpl,
      startupGraceMs: 900,
    });
    this.applyQueue = Promise.resolve();
  }

  getBinaryStatus() {
    return {
      path: this.binaryPath || "",
      exists: Boolean(this.binaryPath && fs.existsSync(this.binaryPath)),
    };
  }

  getStatus() {
    return {
      ...this.process.getStatus(),
      binary: this.getBinaryStatus(),
    };
  }

  async applyConfig(configText, { startIfChanged = true } = {}) {
    const task = this.applyQueue.catch(() => {}).then(async () => {
      if (!this.getBinaryStatus().exists) {
        throw new Error(`未找到 frpc 可执行文件：${this.binaryPath || "未配置"}`);
      }
      const currentText = this.store.readFrpcConfig();
      if (currentText === configText) {
        if (startIfChanged && this.process.getStatus().status !== "running") await this.process.start();
        return { changed: false };
      }
      const wasRunning = this.process.getStatus().status === "running";
      if (wasRunning) await this.process.stop();
      try {
        this.store.writeFrpcConfig(configText);
        if (startIfChanged) await this.process.start();
        await this.store.appendAudit("frpc.apply", "success", {
          changed: true,
          wasRunning,
        });
        return { changed: true };
      } catch (error) {
        if (currentText) {
          this.store.writeFrpcConfig(currentText);
          try {
            await this.process.start();
            await this.store.appendAudit("frpc.rollback", "success", {
              reason: error.message,
            });
          } catch (rollbackError) {
            await this.store.appendAudit("frpc.rollback", "failed", {
              reason: error.message,
              rollbackError: rollbackError.message,
            });
          }
        }
        await this.store.appendAudit("frpc.apply", "failed", { error: error.message });
        throw error;
      }
    });
    this.applyQueue = task.catch(() => {});
    return task;
  }

  async start() {
    if (!this.store.readFrpcConfig()) throw new Error("统一 frpc 配置尚未生成。");
    await this.process.start();
    await this.store.appendAudit("frpc.start", "success", {
      pid: this.process.getStatus().pid,
    });
    return this.getStatus();
  }

  async stop() {
    const status = await this.process.stop();
    await this.store.appendAudit("frpc.stop", "success", {});
    return status;
  }

  async restart() {
    await this.stop();
    const status = await this.start();
    await this.store.appendAudit("frpc.restart", "success", { pid: status.pid });
    return status;
  }
}

module.exports = {
  FrpcManager,
};
