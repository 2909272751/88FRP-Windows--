const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");

const { parseFrpcServerAddr } = require("./tunnel-service");
const { RotatingLogWriter } = require("../shared/log-files");
const { areSamePath, inspectWindowsProcess, isPidAlive } = require("../shared/process-utils");
const { getPublicDir } = require("../shared/runtime-env");

const DEFAULT_RESTART_DELAYS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function escapeToml(value) {
  return JSON.stringify(String(value || ""));
}

function normalizeHost(value) {
  const host = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!host || /[\s/:?#]/.test(host)) throw new Error("FRP 服务端地址格式不正确。");
  return host;
}

function normalizePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label}必须是 1 到 65535 的端口号。`);
  return port;
}

function normalizePath(value) {
  const pathValue = String(value || "").trim();
  if (!pathValue) return "";
  if (pathValue.length > 512 || /[\r\n]/.test(pathValue)) throw new Error("访问路径格式不正确。");
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

function speedTestDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 10;
  return Math.max(3, Math.min(20, Math.round(seconds)));
}

function waitForWritable(response, endsAt) {
  if (response.writableEnded || response.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const remaining = Math.max(0, endsAt - Date.now());
    const done = () => {
      clearTimeout(timeout);
      response.off("drain", done);
      response.off("close", done);
      response.off("error", done);
      resolve();
    };
    const timeout = setTimeout(done, remaining);
    response.once("drain", done);
    response.once("close", done);
    response.once("error", done);
  });
}

function profileKey(instanceId, tunnelName) {
  return `${instanceId}:${tunnelName}`;
}

function publicEndpoint(serverAddr, remotePort) {
  if (!serverAddr) return "";
  return remotePort ? `${serverAddr}:${remotePort}` : serverAddr;
}

function inferMode(tunnel, profile) {
  if (profile && profile.mode && profile.mode !== "auto") return profile.mode;
  if (profile && profile.customUrl) return "custom";
  if (tunnel.type === "http") return "http";
  if (tunnel.type === "https") return "https";
  if (tunnel.type === "tcp") return "http";
  return "endpoint";
}

function buildLink(tunnel, serverAddr, profile = {}) {
  const type = String(tunnel.type || "").toLowerCase();
  const endpoint = publicEndpoint(serverAddr, tunnel.remotePort);
  const mode = inferMode(tunnel, profile);
  const pathValue = normalizePath(profile.path);
  const customUrl = String(profile.customUrl || "").trim();

  if (["stcp", "sudp", "xtcp"].includes(type)) {
    return {
      mode: "visitor",
      endpoint: "",
      url: "",
      canOpen: false,
      hint: "此隧道需要在访问端运行 Visitor，不能直接用浏览器打开。",
    };
  }

  if (type === "udp" || mode === "endpoint") {
    return {
      mode: "endpoint",
      endpoint,
      url: "",
      canOpen: false,
      hint: type === "udp" ? "UDP 地址不能直接在浏览器中打开。" : "复制地址后使用对应客户端连接。",
    };
  }

  if (mode === "custom") {
    if (!/^https?:\/\//i.test(customUrl)) {
      return { mode, endpoint, url: "", canOpen: false, hint: "请先填写有效的自定义访问链接。" };
    }
    return { mode, endpoint, url: customUrl, canOpen: true, hint: "" };
  }

  let host = endpoint;
  if ((type === "http" || type === "https") && tunnel.customDomains && tunnel.customDomains.length) {
    host = tunnel.customDomains[0];
  }
  if ((type === "http" || type === "https") && !host && tunnel.subdomain && serverAddr) {
    host = `${tunnel.subdomain}.${serverAddr}`;
  }
  if (!host) {
    return {
      mode,
      endpoint,
      url: "",
      canOpen: false,
      hint: "未从此实例配置读取到服务端地址，请在链接设置中填写自定义访问链接。",
    };
  }
  return {
    mode,
    endpoint,
    url: `${mode === "https" ? "https" : "http"}://${host}${pathValue}`,
    canOpen: true,
    hint: "",
  };
}

