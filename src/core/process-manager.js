const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class ProcessManager {
  constructor({ store, frpcBinaryPath, logger, prepareConfigPath }) {
    this.store = store;
    this.frpcBinaryPath = frpcBinaryPath;
    this.logger = logger;
    this.prepareConfigPath = prepareConfigPath;
    this.processMap = new Map();
  }

  getBinaryStatus() {
    const exists = fs.existsSync(this.frpcBinaryPath);
    let canExecute = false;

    if (exists) {
      try {
        fs.accessSync(this.frpcBinaryPath, fs.constants.X_OK);
        canExecute = true;
      } catch {
        canExecute = process.platform === "win32";
      }
    }

    return {
      path: this.frpcBinaryPath,
      exists,
      canExecute,
    };
  }

  checkPid(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async hydrateRuntimeState() {
    const instances = await this.store.listInstances();
    for (const instance of instances) {
      const runtime = await this.store.getRuntime(instance.id);
      const alive = runtime.pid ? this.checkPid(runtime.pid) : false;
      if (alive && runtime.status !== "running") {
        await this.store.saveRuntime(instance.id, {
          ...runtime,
          status: "running",
        });
      }

      if (!alive && ["running", "starting", "stopping"].includes(runtime.status)) {
        await this.store.saveRuntime(instance.id, {
          ...runtime,
          status: "error",
          pid: null,
          lastError: "检测到进程已退出或不可访问。",
        });
      }
    }
  }

  async start(instance) {
    let configPath = this.store.getConfigPath(instance.id);
    const configText = await this.store.readConfig(instance.id);
    if (!String(configText || "").trim()) {
      throw new Error("实例配置为空，请先写入 frpc.toml。");
    }

    if (this.prepareConfigPath) {
      configPath = await this.prepareConfigPath(instance.id);
    }

    const binaryStatus = this.getBinaryStatus();
    if (!binaryStatus.exists) {
      throw new Error(`未找到 frpc 可执行文件：${binaryStatus.path}`);
    }

    const runtime = await this.store.getRuntime(instance.id);
    if (runtime.pid && this.checkPid(runtime.pid)) {
      await this.stop(instance.id);
    }

    await this.store.saveRuntime(instance.id, {
      ...runtime,
      status: "starting",
      lastError: "",
    });
    await this.store.appendInstanceLog(instance.id, this.buildLogLine("INFO", `准备启动实例 ${instance.name}`));

    return new Promise((resolve, reject) => {
      const child = spawn(this.frpcBinaryPath, ["-c", configPath], {
        cwd: path.dirname(this.frpcBinaryPath),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const logStream = fs.createWriteStream(this.store.getLogPath(instance.id), { flags: "a" });
      child.stdout.on("data", (chunk) => logStream.write(chunk));
      child.stderr.on("data", (chunk) => logStream.write(chunk));

      child.once("spawn", async () => {
        this.processMap.set(instance.id, child);
        const nextRuntime = await this.store.saveRuntime(instance.id, {
          status: "running",
          pid: child.pid,
          lastExitCode: null,
          lastStartedAt: new Date().toISOString(),
          lastError: "",
        });
        await this.logger.info(`实例 ${instance.name} 已启动，PID=${child.pid}`);
        resolve(nextRuntime);
      });

      child.once("error", async (error) => {
        logStream.end();
        this.processMap.delete(instance.id);
        await this.store.saveRuntime(instance.id, {
          status: "error",
          pid: null,
          lastError: error.message,
        });
        reject(error);
      });

      child.once("close", async (code, signal) => {
        logStream.end();
        this.processMap.delete(instance.id);
        await this.store.saveRuntime(instance.id, {
          status: code === 0 ? "stopped" : "error",
          pid: null,
          lastExitCode: code,
          lastError: code === 0 ? "" : `退出码=${code}, 信号=${signal || "none"}`,
        });
      });
    });
  }

  async stop(instanceId) {
    const runtime = await this.store.getRuntime(instanceId);
    if (!runtime.pid || !this.checkPid(runtime.pid)) {
      return this.store.saveRuntime(instanceId, {
        ...runtime,
        status: "stopped",
        pid: null,
      });
    }

    await this.store.saveRuntime(instanceId, {
      ...runtime,
      status: "stopping",
    });

    const child = this.processMap.get(instanceId);
    try {
      if (child) {
        child.kill("SIGTERM");
      } else {
        process.kill(runtime.pid, "SIGTERM");
      }
    } catch (error) {
      await this.store.saveRuntime(instanceId, {
        ...runtime,
        status: "error",
        lastError: error.message,
      });
      throw error;
    }

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!this.checkPid(runtime.pid)) {
        return this.store.getRuntime(instanceId);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (this.checkPid(runtime.pid)) {
      try {
        process.kill(runtime.pid, "SIGKILL");
      } catch {
        // Ignore follow-up kill failures, runtime will be refreshed later.
      }
    }

    return this.store.getRuntime(instanceId);
  }

  async restart(instance) {
    await this.stop(instance.id);
    return this.start(instance);
  }

  buildLogLine(level, message) {
    return `[${new Date().toISOString()}] [${level}] ${message}`;
  }
}

module.exports = {
  ProcessManager,
};
