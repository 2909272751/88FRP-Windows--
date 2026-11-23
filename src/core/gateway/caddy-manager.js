"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { ManagedProcess } = require("./managed-process");
const { redactSensitive } = require("./gateway-model");

function runCapture(command, args, { env, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* Best effort. */ }
      reject(new Error(`命令执行超时：${path.basename(command)}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(redactSensitive((stderr || stdout).trim() || `命令退出码=${code}`)));
    });
  });
}

async function writeCandidate(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.candidate`;
  await fsp.writeFile(temporary, String(text || ""), { encoding: "utf8", mode: 0o600, flag: "wx" });
  return temporary;
}

class CaddyManager {
  constructor({
    store,
    binaryPath,
    logger,
    spawnImpl = spawn,
    validateCommand = runCapture,
  }) {
    this.store = store;
    this.binaryPath = binaryPath;
    this.logger = logger;
    this.validateCommand = validateCommand;
    this.process = new ManagedProcess({
      name: "Caddy",
      statusKey: "caddy",
      binaryPath,
      args: ["run", "--config", store.caddyfilePath, "--adapter", "caddyfile"],
      env: {},
      store,
      logAppender: (text) => store.appendCaddyLog(text),
      spawnImpl,
      startupGraceMs: 1_200,
    });
    this.applyQueue = Promise.resolve();
    this.token = "";
  }

  getBinaryStatus() {
    return {
      path: this.binaryPath || "",
      exists: Boolean(this.binaryPath && fs.existsSync(this.binaryPath)),
    };
  }

  async getVersion() {
    if (!this.binaryPath || !fs.existsSync(this.binaryPath)) return "";
    try {
      const result = await runCapture(this.binaryPath, ["version"], { timeoutMs: 8_000 });
      return String(result.stdout || "").trim();
    } catch {
      return "";
    }
  }

  getStatus() {
    return {
      ...this.process.getStatus(),
      binary: this.getBinaryStatus(),
    };
  }

  setToken(token) {
    this.token = String(token || "");
    this.process.env = this.token ? { CF_API_TOKEN: this.token } : {};
  }

  async validateConfig(configPath) {
    if (!this.binaryPath || !fs.existsSync(this.binaryPath)) return false;
    await this.validateCommand(
      this.binaryPath,
      ["adapt", "--config", configPath, "--adapter", "caddyfile"],
      {
        env: {},
        timeoutMs: 25_000,
      }
    );
    return true;
  }

  async applyConfig(configText, { token } = {}) {
    const task = this.applyQueue.catch(() => {}).then(async () => {
      if (token !== undefined) this.setToken(token);
      const currentText = this.store.readCaddyfile();
      if (currentText === configText && this.process.getStatus().status === "running") {
        return { changed: false, started: true };
      }
      const binary = this.getBinaryStatus();
      if (!binary.exists) {
        throw new Error("未找到带 Cloudflare DNS 插件的 Caddy，请先运行构建脚本或设置 CADDY_BINARY_PATH。");
      }

      const candidate = await writeCandidate(this.store.caddyfilePath, configText);
      try {
        await this.validateConfig(candidate);
      } catch (error) {
        await this.store.appendAudit("caddy.validate", "failed", { error: error.message });
        throw new Error(`Caddy 配置校验失败：${error.message}`);
      } finally {
        await fsp.rm(candidate, { force: true }).catch(() => {});
      }

      const wasRunning = this.process.getStatus().status === "running";
      const previousText = currentText;
      if (wasRunning) await this.process.stop();
      try {
        this.store.writeCaddyfile(configText);
        await this.process.start();
        await this.store.appendAudit("caddy.apply", "success", {
          changed: true,
          wasRunning,
        });
        return { changed: true, started: true };
      } catch (error) {
        if (previousText) {
          this.store.writeCaddyfile(previousText);
          try {
            await this.process.start();
            await this.store.appendAudit("caddy.rollback", "success", {
              reason: error.message,
            });
          } catch (rollbackError) {
            await this.store.appendAudit("caddy.rollback", "failed", {
              reason: error.message,
              rollbackError: rollbackError.message,
            });
          }
        }
        await this.store.appendAudit("caddy.apply", "failed", {
          error: error.message,
        });
        throw error;
      }
    });
    this.applyQueue = task.catch(() => {});
    return task;
  }

  async start({ token } = {}) {
    if (token !== undefined) this.setToken(token);
    if (!this.store.readCaddyfile()) throw new Error("Caddy 配置尚未生成。");
    await this.process.start();
    await this.store.appendAudit("caddy.start", "success", {
      pid: this.process.getStatus().pid,
    });
    return this.getStatus();
  }

  async stop() {
    const status = await this.process.stop();
    await this.store.appendAudit("caddy.stop", "success", {});
    return status;
  }

  async restart() {
    await this.stop();
    const status = await this.start();
    await this.store.appendAudit("caddy.restart", "success", { pid: status.pid });
    return status;
  }
}

module.exports = {
  CaddyManager,
  runCapture,
};