class AccessCenterService {
  constructor({
    store,
    tunnelService,
    credentialStore,
    logger,
    frpcBinaryPath,
    spawnProcess = spawn,
    restartDelays = DEFAULT_RESTART_DELAYS,
    stableAfterMs = 60_000,
    monitorIntervalMs = 10_000,
    startupProbeMs = 900,
    processInspector = null,
    pidAlive = null,
    signalProcess = process.kill.bind(process),
  }) {
    this.store = store;
    this.tunnelService = tunnelService;
    this.credentialStore = credentialStore;
    this.logger = logger;
    this.frpcBinaryPath = frpcBinaryPath;
    this.spawnProcess = spawnProcess;
    this.restartDelays = restartDelays;
    this.stableAfterMs = stableAfterMs;
    this.monitorIntervalMs = monitorIntervalMs;
    this.startupProbeMs = startupProbeMs;
    this.processInspector = processInspector;
    this.pidAlive = pidAlive;
    this.signalProcess = signalProcess;
    this.localServer = null;
    this.frpcProcess = null;
    this.activePid = null;
    this.secrets = null;
    this.desiredRunning = false;
    this.launchTask = null;
    this.restartTimer = null;
    this.stableTimer = null;
    this.monitorTimer = null;
    this.reconnectAttempt = 0;
    this.outageStartedAt = 0;
    this.prolongedFailureLogged = false;
  }

  async getStatus() {
    const [config, runtime] = await Promise.all([this.store.getAccessCenter(), this.store.getAccessCenterRuntime()]);
    return {
      configured: Boolean(config.serverAddr && config.serverPort && config.remotePort && config.encryptedFrpToken),
      enabled: Boolean(config.enabled),
      accessMode: "public-read-only",
      name: config.name || "访问中心",
      serverAddr: config.serverAddr,
      serverPort: config.serverPort,
      remotePort: config.remotePort,
      localPort: config.localPort,
      publicUrl: config.publicUrl,
      proxyName: config.proxyName,
      frpTokenConfigured: Boolean(config.encryptedFrpToken),
      runtime,
    };
  }

  async configure(payload = {}) {
    const current = await this.store.getAccessCenter();
    const serverAddr = normalizeHost(payload.serverAddr || current.serverAddr);
    const serverPort = normalizePort(payload.serverPort || current.serverPort, "服务端口");
    const remotePort = normalizePort(payload.remotePort || current.remotePort, "公网端口");
    const localPort = normalizePort(payload.localPort || current.localPort || 8802, "本地端口");
    const name = String(payload.name || current.name || "访问中心").trim().slice(0, 80) || "访问中心";
    const frpToken = String(payload.frpToken || "").trim();
    if (!frpToken && !current.encryptedFrpToken) throw new Error("首次配置需要填写 FRP Token。");

    const next = {
      ...current,
      enabled: payload.enabled !== false,
      name,
      serverAddr,
      serverPort,
      remotePort,
      localHost: "127.0.0.1",
      localPort,
      proxyName: current.proxyName || `access_center_${crypto.randomBytes(5).toString("hex")}`,
      publicUrl: `http://${serverAddr}:${remotePort}/access`,
    };

    if (frpToken) next.encryptedFrpToken = await this.credentialStore.protect(frpToken);
    this.secrets = null;
    await this.store.saveAccessCenter(next);
    await this.restart();
    return this.getStatus();
  }

  async disable() {
    await this.store.saveAccessCenter({ enabled: false });
    await this.stop();
    return this.getStatus();
  }

  async restore() {
    const config = await this.store.getAccessCenter();
    if (config.enabled && config.encryptedFrpToken) {
      await this.start();
    }
  }

  async restart() {
    await this.stop();
    const config = await this.store.getAccessCenter();
    if (config.enabled) await this.start();
  }

  async start() {
    const config = await this.store.getAccessCenter();
    if (!config.enabled) return this.getStatus();
    this.desiredRunning = true;
    if (this.activePid && this.isPidAlive(this.activePid)) return this.getStatus();
    if (this.launchTask) return this.launchTask;
    if (!fs.existsSync(this.frpcBinaryPath)) throw new Error("未找到 frpc，无法启动访问中心。");

    const task = this.startInternal(config);
    this.launchTask = task;
    return task.finally(() => {
      if (this.launchTask === task) this.launchTask = null;
    });
  }

