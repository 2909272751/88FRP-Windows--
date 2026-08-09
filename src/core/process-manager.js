const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { areSamePath, inspectWindowsProcess, isPidAlive } = require("../shared/process-utils");

const DEFAULT_RESTART_DELAYS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000];
const DEFAULT_STABLE_AFTER_MS = 60_000;
const DEFAULT_MONITOR_INTERVAL_MS = 10_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ProcessManager {
  constructor({
    store,
    frpcBinaryPath,
    logger,
    prepareConfigPath,
    spawnProcess = spawn,
    restartDelays = DEFAULT_RESTART_DELAYS,
    stableAfterMs = DEFAULT_STABLE_AFTER_MS,
    monitorIntervalMs = DEFAULT_MONITOR_INTERVAL_MS,
    pidAlive = null,
    signalProcess = process.kill.bind(process),
    processInspector = null,
  }) {
    this.store = store;
    this.frpcBinaryPath = frpcBinaryPath;
    this.logger = logger || {};
    this.prepareConfigPath = prepareConfigPath;
    this.spawnProcess = spawnProcess;
    this.restartDelays = restartDelays;
    this.stableAfterMs = stableAfterMs;
    this.monitorIntervalMs = monitorIntervalMs;
    this.pidAlive = pidAlive;
    this.signalProcess = signalProcess;
    this.processInspector = processInspector;
    this.processMap = new Map();
    this.startTasks = new Map();
    this.desiredRunning = new Set();
    this.recoveryStates = new Map();
    this.stopFinalStates = new Map();
    this.handledChildren = new WeakSet();
    this.supervisorTimer = null;
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
    return this.pidAlive ? this.pidAlive(pid) : isPidAlive(pid, this.signalProcess);
  }

  async hydrateRuntimeState() {
    const instances = await this.store.listInstances();
    for (const instance of instances) {
      const runtime = await this.store.getRuntime(instance.id);
      const alive = runtime.pid ? this.checkPid(runtime.pid) : false;
      const ownedProcess = alive
        && await this.isOwnedRuntimeProcess(instance.id, runtime.pid, runtime);
      const ownedByPreviousBackend = ownedProcess
        && runtime.ownerPid
        && runtime.ownerPid !== process.pid;

      if (ownedByPreviousBackend) {
        const stopped = await this.stopOrphanedProcess(runtime.pid);
        this.desiredRunning.add(instance.id);
        if (!stopped) {
          await this.store.saveRuntime(instance.id, {
            ...runtime,
            status: "running",
            ownerPid: process.pid,
            binaryPath: this.frpcBinaryPath,
            recoveryPending: false,
            resumeOnBackendStart: false,
            lastError: "",
          });
          if (this.logger.warn) {
            await this.logger.warn(`实例 ${instance.name} 的原进程无法由当前权限停止，已安全接管，未重复启动。`);
          }
          continue;
        }
        await this.store.saveRuntime(instance.id, {
          ...runtime,
          status: "restarting",
          pid: null,
          resumeOnBackendStart: true,
          recoveryPending: true,
          lastError: "后台核心已重启，正在重新接管隧道。",
        });
        continue;
      }

      if (ownedProcess) {
        this.desiredRunning.add(instance.id);
        if (runtime.status !== "running"
          || runtime.ownerPid !== process.pid
          || !areSamePath(runtime.binaryPath, this.frpcBinaryPath)) {
          await this.store.saveRuntime(instance.id, {
            ...runtime,
            status: "running",
            ownerPid: process.pid,
            binaryPath: this.frpcBinaryPath,
            recoveryPending: false,
            lastError: "",
          });
        }
        continue;
      }

      if (runtime.status === "stopping") {
        await this.store.saveRuntime(instance.id, {
          ...runtime,
          status: "stopped",
          pid: null,
          recoveryPending: false,
          lastError: "",
        });
      } else if (["running", "starting", "reconnecting", "restarting"].includes(runtime.status)
        || runtime.resumeOnBackendStart
        || runtime.recoveryPending) {
        this.desiredRunning.add(instance.id);
        await this.store.saveRuntime(instance.id, {
          ...runtime,
          status: "reconnecting",
          pid: null,
          recoveryPending: true,
          outageSince: runtime.outageSince || new Date().toISOString(),
          lastError: runtime.lastError || "检测到隧道进程已退出，正在自动恢复。",
        });
      }
    }
  }

  startSupervisor() {
    if (this.supervisorTimer) return;
    this.supervisorTimer = setInterval(() => {
      this.inspectSupervisedProcesses().catch(() => undefined);
    }, this.monitorIntervalMs);
    if (typeof this.supervisorTimer.unref === "function") this.supervisorTimer.unref();
    this.inspectSupervisedProcesses().catch(() => undefined);
  }

  stopSupervisor() {
    if (this.supervisorTimer) clearInterval(this.supervisorTimer);
    this.supervisorTimer = null;
    for (const instanceId of this.recoveryStates.keys()) {
      this.clearRecovery(instanceId, false);
    }
  }

  async inspectSupervisedProcesses() {
    if (!this.desiredRunning.size) return;
    const instances = await this.store.listInstances();
    const byId = new Map(instances.map((instance) => [instance.id, instance]));
    for (const instanceId of [...this.desiredRunning]) {
      const instance = byId.get(instanceId);
      if (!instance) {
        this.desiredRunning.delete(instanceId);
        this.clearRecovery(instanceId);
        continue;
      }
      const runtime = await this.store.getRuntime(instanceId);
      if (runtime.pid && this.checkPid(runtime.pid)) continue;
      const recovery = this.recoveryStates.get(instanceId);
      if (!this.startTasks.has(instanceId) && !(recovery && recovery.timer)) {
        await this.scheduleRecovery(instance, runtime.lastError || "隧道进程未运行。", runtime);
      }
    }
  }

  start(instance, options = {}) {
    if (this.startTasks.has(instance.id)) return this.startTasks.get(instance.id);
    this.desiredRunning.add(instance.id);
    if (!options.recovery) this.clearRecovery(instance.id);

    const task = this.startInternal(instance, options);
    this.startTasks.set(instance.id, task);
    return task.finally(() => {
      if (this.startTasks.get(instance.id) === task) this.startTasks.delete(instance.id);
    });
  }

  async startInternal(instance, options = {}) {
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
    if (runtime.pid && this.checkPid(runtime.pid)
      && await this.isOwnedRuntimeProcess(instance.id, runtime.pid, runtime)) {
      const adopted = await this.store.saveRuntime(instance.id, {
        ...runtime,
        status: "running",
        recoveryPending: false,
        resumeOnBackendStart: false,
        lastError: "",
      });
      this.markStable(instance.id, runtime.pid);
      return adopted;
    }

    await this.store.saveRuntime(instance.id, {
      ...runtime,
      status: options.recovery ? "reconnecting" : "starting",
      pid: null,
      lastError: options.recovery ? runtime.lastError : "",
    });
    await this.store.appendInstanceLog(instance.id, this.buildLogLine("INFO", `准备启动实例 ${instance.name}`));

    const logWriter = this.store.getLogWriter(this.store.getLogPath(instance.id));
    let child;
    try {
      child = this.spawnProcess(this.frpcBinaryPath, ["-c", configPath], {
        cwd: path.dirname(this.frpcBinaryPath),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      await logWriter.end();
      throw error;
    }

    this.processMap.set(instance.id, child);
    if (child.stdout) child.stdout.on("data", (chunk) => logWriter.write(chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => logWriter.write(chunk));

    return new Promise((resolve, reject) => {
      let spawned = false;
      let promiseSettled = false;
      let spawnTask = Promise.resolve();

      child.once("spawn", () => {
        spawned = true;
        spawnTask = (async () => {
          const nextRuntime = await this.store.saveRuntime(instance.id, {
            status: "running",
            pid: child.pid,
            ownerPid: process.pid,
            binaryPath: this.frpcBinaryPath,
            lastExitCode: null,
            lastStartedAt: new Date().toISOString(),
            lastError: "",
            recoveryPending: false,
            resumeOnBackendStart: false,
            outageSince: "",
            nextRetryAt: "",
            reconnectAttempt: 0,
          });
          this.markStable(instance.id, child.pid);
          if (this.logger.info) await this.logger.info(`实例 ${instance.name} 已启动，PID=${child.pid}`);
          return nextRuntime;
        })();
        spawnTask.then((nextRuntime) => {
          if (!promiseSettled) {
            promiseSettled = true;
            resolve(nextRuntime);
          }
        }).catch((error) => {
          if (!promiseSettled) {
            promiseSettled = true;
            reject(error);
          }
        });
      });

      child.once("error", (error) => {
        spawnTask
          .catch(() => undefined)
          .then(() => this.handleChildExit(instance, child, logWriter, null, null, error))
          .catch(() => undefined);
        if (!promiseSettled) {
          promiseSettled = true;
          reject(error);
        }
      });

      child.once("close", (code, signal) => {
        const error = code === 0 ? null : new Error(`退出码=${code}, 信号=${signal || "none"}`);
        spawnTask
          .catch(() => undefined)
          .then(() => this.handleChildExit(instance, child, logWriter, code, signal, error))
          .catch(() => undefined);
        if (!spawned && !promiseSettled) {
          promiseSettled = true;
          reject(error || new Error("FRPC 在启动前退出。"));
        }
      });
    });
  }

  async handleChildExit(instance, child, logWriter, code, signal, error) {
    if (this.handledChildren.has(child)) return;
    this.handledChildren.add(child);
    await logWriter.end();
    if (this.processMap.get(instance.id) === child) this.processMap.delete(instance.id);

    const recovery = this.recoveryStates.get(instance.id);
    if (recovery && recovery.stableTimer) {
      clearTimeout(recovery.stableTimer);
      recovery.stableTimer = null;
    }

    if (this.desiredRunning.has(instance.id)) {
      const reason = error ? error.message : `FRPC 已退出，退出码=${code}, 信号=${signal || "none"}`;
      await this.scheduleRecovery(instance, reason);
      return;
    }

    const finalState = this.stopFinalStates.get(instance.id) || { status: code === 0 ? "stopped" : "error" };
    const runtime = await this.store.getRuntime(instance.id);
    await this.store.saveRuntime(instance.id, {
      ...runtime,
      ...finalState,
      pid: null,
      lastExitCode: code,
      recoveryPending: false,
      lastError: finalState.status === "stopped" ? "" : (error ? error.message : runtime.lastError),
    });
  }

  async scheduleRecovery(instance, reason, runtimeValue = null) {
    if (!this.desiredRunning.has(instance.id)) return;
    let state = this.recoveryStates.get(instance.id);
    if (!state) {
      state = {
        attempt: 0,
        firstFailureAt: Date.now(),
        timer: null,
        stableTimer: null,
        prolongedLogged: false,
      };
      this.recoveryStates.set(instance.id, state);
    }
    if (state.timer) return;

    state.attempt += 1;
    const delayMs = this.restartDelays[Math.min(state.attempt - 1, this.restartDelays.length - 1)];
    const prolonged = Date.now() - state.firstFailureAt >= this.stableAfterMs;
    const runtime = runtimeValue || await this.store.getRuntime(instance.id);
    await this.store.saveRuntime(instance.id, {
      ...runtime,
      status: prolonged ? "error" : "reconnecting",
      pid: null,
      lastError: reason,
      recoveryPending: true,
      outageSince: runtime.outageSince || new Date(state.firstFailureAt).toISOString(),
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      reconnectAttempt: state.attempt,
    });

    if (state.attempt === 1 && this.logger.warn) {
      await this.logger.warn(`实例 ${instance.name} 连接中断，${delayMs / 1000} 秒后自动恢复：${reason}`);
    } else if (prolonged && !state.prolongedLogged && this.logger.error) {
      state.prolongedLogged = true;
      await this.logger.error(`实例 ${instance.name} 已连续恢复失败超过 ${Math.round(this.stableAfterMs / 1000)} 秒：${reason}`);
    }

    state.timer = setTimeout(async () => {
      state.timer = null;
      if (!this.desiredRunning.has(instance.id)) return;
      const current = await this.store.getInstance(instance.id);
      if (!current) {
        this.desiredRunning.delete(instance.id);
        this.clearRecovery(instance.id);
        return;
      }
      try {
        await this.start(current, { recovery: true });
      } catch (error) {
        await this.scheduleRecovery(current, error.message);
      }
    }, delayMs);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  markStable(instanceId, pid) {
    let state = this.recoveryStates.get(instanceId);
    if (!state) {
      state = { attempt: 0, firstFailureAt: 0, timer: null, stableTimer: null, prolongedLogged: false };
      this.recoveryStates.set(instanceId, state);
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.stableTimer) clearTimeout(state.stableTimer);
    state.stableTimer = setTimeout(() => {
      const runtimeProcess = this.processMap.get(instanceId);
      if ((!runtimeProcess || runtimeProcess.pid === pid) && this.checkPid(pid)) {
        this.recoveryStates.delete(instanceId);
      }
    }, this.stableAfterMs);
    if (typeof state.stableTimer.unref === "function") state.stableTimer.unref();
  }

  clearRecovery(instanceId, remove = true) {
    const state = this.recoveryStates.get(instanceId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    if (state.stableTimer) clearTimeout(state.stableTimer);
    state.timer = null;
    state.stableTimer = null;
    if (remove) this.recoveryStates.delete(instanceId);
  }

  async stop(instanceId, options = {}) {
    this.desiredRunning.delete(instanceId);
    this.clearRecovery(instanceId);
    const finalState = {
      status: options.finalStatus || "stopped",
      resumeOnBackendStart: Boolean(options.resumeOnBackendStart),
    };
    this.stopFinalStates.set(instanceId, finalState);

    const runtime = await this.store.getRuntime(instanceId);
    if (!runtime.pid || !this.checkPid(runtime.pid)) {
      const result = await this.store.saveRuntime(instanceId, {
        ...runtime,
        ...finalState,
        pid: null,
        recoveryPending: finalState.status === "restarting",
        lastError: finalState.status === "restarting" ? "后台核心重启后将自动恢复。" : "",
      });
      this.stopFinalStates.delete(instanceId);
      return result;
    }

    await this.store.saveRuntime(instanceId, {
      ...runtime,
      status: "stopping",
    });

    const child = this.processMap.get(instanceId);
    if (!child && !await this.isOwnedRuntimeProcess(instanceId, runtime.pid, runtime)) {
      const result = await this.store.saveRuntime(instanceId, {
        ...runtime,
        ...finalState,
        pid: null,
        recoveryPending: finalState.status === "restarting",
        lastError: finalState.status === "restarting" ? "后台核心重启后将自动恢复。" : "",
      });
      this.stopFinalStates.delete(instanceId);
      return result;
    }
    try {
      if (child) {
        child.kill("SIGTERM");
      } else {
        this.signalProcess(runtime.pid, "SIGTERM");
      }
    } catch (error) {
      await this.store.saveRuntime(instanceId, {
        ...runtime,
        status: "error",
        lastError: error.message,
      });
      this.stopFinalStates.delete(instanceId);
      throw error;
    }

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!this.checkPid(runtime.pid)) break;
      await delay(100);
    }

    if (this.checkPid(runtime.pid)) {
      try {
        this.signalProcess(runtime.pid, "SIGKILL");
      } catch {
        // The process may have exited between the final checks.
      }
      const forceDeadline = Date.now() + 500;
      while (Date.now() < forceDeadline && this.checkPid(runtime.pid)) await delay(50);
    }

    if (this.checkPid(runtime.pid)) {
      const latest = await this.store.getRuntime(instanceId);
      const preservingForRestart = finalState.status === "restarting";
      const message = "当前权限无法停止 FRPC 进程，已保留原进程以避免重复启动。";
      const result = await this.store.saveRuntime(instanceId, {
        ...latest,
        status: preservingForRestart ? "running" : "error",
        pid: runtime.pid,
        resumeOnBackendStart: preservingForRestart,
        recoveryPending: false,
        lastError: preservingForRestart ? "" : message,
      });
      this.stopFinalStates.delete(instanceId);
      if (!preservingForRestart) throw new Error(message);
      return result;
    }

    const latest = await this.store.getRuntime(instanceId);
    const result = await this.store.saveRuntime(instanceId, {
      ...latest,
      ...finalState,
      pid: null,
      recoveryPending: finalState.status === "restarting",
      lastError: finalState.status === "restarting" ? "后台核心重启后将自动恢复。" : "",
    });
    this.processMap.delete(instanceId);
    this.stopFinalStates.delete(instanceId);
    return result;
  }

  async stopAll(options = {}) {
    const instances = await this.store.listInstances();
    const stops = [];
    for (const instance of instances) {
      const runtime = await this.store.getRuntime(instance.id);
      const active = Boolean(runtime.pid && this.checkPid(runtime.pid))
        || this.desiredRunning.has(instance.id)
        || ["running", "starting", "reconnecting"].includes(runtime.status);
      if (!active) continue;
      stops.push(this.stop(instance.id, {
        finalStatus: options.resume ? "restarting" : "stopped",
        resumeOnBackendStart: Boolean(options.resume),
      }));
    }
    await Promise.all(stops);
  }

  async stopOrphanedProcess(pid) {
    if (!this.checkPid(pid)) return true;
    try {
      this.signalProcess(pid, "SIGTERM");
    } catch {
      return !this.checkPid(pid);
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && this.checkPid(pid)) await delay(100);
    if (this.checkPid(pid)) {
      try { this.signalProcess(pid, "SIGKILL"); } catch { /* already stopped */ }
      const forceDeadline = Date.now() + 500;
      while (Date.now() < forceDeadline && this.checkPid(pid)) await delay(50);
    }
    return !this.checkPid(pid);
  }

  async isOwnedRuntimeProcess(instanceId, pid, runtimeValue = null) {
    if (!Number.isInteger(Number(pid)) || !this.checkPid(pid)) return false;
    const child = this.processMap.get(instanceId);
    if (child && child.pid === Number(pid)) return true;
    const runtime = runtimeValue || await this.store.getRuntime(instanceId);
    if (runtime.binaryPath && !areSamePath(runtime.binaryPath, this.frpcBinaryPath)) return false;
    if (process.platform !== "win32" && !this.processInspector) {
      if (runtime.binaryPath) return true;
      try {
        return areSamePath(await fs.promises.readlink(`/proc/${Number(pid)}/exe`), this.frpcBinaryPath);
      } catch {
        return false;
      }
    }
    try {
      const info = this.processInspector
        ? await this.processInspector(Number(pid))
        : await inspectWindowsProcess(Number(pid));
      if (!info) return false;
      if (String(info.name || info.Name || "").toLowerCase() !== path.parse(this.frpcBinaryPath).name.toLowerCase()) {
        return false;
      }
      const processPath = info.path || info.Path || "";
      if (processPath && !areSamePath(processPath, this.frpcBinaryPath)) return false;
      const expectedStart = Date.parse(runtime.lastStartedAt || "");
      const actualStart = Date.parse(info.startTime || info.StartTime || "");
      return !Number.isFinite(expectedStart)
        || !Number.isFinite(actualStart)
        || Math.abs(expectedStart - actualStart) < 15_000;
    } catch {
      return false;
    }
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
  DEFAULT_MONITOR_INTERVAL_MS,
  DEFAULT_RESTART_DELAYS,
  DEFAULT_STABLE_AFTER_MS,
  ProcessManager,
};
