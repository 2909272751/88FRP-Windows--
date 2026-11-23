"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { areSamePath, inspectWindowsProcess, isPidAlive } = require("../../shared/process-utils");
const { redactSensitive } = require("./gateway-model");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ManagedProcess {
  constructor({
    name,
    statusKey,
    binaryPath,
    args,
    env,
    store,
    logAppender,
    spawnImpl = spawn,
    inspectProcess = inspectWindowsProcess,
    pidAlive = isPidAlive,
    startupGraceMs = 650,
    stopTimeoutMs = 5_000,
  }) {
    this.name = name;
    this.statusKey = statusKey;
    this.binaryPath = binaryPath;
    this.args = args;
    this.env = env;
    this.store = store;
    this.logAppender = logAppender;
    this.spawnImpl = spawnImpl;
    this.inspectProcess = inspectProcess;
    this.pidAlive = pidAlive;
    this.startupGraceMs = startupGraceMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.child = null;
    this.expectedStop = false;
    this.stderrTail = "";
  }

  getStatus() {
    const runtime = this.store.readRuntime();
    const status = { ...runtime[this.statusKey] };
    if (this.child && this.pidAlive(this.child.pid)) {
      status.status = "running";
      status.pid = this.child.pid;
    }
    return status;
  }

  async start() {
    if (this.child && this.pidAlive(this.child.pid)) return this.getStatus();
    if (!this.binaryPath || !fs.existsSync(this.binaryPath)) {
      throw new Error(`未找到 ${this.name} 可执行文件：${this.binaryPath || "未配置"}`);
    }
    await this.stopStaleOwnedProcess();
    this.expectedStop = false;
    this.stderrTail = "";
    const startedAt = new Date().toISOString();
    const child = this.spawnImpl(this.binaryPath, this.args, {
      cwd: path.dirname(this.binaryPath),
      env: { ...process.env, ...(this.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const capture = (chunk) => {
      const text = redactSensitive(chunk.toString("utf8"));
      if (text.trim()) this.stderrTail = `${this.stderrTail}${text}`.slice(-4000);
      this.logAppender(text).catch(() => undefined);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.store.saveRuntime({
        [this.statusKey]: {
          status: "error",
          pid: null,
          lastStartedAt: startedAt,
          lastError: redactSensitive(error.message),
        },
      });
      this.logAppender(`[${new Date().toISOString()}] 进程启动失败: ${error.message}\n`).catch(() => undefined);
    });
    child.once("close", (code) => {
      if (this.child !== child) return;
      this.child = null;
      const unexpected = !this.expectedStop;
      const error = unexpected
        ? `进程意外退出，退出码=${code}${this.stderrTail ? `；${this.stderrTail.slice(-800)}` : ""}`
        : "";
      this.store.saveRuntime({
        [this.statusKey]: {
          status: unexpected ? "error" : "stopped",
          pid: null,
          lastExitCode: code,
          lastError: redactSensitive(error),
        },
      });
      if (unexpected) {
        this.logAppender(`[${new Date().toISOString()}] ${error}\n`).catch(() => undefined);
      }
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("error", (error) => {
        if (!settled) reject(error);
      });
      child.once("close", (code) => {
        if (!settled) reject(new Error(`${this.name} 在启动前退出，退出码=${code}`));
      });
    });
    if (this.startupGraceMs > 0) await delay(this.startupGraceMs);
    if (!this.child || !this.pidAlive(this.child.pid)) {
      throw new Error(`${this.name} 未能保持运行${this.stderrTail ? `：${this.stderrTail.slice(-1000)}` : ""}`);
    }
    const status = {
      status: "running",
      pid: this.child.pid,
      lastStartedAt: startedAt,
      lastExitCode: null,
      lastError: "",
    };
    this.store.saveRuntime({ [this.statusKey]: status });
    this.logAppender(`[${new Date().toISOString()}] ${this.name} 已启动，PID=${this.child.pid}\n`).catch(() => undefined);
    return status;
  }

  async stop({ finalStatus = "stopped" } = {}) {
    this.expectedStop = true;
    const child = this.child;
    this.child = null;
    if (child && this.pidAlive(child.pid)) {
      try { child.kill("SIGTERM"); } catch { /* The process may already be gone. */ }
      const deadline = Date.now() + this.stopTimeoutMs;
      while (Date.now() < deadline && this.pidAlive(child.pid)) await delay(100);
      if (this.pidAlive(child.pid)) {
        try { child.kill("SIGKILL"); } catch { /* Best effort. */ }
        const forceDeadline = Date.now() + 800;
        while (Date.now() < forceDeadline && this.pidAlive(child.pid)) await delay(50);
      }
    }
    await this.stopStaleOwnedProcess();
    const status = {
      status: finalStatus,
      pid: null,
      lastError: "",
    };
    this.store.saveRuntime({ [this.statusKey]: status });
    return status;
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async stopStaleOwnedProcess() {
    const runtime = this.store.readRuntime()[this.statusKey] || {};
    const pid = Number(runtime.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !this.pidAlive(pid)) return false;
    const owned = await this.isOwnedProcess(pid, runtime);
    if (!owned) {
      this.store.saveRuntime({
        [this.statusKey]: {
          ...runtime,
          status: "error",
          lastError: "检测到一个旧的后台进程，但无法确认归属；为避免影响其他程序，已停止自动启动。",
        },
      });
      throw new Error(`${this.name === "Caddy" ? "网页访问" : "IPv4 备用通道"}的后台进程无法确认归属，请先关闭旧进程后重试。`);
    }
    await this.terminatePid(pid);
    this.store.saveRuntime({
      [this.statusKey]: {
        ...runtime,
        status: "stopped",
        pid: null,
        lastError: "",
      },
    });
    return true;
  }

  async isOwnedProcess(pid, runtime) {
    if (process.platform !== "win32") {
      try {
        const executable = await fs.promises.readlink(`/proc/${pid}/exe`);
        return areSamePath(executable, this.binaryPath);
      } catch {
        return false;
      }
    }
    try {
      const info = await this.inspectProcess(pid);
      if (!info) return false;
      const processPath = info.path || info.Path || "";
      const processName = String(info.name || info.Name || "").toLowerCase();
      const expectedName = path.parse(this.binaryPath).name.toLowerCase();
      if (processName && processName !== expectedName && processName !== expectedName.replace(/\.exe$/, "")) return false;
      if (processPath) return areSamePath(processPath, this.binaryPath);
      const expectedStart = Date.parse(runtime.lastStartedAt || "");
      const actualStart = Date.parse(info.startTime || info.StartTime || "");
      return Number.isFinite(expectedStart) && Number.isFinite(actualStart) && Math.abs(expectedStart - actualStart) < 20_000;
    } catch {
      return false;
    }
  }

  async terminatePid(pid) {
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const child = this.spawnImpl("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        child.once("error", () => resolve());
        child.once("close", () => resolve());
      });
      return;
    }
    try { process.kill(pid, "SIGTERM"); } catch { /* Best effort. */ }
    const deadline = Date.now() + this.stopTimeoutMs;
    while (Date.now() < deadline && this.pidAlive(pid)) await delay(100);
    if (this.pidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Best effort. */ }
    }
  }
}

module.exports = {
  ManagedProcess,
};