  async startInternal(config) {
    const runtime = await this.store.getAccessCenterRuntime();
    if (runtime.pid && this.isPidAlive(runtime.pid) && await this.isOwnedAccessProcess(runtime.pid, runtime)) {
      if (runtime.ownerPid === process.pid && this.frpcProcess) {
        this.activePid = runtime.pid;
        await this.startLocalServer(config);
        this.startMonitor();
        return this.getStatus();
      }
      const stopped = await this.stopStaleProcess(runtime);
      if (!stopped) {
        this.activePid = runtime.pid;
        await this.startLocalServer(config);
        await this.store.saveAccessCenterRuntime({
          ...runtime,
          status: "running",
          ownerPid: process.pid,
          binaryPath: this.frpcBinaryPath,
          lastError: "",
          recoveryPending: false,
          nextRetryAt: "",
          reconnectAttempt: 0,
        });
        if (this.logger.warn) {
          await this.logger.warn("访问中心原进程无法由当前权限停止，已安全接管，未重复启动。");
        }
        this.markStable(runtime.pid);
        this.startMonitor();
        return this.getStatus();
      }
    }

    try {
      await this.startLocalServer(config);
    } catch (error) {
      this.desiredRunning = false;
      await this.store.saveAccessCenterRuntime({
        ...runtime,
        status: "error",
        pid: null,
        lastError: `访问中心本地端口启动失败：${error.message}`,
      });
      throw error;
    }

    try {
      await this.launchFrpc(config);
    } catch (error) {
      await this.scheduleRecovery(error.message);
    }
    this.startMonitor();
    return this.getStatus();
  }

  async stop() {
    this.desiredRunning = false;
    this.stopMonitoring();
    const runtime = await this.store.getAccessCenterRuntime();
    const child = this.frpcProcess;
    this.frpcProcess = null;
    const activePid = this.activePid || runtime.pid;
    this.activePid = null;
    const owned = child || (activePid && await this.isOwnedAccessProcess(activePid, runtime));
    const stopped = !activePid || !owned || await this.terminateProcess(activePid, child);
    await this.closeLocalServer();
    if (!stopped && activePid) {
      const message = "当前权限无法停止访问中心 FRPC，已保留进程记录以避免重复启动。";
      await this.store.saveAccessCenterRuntime({
        ...runtime,
        status: "error",
        pid: activePid,
        lastError: message,
        recoveryPending: false,
      });
      throw new Error(message);
    }
    await this.store.saveAccessCenterRuntime({
      ...runtime,
      status: "stopped",
      pid: null,
      ownerPid: null,
      lastError: "",
      recoveryPending: false,
      outageSince: "",
      nextRetryAt: "",
      reconnectAttempt: 0,
    });
  }

  async stopStaleProcess(runtimeValue = null) {
    const runtime = runtimeValue || await this.store.getAccessCenterRuntime();
    if (!runtime.pid || !await this.isOwnedAccessProcess(runtime.pid, runtime)) return true;
    const stopped = await this.terminateProcess(runtime.pid);
    if (!stopped) return false;
    await this.store.saveAccessCenterRuntime({ ...runtime, status: "stopped", pid: null, lastError: "" });
    return true;
  }

  async terminateProcess(pid, child = null) {
    if (!pid || !this.isPidAlive(pid)) return true;
    try {
      if (child) child.kill("SIGTERM");
      else this.signalProcess(pid, "SIGTERM");
    } catch (error) {
      if (!this.isPidAlive(pid)) return true;
      if (error && error.code === "EPERM") return false;
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && this.isPidAlive(pid)) await delay(100);
    if (this.isPidAlive(pid)) {
      try {
        if (child) child.kill("SIGKILL");
        else this.signalProcess(pid, "SIGKILL");
      } catch { /* process may require a higher-integrity session */ }
      const forceDeadline = Date.now() + 500;
      while (Date.now() < forceDeadline && this.isPidAlive(pid)) await delay(50);
    }
    return !this.isPidAlive(pid);
  }

  isPidAlive(pid) {
    return this.pidAlive ? this.pidAlive(pid) : isPidAlive(pid, this.signalProcess);
  }

  async isOwnedAccessProcess(pid, runtimeValue = null) {
    if (!Number.isInteger(Number(pid)) || !this.isPidAlive(pid)) return false;
    if (this.frpcProcess && this.frpcProcess.pid === Number(pid)) return true;
    const runtime = runtimeValue || await this.store.getAccessCenterRuntime();
    if (runtime.ownerPid === process.pid && areSamePath(runtime.binaryPath, this.frpcBinaryPath)) return true;
    if (process.platform !== "win32" && !this.processInspector) return false;
    try {
      const info = this.processInspector
        ? await this.processInspector(Number(pid))
        : await this.inspectWindowsProcess(Number(pid));
      if (!info) return false;
      const processName = info.name || info.Name || "";
      const processPath = info.path || info.Path || "";
      const processStartTime = info.startTime || info.StartTime || "";
      const expectedName = path.parse(this.frpcBinaryPath).name.toLowerCase();
      if (String(processName).toLowerCase() !== expectedName) return false;
      if (processPath && !areSamePath(processPath, this.frpcBinaryPath)) return false;
      const expectedStart = Date.parse(runtime.lastStartedAt || "");
      const actualStart = Date.parse(processStartTime);
      return !Number.isFinite(expectedStart)
        || !Number.isFinite(actualStart)
        || Math.abs(expectedStart - actualStart) < 15_000;
    } catch {
      return false;
    }
  }

