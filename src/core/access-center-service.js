const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");

const { parseFrpcServerAddr } = require("./tunnel-service");
const { getPublicDir } = require("../shared/runtime-env");

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
  constructor({ store, tunnelService, credentialStore, logger, frpcBinaryPath }) {
    this.store = store;
    this.tunnelService = tunnelService;
    this.credentialStore = credentialStore;
    this.logger = logger;
    this.frpcBinaryPath = frpcBinaryPath;
    this.localServer = null;
    this.frpcProcess = null;
    this.secrets = null;
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
    if (this.localServer || this.frpcProcess) return this.getStatus();
    if (!fs.existsSync(this.frpcBinaryPath)) throw new Error("未找到 frpc，无法启动访问中心。");

    await this.stopStaleProcess();
    await this.startLocalServer(config);
    try {
      const frpToken = await this.getFrpToken(config);
      const configText = this.buildFrpcConfig(config, frpToken);
      await fsp.writeFile(this.store.getAccessCenterConfigPath(), configText, "utf8");
      await this.startFrpc(config);
      await delay(900);
      if (!this.frpcProcess) throw new Error("访问中心 FRPC 未能保持运行，请检查服务端地址、Token 和端口权限。");
      await fsp.rm(this.store.getAccessCenterConfigPath(), { force: true });
      await this.logger.info(`访问中心已启动：${config.publicUrl}`);
    } catch (error) {
      await fsp.rm(this.store.getAccessCenterConfigPath(), { force: true });
      await this.closeLocalServer();
      await this.store.saveAccessCenterRuntime({ status: "error", pid: null, lastError: error.message });
      throw error;
    }
    return this.getStatus();
  }

  async stop() {
    const runtime = await this.store.getAccessCenterRuntime();
    const child = this.frpcProcess;
    this.frpcProcess = null;
    if (child && !child.killed) {
      try { child.kill("SIGTERM"); } catch { /* ignore process shutdown errors */ }
    } else if (runtime.pid && await this.isOwnedAccessProcess(runtime.pid)) {
      try { process.kill(runtime.pid, "SIGTERM"); } catch { /* stale process has already exited */ }
    }
    await this.closeLocalServer();
    await this.store.saveAccessCenterRuntime({ ...runtime, status: "stopped", pid: null, lastError: "" });
  }

  async stopStaleProcess() {
    const runtime = await this.store.getAccessCenterRuntime();
    if (!runtime.pid || !await this.isOwnedAccessProcess(runtime.pid)) return;
    try {
      process.kill(runtime.pid, "SIGTERM");
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await delay(150);
        if (!this.isPidAlive(runtime.pid)) break;
      }
      await this.store.saveAccessCenterRuntime({ ...runtime, status: "stopped", pid: null, lastError: "" });
    } catch (error) {
      throw new Error(`无法停止上次遗留的访问中心进程：${error.message}`);
    }
  }

  isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async isOwnedAccessProcess(pid) {
    if (!Number.isInteger(Number(pid)) || !this.isPidAlive(pid)) return false;
    if (process.platform !== "win32") return false;
    const script = `$p = Get-CimInstance -ClassName Win32_Process -Filter \"ProcessId = ${Number(pid)}\" -ErrorAction SilentlyContinue; if ($p) { $p.CommandLine }`;
    try {
      const commandLine = await new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error("无法读取进程信息。")));
      });
      const command = String(commandLine).toLowerCase();
      return command.includes(path.basename(this.frpcBinaryPath).toLowerCase())
        && command.includes(this.store.getAccessCenterConfigPath().toLowerCase());
    } catch {
      return false;
    }
  }

  async startLocalServer(config) {
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

  async startFrpc(config) {
    const logStream = fs.createWriteStream(this.store.getAccessCenterLogPath(), { flags: "a" });
    const child = spawn(this.frpcBinaryPath, ["-c", this.store.getAccessCenterConfigPath()], {
      cwd: path.dirname(this.frpcBinaryPath),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.frpcProcess = child;
    child.stdout.on("data", (chunk) => logStream.write(this.redactLog(chunk.toString())));
    child.stderr.on("data", (chunk) => logStream.write(this.redactLog(chunk.toString())));
    child.once("error", async (error) => {
      logStream.end();
      if (this.frpcProcess !== child) return;
      this.frpcProcess = null;
      await this.store.saveAccessCenterRuntime({ status: "error", pid: null, lastError: error.message });
    });
    child.once("close", async (code) => {
      logStream.end();
      if (this.frpcProcess !== child) return;
      this.frpcProcess = null;
      await this.store.saveAccessCenterRuntime({
        status: code === 0 ? "stopped" : "error",
        pid: null,
        lastError: code === 0 ? "" : `访问中心 FRPC 已退出，退出码=${code}`,
      });
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.store.saveAccessCenterRuntime({
      status: "running",
      pid: child.pid,
      lastStartedAt: nowIso(),
      lastError: "",
    });
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