  async inspectWindowsProcess(pid) {
    return inspectWindowsProcess(pid);
  }

  async startLocalServer(config) {
    if (this.localServer) return;
    const app = createAccessCenterApp(this);
    this.localServer = await new Promise((resolve, reject) => {
      const server = app.listen(config.localPort, config.localHost, () => resolve(server));
      server.once("error", reject);
    });
  }

  async closeLocalServer() {
    if (!this.localServer) return;
    const server = this.localServer;
    this.localServer = null;
    await new Promise((resolve) => server.close(resolve));
  }

  async launchFrpc(config) {
    const frpToken = await this.getFrpToken(config);
    const configText = this.buildFrpcConfig(config, frpToken);
    await fsp.writeFile(this.store.getAccessCenterConfigPath(), configText, "utf8");
    try {
      await this.startFrpc(config);
      await delay(this.startupProbeMs);
      if (!this.activePid || !this.isPidAlive(this.activePid)) {
        throw new Error("访问中心 FRPC 未能保持运行，请检查服务端地址、Token 和端口权限。");
      }
      if (this.logger.info) await this.logger.info(`访问中心已启动：${config.publicUrl}`);
    } finally {
      await fsp.rm(this.store.getAccessCenterConfigPath(), { force: true });
    }
  }

  async startFrpc(config) {
    const logWriter = new RotatingLogWriter(this.store.getAccessCenterLogPath());
    const child = this.spawnProcess(this.frpcBinaryPath, ["-c", this.store.getAccessCenterConfigPath()], {
      cwd: path.dirname(this.frpcBinaryPath),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.frpcProcess = child;
    if (child.stdout) child.stdout.on("data", (chunk) => logWriter.write(this.redactLog(chunk.toString())));
    if (child.stderr) child.stderr.on("data", (chunk) => logWriter.write(this.redactLog(chunk.toString())));
    let exitHandled = false;
    let initializationTask = Promise.resolve();
    const handleExit = async (error, code = null) => {
      if (exitHandled) return;
      exitHandled = true;
      await initializationTask.catch(() => undefined);
      await logWriter.end();
      if (this.frpcProcess !== child) return;
      this.frpcProcess = null;
      this.activePid = null;
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      if (this.desiredRunning) {
        await this.scheduleRecovery(error ? error.message : `访问中心 FRPC 已退出，退出码=${code}`);
      } else {
        const runtime = await this.store.getAccessCenterRuntime();
        await this.store.saveAccessCenterRuntime({
          ...runtime,
          status: "stopped",
          pid: null,
          ownerPid: null,
          lastError: "",
          recoveryPending: false,
        });
      }
    };
    child.once("error", (error) => { handleExit(error).catch(() => undefined); });
    child.once("close", (code) => {
      const error = code === 0 ? null : new Error(`访问中心 FRPC 已退出，退出码=${code}`);
      handleExit(error, code).catch(() => undefined);
    });
    await new Promise((resolve, reject) => {
      let spawned = false;
      child.once("spawn", () => {
        spawned = true;
        resolve();
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (!spawned) reject(new Error(`访问中心 FRPC 在启动前退出，退出码=${code}`));
      });
    });
    if (exitHandled || this.frpcProcess !== child) throw new Error("访问中心 FRPC 在启动过程中退出。");
    this.activePid = child.pid;
    initializationTask = this.store.saveAccessCenterRuntime({
      status: "running",
      pid: child.pid,
      ownerPid: process.pid,
      binaryPath: this.frpcBinaryPath,
      lastStartedAt: nowIso(),
      lastError: "",
      recoveryPending: false,
      outageSince: "",
      nextRetryAt: "",
      reconnectAttempt: 0,
    });
    await initializationTask;
    if (exitHandled || this.frpcProcess !== child) throw new Error("访问中心 FRPC 在启动过程中退出。");
    this.markStable(child.pid);
  }

  async scheduleRecovery(reason) {
    if (!this.desiredRunning || this.restartTimer) return;
    if (!this.outageStartedAt) this.outageStartedAt = Date.now();
    this.reconnectAttempt += 1;
    const delayMs = this.restartDelays[Math.min(this.reconnectAttempt - 1, this.restartDelays.length - 1)];
    const prolonged = Date.now() - this.outageStartedAt >= this.stableAfterMs;
    const runtime = await this.store.getAccessCenterRuntime();
    await this.store.saveAccessCenterRuntime({
      ...runtime,
      status: prolonged ? "error" : "reconnecting",
      pid: null,
      ownerPid: null,
      lastError: reason,
      recoveryPending: true,
      outageSince: runtime.outageSince || new Date(this.outageStartedAt).toISOString(),
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      reconnectAttempt: this.reconnectAttempt,
    });
    if (this.reconnectAttempt === 1 && this.logger.warn) {
      await this.logger.warn(`访问中心连接中断，${delayMs / 1000} 秒后自动恢复：${reason}`);
    } else if (prolonged && !this.prolongedFailureLogged && this.logger.error) {
      this.prolongedFailureLogged = true;
      await this.logger.error(`访问中心已连续恢复失败超过 ${Math.round(this.stableAfterMs / 1000)} 秒：${reason}`);
    }

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (!this.desiredRunning) return;
      const config = await this.store.getAccessCenter();
      if (!config.enabled) {
        this.desiredRunning = false;
        return;
      }
      try {
        await this.start();
      } catch (error) {
        await this.scheduleRecovery(error.message);
      }
    }, delayMs);
    if (typeof this.restartTimer.unref === "function") this.restartTimer.unref();
  }

  markStable(pid) {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      if (this.activePid === pid && this.isPidAlive(pid)) {
        this.reconnectAttempt = 0;
        this.outageStartedAt = 0;
        this.prolongedFailureLogged = false;
      }
    }, this.stableAfterMs);
    if (typeof this.stableTimer.unref === "function") this.stableTimer.unref();
  }

  startMonitor() {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      if (!this.desiredRunning) return;
      if (this.activePid && this.isPidAlive(this.activePid)) return;
      if (!this.launchTask && !this.restartTimer) {
        this.scheduleRecovery("访问中心进程未运行。").catch(() => undefined);
      }
    }, this.monitorIntervalMs);
    if (typeof this.monitorTimer.unref === "function") this.monitorTimer.unref();
  }

  stopMonitoring() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.monitorTimer = null;
    this.restartTimer = null;
    this.stableTimer = null;
    this.reconnectAttempt = 0;
    this.outageStartedAt = 0;
    this.prolongedFailureLogged = false;
  }

  redactLog(text) {
    const token = this.secrets && this.secrets.frpToken;
    return token ? String(text).split(token).join("***") : String(text);
  }

  buildFrpcConfig(config, frpToken) {
    return [
      `serverAddr = ${escapeToml(config.serverAddr)}`,
      `serverPort = ${config.serverPort}`,
      "auth.method = \"token\"",
      `auth.token = ${escapeToml(frpToken)}`,
      "loginFailExit = false",
      "transport.tls.enable = true",
      "",
      "[[proxies]]",
      `name = ${escapeToml(config.proxyName)}`,
      "type = \"tcp\"",
      `localIP = ${escapeToml(config.localHost)}`,
      `localPort = ${config.localPort}`,
      `remotePort = ${config.remotePort}`,
      "",
    ].join("\n");
  }

  async getFrpToken(config = null) {
    if (this.secrets && this.secrets.frpToken) return this.secrets.frpToken;
    const active = config || await this.store.getAccessCenter();
    const frpToken = await this.credentialStore.unprotect(active.encryptedFrpToken);
    if (!frpToken) throw new Error("访问中心 FRP Token 无法读取，请重新保存配置。");
    this.secrets = { ...(this.secrets || {}), frpToken };
    return frpToken;
  }

  async listLinks() {
    const config = await this.store.getAccessCenter();
    const instances = await this.store.listInstances();
    const links = [];
    for (const instance of instances) {
      const [configText, tunnelData] = await Promise.all([
        this.store.readConfig(instance.id),
        this.tunnelService.list(instance.id),
      ]);
      const serverAddr = parseFrpcServerAddr(configText);
      for (const tunnel of tunnelData.tunnels) {
        const key = profileKey(instance.id, tunnel.name);
        const profile = config.linkProfiles[key] || {};
        const link = buildLink(tunnel, serverAddr, profile);
        links.push({
          key,
          instanceId: instance.id,
          instanceName: instance.name,
          name: tunnel.displayName || tunnel.name,
          tunnelName: tunnel.name,
          group: tunnel.group || "未分组",
          groupSource: tunnel.groupSource || "none",
          groupOverride: tunnel.groupOverride || "",
          type: String(tunnel.type || "").toUpperCase(),
          enabled: Boolean(tunnel.enabled),
          localPort: tunnel.localPort,
          remotePort: tunnel.remotePort,
          serverAddr,
          profile: {
            mode: profile.mode || "auto",
            path: profile.path || "",
            customUrl: profile.customUrl || "",
          },
          ...link,
        });
      }
    }
    return links.sort((left, right) => Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name, "zh-CN"));
  }

  async updateLinkProfile(key, payload = {}) {
    const allowedModes = new Set(["auto", "http", "https", "endpoint", "custom"]);
    if (!key || String(key).length > 320) throw new Error("隧道标识无效。");
    const mode = allowedModes.has(payload.mode) ? payload.mode : "auto";
    const customUrl = String(payload.customUrl || "").trim();
    if (customUrl.length > 1024 || /[\r\n]/.test(customUrl)) throw new Error("自定义链接格式不正确。");
    if (mode === "custom" && !/^https?:\/\//i.test(customUrl)) throw new Error("自定义链接必须以 http:// 或 https:// 开始。");
    const config = await this.store.getAccessCenter();
    const knownLinks = await this.listLinks();
    if (!knownLinks.some((link) => link.key === key)) throw new Error("隧道不存在或已被同步移除。");
    const nextProfiles = {
      ...config.linkProfiles,
      [key]: { mode, path: normalizePath(payload.path), customUrl },
    };
    await this.store.saveAccessCenter({ linkProfiles: nextProfiles });
    return this.listLinks();
  }
}

function createAccessCenterApp(service) {
  const app = express();
  const publicDir = getPublicDir();
  const accessDir = path.join(publicDir, "access");
  let speedTestRunning = false;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
    res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'");
    next();
  });

  app.get("/access/api/links", async (req, res, next) => {
    try { res.json({ success: true, message: "ok", data: await service.listLinks() }); } catch (error) { next(error); }
  });
  app.get("/access/api/speed-test", async (req, res) => {
    if (speedTestRunning) return res.status(429).json({ success: false, message: "已有测速正在进行，请稍后再试。", data: null });
    speedTestRunning = true;
    const duration = speedTestDuration(req.query.duration);
    const endsAt = Date.now() + duration * 1000;
    const chunk = crypto.randomBytes(64 * 1024);
    let closed = false;
    req.on("close", () => { closed = true; });
    res.status(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("X-Speed-Test-Duration", String(duration));
    res.flushHeaders();
    try {
      while (!closed && Date.now() < endsAt) {
        if (!res.write(chunk)) await waitForWritable(res, endsAt);
      }
    } catch {
      // The client may cancel an in-progress measurement.
    } finally {
      if (!res.writableEnded) res.end();
      speedTestRunning = false;
    }
  });
  app.get("/access/api/events", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    let previous = "";
    let busy = false;
    const send = async () => {
      if (busy) return;
      busy = true;
      try {
        const links = await service.listLinks();
        const digest = JSON.stringify(links);
        if (digest !== previous) {
          previous = digest;
          res.write(`event: links\ndata: ${digest}\n\n`);
        } else {
          res.write(": keepalive\n\n");
        }
      } catch {
        res.write("event: error\ndata: {}\n\n");
      } finally {
        busy = false;
      }
    };
    await send();
    const timer = setInterval(send, 3_000);
    req.on("close", () => clearInterval(timer));
  });
  app.get("/access/88frp-logo.png", (_req, res) => res.sendFile(path.join(publicDir, "88frp-logo.png")));
  app.get("/access/lucide.css", (_req, res) => res.sendFile(path.join(publicDir, "css", "lucide.css")));
  app.get("/access/lucide.woff2", (_req, res) => res.sendFile(path.join(publicDir, "css", "lucide.woff2")));
  app.get(["/access", "/access/"], (_req, res) => res.sendFile(path.join(accessDir, "index.html")));
  app.use("/access", express.static(accessDir, { index: false }));
  app.use((error, _req, res, _next) => {
    res.status(400).json({ success: false, message: error.message || "访问中心请求失败。", data: null });
  });
  return app;
}

module.exports = {
  AccessCenterService,
  buildLink,
  createAccessCenterApp,
  inferMode,
  normalizePath,
  profileKey,
};
