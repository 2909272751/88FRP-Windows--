"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { resolve4 } = require("node:dns/promises");
const { GatewayStore } = require("./gateway-store");
const { CaddyManager } = require("./caddy-manager");
const { FrpcManager } = require("./frpc-manager");
const { Ipv6Provider } = require("./ipv6-provider");
const { CloudflareDnsService } = require("./cloudflare-dns");
const { FirewallService } = require("./firewall-service");
const { RelayManager } = require("./relay-manager");
const {
  DEFAULT_ADMIN_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_SOURCE_CHECK_INTERVAL_MS,
  DEFAULT_STATE,
  MIN_DNS_CHECK_INTERVAL_MS,
  MIN_SOURCE_CHECK_INTERVAL_MS,
  buildCaddyfile,
  buildFrpcConfig,
  buildTunnelNameMap,
  buildSummary,
  clone,
  desiredDnsRecords,
  formatHostPort,
  isGlobalIPv6,
  lineDomain,
  normalizeDomain,
  normalizePort,
  normalizeService,
  normalizeServiceName,
  normalizeSsh,
  normalizeState,
  nowIso,
  publicEndpointUrls,
  redactSensitive,
  serviceUrl,
  slugifyServiceName,
  sameDnsTarget,
  sshEndpointUrls,
  tcpEndpoint,
  udpEndpoint,
  uniqueServiceName,
  validateServiceSet,
} = require("./gateway-model");
const { parseFrpcServerAddr, parseFrpcTunnels } = require("../tunnel-service");
const { isPidAlive } = require("../../shared/process-utils");

const MAX_SOURCE_SYNC_BACKOFF_MS = 30 * 60_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeIp(value) {
  return String(value || "").replace(/^::ffff:/i, "").trim();
}

function isLoopbackAddress(value) {
  const address = normalizeIp(value);
  return address === "127.0.0.1" || address === "::1" || address === "";
}

function probeTcp(host, port, timeoutMs = 450) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    let settled = false;
    const done = (online) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(online);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function safeDomainFromBinding(binding) {
  if (!binding || !binding.zone) return "";
  const zone = normalizeDomain(binding.zone);
  const hostname = String(binding.hostname || "@").trim().toLowerCase();
  return hostname === "@" ? zone : normalizeDomain(`${hostname}.${zone}`);
}

function groupCloudflareWarning(conflicts) {
  if (!conflicts || !conflicts.length) return "";
  return conflicts.map((item) => item.message).filter(Boolean).join("；");
}

class GatewayService {
  constructor({
    store,
    logger,
    credentialStore,
    processManager,
    instanceService,
    tunnelService,
    syncService,
    domainBindingService,
    frpcBinaryPath,
    caddyBinaryPath,
    adminPort = DEFAULT_ADMIN_PORT,
    fetchImpl,
    ipv6Provider,
    caddyManager,
    frpcManager,
    dnsService,
    firewallService,
    relayManager,
    resolveIPv4 = resolve4,
    probeTcpImpl = probeTcp,
  }) {
    this.store = store;
    this.logger = logger;
    this.credentialStore = credentialStore;
    this.processManager = processManager;
    this.instanceService = instanceService;
    this.tunnelService = tunnelService;
    this.syncService = syncService;
    this.domainBindingService = domainBindingService;
    this.frpcBinaryPath = frpcBinaryPath;
    this.caddyBinaryPath = caddyBinaryPath;
    this.adminPort = Number(adminPort) || DEFAULT_ADMIN_PORT;
    this.resolveIPv4 = resolveIPv4;
    this.probeTcp = probeTcpImpl;
    this.gatewayStore = new GatewayStore({ store });
    this.ipv6Provider = ipv6Provider || new Ipv6Provider();
    this.caddy = caddyManager || new CaddyManager({
      store: this.gatewayStore,
      binaryPath: caddyBinaryPath,
      logger,
    });
    this.frpc = frpcManager || new FrpcManager({
      store: this.gatewayStore,
      binaryPath: frpcBinaryPath,
      logger,
    });
    this.dns = dnsService || new CloudflareDnsService({ fetchImpl });
    this.firewall = firewallService || new FirewallService();
    this.relays = relayManager || new RelayManager({
      store: this.gatewayStore,
      logger,
    });
    this.schedulerTimer = null;
    this.schedulerRunning = false;
    this.dnsSyncQueue = Promise.resolve();
    this.lastSchedulerCheck = 0;
    this.lastSourceCheckAt = 0;
    this.sourceSyncFailure = null;
    this.sourceSyncRunning = false;
    this.failureBackoff = new Map();
    this.ipv6Cache = null;
    this.ipv6CacheAt = 0;
    this.started = false;
  }

  async initialize() {
    await this.gatewayStore.initialize();
    return this.readState();
  }

  setAdminPort(port) {
    const value = normalizePort(port, "管理端口");
    this.adminPort = value;
  }

  readState() {
    return this.gatewayStore.readState();
  }

  saveState(state) {
    return this.gatewayStore.saveState(state);
  }

  async legacyInstances() {
    const instances = await this.store.listInstances();
    return instances.map((instance) => ({
      id: instance.id,
      name: instance.name,
      hasConfig: Boolean(instance.hasConfig),
      autoSyncEnabled: Boolean(instance.autoSyncEnabled),
      runtimeStatus: instance.runtime?.status || "stopped",
    }));
  }

  async getOverview({ remoteAddress = "", host = "", includeHealth = true } = {}) {
    const state = this.readState();
    const runtime = this.gatewayStore.readRuntime();
    const ipv6Promise = !state.initialized
      ? Promise.resolve({
        address: "",
        interfaceName: "",
        candidates: [],
        warning: "统一入口初始化后再检测公网 IPv6。",
      })
      : state.device.ipv6Mode === "manual"
      ? Promise.resolve({
        address: state.device.manualIpv6,
        interfaceName: "",
        candidates: [],
        warning: state.device.manualIpv6 ? "" : "尚未填写手动公网 IPv6。",
      })
      : includeHealth
      ? this.detectIpv6Cached(state)
      : Promise.resolve({
        address: state.cloudflare.lastTarget?.ipv6 || "",
        interfaceName: "",
        candidates: [],
        warning: state.cloudflare.lastTarget?.ipv6 ? "" : "正后台检查公网 IPv6。",
      });
    const serviceProbesPromise = Promise.all(state.services.map((service) => (
      includeHealth && service.enabled && ["http", "tcp"].includes(service.kind)
        ? this.probeTcp(service.localHost, service.localPort)
        : Promise.resolve(null)
    )));
    const sshProbePromise = includeHealth && state.ssh.enabled
      ? this.probeTcp(state.ssh.localHost, state.ssh.localPort)
      : Promise.resolve(null);
    const expectedTcpPorts = state.initialized
      ? [
        state.device.gatewayPort,
        ...(state.ssh.enabled ? [state.ssh.remotePort] : []),
        ...state.services
          .filter((service) => service.kind === "tcp" && service.enabled)
          .map((service) => service.remotePort),
      ]
      : [];
    const expectedUdpPorts = state.initialized
      ? state.services
        .filter((service) => service.kind === "udp" && service.enabled)
        .map((service) => service.remotePort)
      : [];
    const firewallPromise = state.initialized
      ? this.firewall.getStatus({ expectedTcpPorts, expectedUdpPorts }).catch((error) => ({
        supported: process.platform === "win32",
        tcpRule: false,
        udpRule: false,
        firewallEnabled: null,
        expectedTcpPorts,
        expectedUdpPorts,
        missingTcpPorts: expectedTcpPorts,
        missingUdpPorts: expectedUdpPorts,
        tcpCovered: false,
        udpCovered: expectedUdpPorts.length === 0,
        detail: error.message,
      }))
      : Promise.resolve({
        supported: process.platform === "win32",
        tcpRule: false,
        udpRule: false,
        firewallEnabled: null,
        expectedTcpPorts: [],
        expectedUdpPorts: [],
        missingTcpPorts: [],
        missingUdpPorts: [],
        tcpCovered: false,
        udpCovered: true,
        detail: "初始化后检查防火墙规则。",
      });
    const sourceConfigPromise = this.hasSourceConfig(state);
    const [ipv6, serviceOnline, sshPortOnline, firewallStatus, lastBaseConfigAvailable] = await Promise.all([
      ipv6Promise,
      serviceProbesPromise,
      sshProbePromise,
      firewallPromise,
      sourceConfigPromise,
    ]);
    const services = [];
    const relayStatus = this.relays.getStatus();
    for (const [index, service] of state.services.entries()) {
      const url = serviceUrl(state, service);
      const relay = relayStatus.find((item) => item.id === `udp:${service.id}`) || null;
      const tcpRelay = relayStatus.find((item) => item.id === `tcp:${service.id}`) || null;
      services.push({
        ...service,
        url,
        endpoint: udpEndpoint(state, service),
        tcpEndpoint: tcpEndpoint(state, service),
        target: formatHostPort(service.localHost, service.localPort),
        online: serviceOnline[index],
        relay: service.kind === "tcp" ? tcpRelay : relay,
      });
    }
    const caddyStatusRaw = this.caddy.getStatus();
    const frpcStatusRaw = this.frpc.getStatus();
    const caddyStatus = { ...caddyStatusRaw, lastError: friendlyRuntimeError(caddyStatusRaw.lastError) };
    const frpcStatus = { ...frpcStatusRaw, lastError: friendlyRuntimeError(frpcStatusRaw.lastError) };
    const sshRelay = relayStatus.find((item) => item.id === "ssh") || null;
    return {
      initialized: state.initialized,
      migratedAt: state.migratedAt,
      device: {
        ...state.device,
        summary: buildSummary(state),
        ipv6Detected: ipv6,
        publicRootUrl: state.device.domain
          ? `https://${state.device.domain}${state.device.gatewayPort === 443 ? "" : `:${state.device.gatewayPort}`}/`
          : "",
        publicEndpoints: publicEndpointUrls(state),
      },
      source: {
        ...state.source,
        lastBaseConfigAvailable,
        autoSync: runtime.source || null,
      },
      cloudflare: {
        configured: Boolean(state.cloudflare.encryptedToken),
        zoneName: state.cloudflare.zoneName,
        zoneId: state.cloudflare.zoneId,
        ttl: state.cloudflare.ttl,
        lastSyncAt: state.cloudflare.lastSyncAt,
        lastCheckAt: state.cloudflare.lastCheckAt,
        lastError: state.cloudflare.lastError,
        lastTarget: state.cloudflare.lastTarget,
        lastSummary: state.cloudflare.lastSummary,
      },
      services,
      ssh: {
        ...state.ssh,
        online: sshPortOnline,
        endpoint: state.device.domain && state.ssh.remotePort
          ? `ssh.${state.device.domain}:${state.ssh.remotePort}`
          : "",
        endpoints: sshEndpointUrls(state),
        relay: sshRelay,
      },
      runtime: {
        ...runtime,
        caddy: caddyStatus,
        frpc: frpcStatus,
        relays: relayStatus,
      },
      firewall: firewallStatus,
      connection: this.describeConnection(remoteAddress, host, state),
      remoteAccess: this.buildPublicRemoteAccess(state, runtime),
      legacyInstances: state.initialized ? [] : await this.legacyInstances(),
      nextSteps: this.buildNextSteps(state),
    };
  }

  async detectIpv6Cached(state) {
    if (this.ipv6Cache && Date.now() - this.ipv6CacheAt < 5_000) return this.ipv6Cache;
    const value = await this.ipv6Provider.detect({
      previousAddress: state.cloudflare.lastTarget?.ipv6 || "",
    }).catch((error) => ({
      address: "",
      interfaceName: "",
      candidates: [],
      warning: error.message,
    }));
    this.ipv6Cache = value;
    this.ipv6CacheAt = Date.now();
    return value;
  }

  buildNextSteps(state) {
    const steps = [];
    if (!state.initialized) {
      steps.push({ key: "migrate", title: "导入本机连接来源", done: false });
      return steps;
    }
    steps.push({ key: "domain", title: "设置设备域名", done: Boolean(state.device.domain) });
    steps.push({ key: "cloudflare", title: "授权 Cloudflare", done: Boolean(state.cloudflare.encryptedToken) });
    steps.push({
      key: "caddy",
      title: "启动统一入口",
      done: this.caddy.getStatus().status === "running",
    });
    steps.push({
      key: "services",
      title: "添加网页服务",
      done: state.services.some((item) => item.kind === "http"),
    });
    return steps;
  }

  describeConnection(remoteAddress, host, state) {
    const address = normalizeIp(remoteAddress);
    const hostHeader = String(host || "").split(":")[0].replace(/^\[|\]$/g, "").toLowerCase();
    const isLocalHost = ["127.0.0.1", "localhost", "::1"].includes(hostHeader);
    if (isLoopbackAddress(address)) {
      if (isLocalHost) {
        return {
          mode: "local",
          label: "本机",
          detail: "当前通过本机管理地址访问。",
          address,
        };
      }
      return {
        mode: "ipv4",
        label: "IPv4 · 88FRP 备用",
        detail: "公网流量经 88FRP 节点回到本机统一入口。",
        address,
      };
    }
    if (net.isIP(address) === 6) {
      return {
        mode: "ipv6",
        label: "IPv6 · 直连设备",
        detail: `当前来源：${address}`,
        address,
      };
    }
    if (net.isIP(address) === 4) {
      return {
        mode: "ipv4",
        label: "IPv4",
        detail: `当前来源：${address}`,
        address,
      };
    }
    return {
      mode: "unknown",
      label: "连接方式未知",
      detail: "无法从当前请求判断连接方式。",
      address,
    };
  }

  async getPublicPortal({ remoteAddress = "", host = "" } = {}) {
    const state = this.readState();
    const runtime = this.gatewayStore.readRuntime();
    return {
      initialized: state.initialized,
      deviceName: state.device.name || "本机设备",
      domain: state.device.domain,
      gatewayPort: state.device.gatewayPort,
      publicEndpoints: publicEndpointUrls(state),
      connection: this.describeConnection(remoteAddress, host, state),
      remoteAccess: this.buildPublicRemoteAccess(state, runtime),
      services: state.services
        .filter((service) => service.kind === "http" && service.enabled)
        .map((service) => ({
          name: service.name,
          title: service.title,
          tag: service.tag,
          description: service.description,
          url: serviceUrl(state, service),
        })),
      adminUrl: state.device.domain
        ? `https://admin.${state.device.domain}${state.device.gatewayPort === 443 ? "" : `:${state.device.gatewayPort}`}/`
        : "",
    };
  }

  buildPublicRemoteAccess(state, runtime = {}) {
    const sshEnabled = Boolean(state.ssh?.enabled && state.ssh.remotePort && state.device.domain);
    const port = Number(state.ssh?.remotePort || 0);
    const host = state.device.domain ? `ssh.${state.device.domain}` : "";
    const username = "<用户名>";
    const sshEndpoints = sshEndpointUrls(state);
    const sshTargets = [];
    if (sshEnabled) {
      sshTargets.push({
        family: "ipv6",
        label: "IPv6 · 专用域名直连",
        host: `ssh-v6.${state.device.domain}`,
        endpoint: sshEndpoints.ipv6,
        command: `ssh -p ${port} ${username}@ssh-v6.${state.device.domain}`,
      });
      sshTargets.push({
        family: "ipv4",
        label: "IPv4 · 88FRP 专用域名",
        host: `ssh-v4.${state.device.domain}`,
        endpoint: sshEndpoints.ipv4,
        command: `ssh -p ${port} ${username}@ssh-v4.${state.device.domain}`,
      });
    }
    const rdpService = (state.services || []).find((service) => (
      service.kind === "tcp"
      && service.enabled
      && Number(service.localPort) === 3389
      && Number(service.remotePort) > 0
    ));
    const rdpTargets = [];
    if (rdpService && state.device.domain) {
      rdpTargets.push({
        family: "auto",
        label: "自动 · 双栈域名",
        host: state.device.domain,
        endpoint: `${state.device.domain}:${Number(rdpService.remotePort)}`,
      });
      rdpTargets.push({
        family: "ipv6",
        label: "IPv6 · 专用域名直连",
        host: `v6.${state.device.domain}`,
        endpoint: `${lineDomain(state.device.domain, "ipv6")}:${Number(rdpService.remotePort)}`,
      });
      rdpTargets.push({
        family: "ipv4",
        label: "IPv4 · 88FRP 专用域名",
        host: `v4.${state.device.domain}`,
        endpoint: `${lineDomain(state.device.domain, "ipv4")}:${Number(rdpService.remotePort)}`,
      });
    }
    if (!sshEnabled && rdpTargets.length === 0) return null;
    return {
      ssh: {
        enabled: sshEnabled,
        host,
        port,
        domainCommand: sshEnabled ? `ssh -p ${port} ${username}@${host}` : "",
        endpoints: sshEndpoints,
        targets: sshTargets,
      },
      rdp: {
        enabled: rdpTargets.length > 0,
        direct: true,
        targets: rdpTargets,
      },
    };
  }

  async hasSourceConfig(state) {
    if (!state.source.legacyInstanceId) return false;
    return Boolean(await this.store.readConfig(state.source.legacyInstanceId));
  }

  async migrate({ instanceId, name, domain, gatewayPort, importServices = true } = {}) {
    if (!instanceId) throw new Error("请选择要迁移的旧实例。");
    const current = this.readState();
    if (current.initialized) throw new Error("本机已经完成统一入口初始化，不能重复迁移。");
    const instance = await this.instanceService.get(instanceId);
    const configText = await this.store.readConfig(instance.id);
    if (!configText.trim()) throw new Error("该实例还没有 frpc 配置，请先同步 88FRP 配置。");
    parseFrpcServerAddr(configText);

    let binding = null;
    try {
      binding = this.domainBindingService?.read(instance.id) || null;
    } catch {
      binding = null;
    }
    const imported = importServices
      ? await this.importLegacyTunnels(instance.id, { gatewayPort })
      : { services: [], warnings: [] };
    const migrationWarnings = [...imported.warnings];
    const now = nowIso();
    const deviceDomain = normalizeDomain(domain || safeDomainFromBinding(binding) || "");
    const cloudflare = {
      ...DEFAULT_STATE.cloudflare,
      encryptedToken: binding?.encryptedToken || "",
      zoneName: binding?.zone || "",
      zoneId: "",
      ttl: binding?.ttl || 60,
    };
    if (deviceDomain && cloudflare.encryptedToken) {
      try {
        const token = await this.credentialStore.unprotect(cloudflare.encryptedToken, {
          rawDpapi: !cloudflare.encryptedToken.startsWith("machine:"),
        });
        const zone = await this.dns.discoverZone(token, deviceDomain);
        cloudflare.zoneName = zone.name;
        cloudflare.zoneId = zone.id;
      } catch (error) {
        migrationWarnings.push(`Cloudflare 区域识别失败：${error.message}`);
      }
    }
    const next = normalizeState({
      ...clone(DEFAULT_STATE),
      initialized: true,
      migratedAt: now,
      device: {
        ...DEFAULT_STATE.device,
        name: String(name || instance.name || "本机设备").trim(),
        domain: deviceDomain,
        gatewayPort,
        createdAt: now,
        updatedAt: now,
      },
      source: {
        legacyInstanceId: instance.id,
        migratedInstanceName: instance.name,
        createdAt: now,
        updatedAt: now,
      },
      cloudflare,
      ssh: imported.ssh || { ...DEFAULT_STATE.ssh },
      services: imported.services,
    });
    validateServiceSet(next, { adminPort: this.adminPort });
    validateStateForWriteSafe(next);

    const before = clone(current);
    const previouslyRunning = await this.activeLegacyInstanceIds();
    let applied;
    try {
      await this.processManager.stopAll({ resume: false });
      applied = await this.applyStateProcesses(next, { startProcesses: true });
      this.saveState(next);
    } catch (error) {
      await this.restoreStateAndProcesses(before);
      await this.restoreLegacyInstances(previouslyRunning, error);
      await this.gatewayStore.appendAudit("gateway.migrate", "failed", {
        instanceId: instance.id,
        error: error.message,
      });
      throw error;
    }
    await this.gatewayStore.appendAudit("gateway.migrate", "success", {
      instanceId: instance.id,
      instanceName: instance.name,
      importedServices: imported.services.length,
      importedSsh: Boolean(imported.ssh?.enabled),
      domainMigrated: Boolean(binding?.zone),
      warnings: applied.warnings,
    });
    if (this.instanceService && typeof this.instanceService.update === "function") {
      try {
        await this.instanceService.update(instance.id, {
          autoStartEnabled: false,
          autoSyncEnabled: false,
        });
      } catch (error) {
        migrationWarnings.push(`旧实例停用设置未保存：${error.message}`);
      }
    }
    this.started = true;
    await this.startScheduler();
    if (next.device.domain && next.cloudflare.encryptedToken) {
      try {
        await this.syncDns({ force: true, reason: "migrate" });
      } catch (error) {
        migrationWarnings.push(`DNS 自动同步失败：${error.message}`);
      }
    }
    return {
      overview: await this.getOverview(),
      warnings: [...migrationWarnings, ...applied.warnings],
    };
  }

  async importLegacyTunnels(instanceId, { gatewayPort }) {
    const { tunnels } = await this.tunnelService.list(instanceId);
    const services = [];
    const warnings = [];
    const names = new Set();
    const ssh = { ...DEFAULT_STATE.ssh };
    for (const tunnel of tunnels) {
      if (!tunnel.enabled) continue;
      const localPort = Number(tunnel.localPort);
      const type = String(tunnel.type || "tcp").toLowerCase();
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) continue;
      if (localPort === Number(gatewayPort) || localPort === this.adminPort) {
        warnings.push(`${tunnel.displayName || tunnel.name} 指向管理/入口端口，未导入。`);
        continue;
      }
      if (type === "tcp" && localPort === 22) {
        ssh.enabled = true;
        ssh.localPort = 22;
        ssh.remotePort = Number(tunnel.remotePort) || 0;
        continue;
      }
      try {
        const remoteDesktop = localPort === 3389 || /电脑|桌面|rdp|remote/i.test(
          `${tunnel.displayName || ""} ${tunnel.name || ""}`
        );
        const requestedName = uniqueServiceName(
          remoteDesktop ? `${tunnel.displayName || tunnel.name || "远程桌面"} rdp` : tunnel.displayName || tunnel.name,
          names
        );
        const kind = type === "udp" ? "udp" : remoteDesktop ? "tcp" : "http";
        const service = normalizeService({
          kind,
          name: normalizeServiceName(requestedName),
          title: tunnel.displayName || tunnel.name || requestedName,
          tag: kind === "udp" ? "UDP" : kind === "tcp" ? "TCP 直通" : "网页服务",
          description: "",
          localHost: "127.0.0.1",
          localPort,
          remotePort: kind === "http" ? 0 : Number(tunnel.remotePort),
          enabled: kind === "http" ? true : Boolean(tunnel.remotePort),
        });
        names.add(service.name);
        services.push(service);
      } catch (error) {
        warnings.push(`${tunnel.displayName || tunnel.name} 导入失败：${error.message}`);
      }
    }
    if (ssh.enabled && !ssh.remotePort) {
      ssh.enabled = false;
      warnings.push("旧 SSH 隧道缺少公网端口，已关闭 SSH 映射，可在设置中重新填写。");
    }
    return { services, ssh, warnings };
  }

  async bootstrap({ name, secretKey, remoteUrl, domain, gatewayPort } = {}) {
    if (!String(name || "").trim()) throw new Error("设备名称不能为空。");
    if (!String(secretKey || "").trim()) throw new Error("请输入 88FRP 同步密钥。");
    const instance = await this.instanceService.create({
      name: String(name).trim(),
      secretKey: String(secretKey).trim(),
      remoteUrl: remoteUrl || undefined,
      autoSyncEnabled: false,
      autoStartEnabled: false,
    });
    try {
      await this.syncService.syncInstance(instance.id, { restartOnChange: false });
      return await this.migrate({
        instanceId: instance.id,
        name,
        domain,
        gatewayPort,
        importServices: false,
      });
    } catch (error) {
      await this.gatewayStore.appendAudit("gateway.bootstrap", "failed", {
        instanceId: instance.id,
        error: error.message,
      });
      throw error;
    }
  }

  async updateDevice(payload = {}) {
    const state = this.requireInitialized();
    const before = clone(state);
    const next = clone(state);
    if (Object.prototype.hasOwnProperty.call(payload, "name")) {
      next.device.name = String(payload.name || "").trim();
      if (!next.device.name) throw new Error("设备名称不能为空。");
      if (next.device.name.length > 60) throw new Error("设备名称最多 60 个字符。");
    }
    if (Object.prototype.hasOwnProperty.call(payload, "domain")) {
      next.device.domain = normalizeDomain(payload.domain);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "gatewayPort")) {
      next.device.gatewayPort = normalizePort(payload.gatewayPort, "统一入口端口");
      if (next.device.gatewayPort === this.adminPort) throw new Error("统一入口端口不能与管理端口相同。");
    }
    if (Object.prototype.hasOwnProperty.call(payload, "ipv6Mode")) {
      next.device.ipv6Mode = payload.ipv6Mode === "manual" ? "manual" : "auto";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "manualIpv6")) {
      const address = String(payload.manualIpv6 || "").trim().toLowerCase();
      if (address && !isGlobalIPv6(address)) throw new Error("手动 IPv6 必须是公网 IPv6 地址。");
      next.device.manualIpv6 = address;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "autoStart")) {
      next.device.autoStart = Boolean(payload.autoStart);
    }
    next.device.updatedAt = nowIso();
    validateServiceSet(next, { adminPort: this.adminPort });
    const configChanged = next.device.domain !== before.device.domain
      || next.device.gatewayPort !== before.device.gatewayPort;
    try {
      await this.applyStateProcesses(next, {
        startProcesses: configChanged,
        caddyOnlyIfConfigured: true,
      });
      this.saveState(next);
    } catch (error) {
      await this.restoreProcessState(before);
      throw error;
    }
    await this.gatewayStore.appendAudit("gateway.device.update", "success", {
      name: next.device.name,
      domain: next.device.domain,
      gatewayPort: next.device.gatewayPort,
      ipv6Mode: next.device.ipv6Mode,
    });
    if (configChanged) await this.syncDns({ force: true, reason: "device-update" }).catch(() => undefined);
    if (next.device.autoStart && !this.started) {
      await this.startAll({ respectAutoStart: true }).catch(() => undefined);
    }
    await this.startScheduler();
    return this.getOverview();
  }

  async saveCloudflareToken({ token, domain } = {}) {
    const state = this.requireInitialized();
    const plain = String(token || "").trim();
    if (!plain) throw new Error("Cloudflare Token 不能为空。");
    const deviceDomain = normalizeDomain(domain || state.device.domain);
    if (!deviceDomain) throw new Error("请先填写设备域名。");
    const verify = await this.dns.verifyToken(plain, deviceDomain);
    const encryptedToken = await this.credentialStore.protect(plain);
    const before = clone(state);
    const next = clone(state);
    next.device.domain = deviceDomain;
    next.device.updatedAt = nowIso();
    next.cloudflare.encryptedToken = encryptedToken;
    next.cloudflare.zoneName = verify.zone.name;
    next.cloudflare.zoneId = verify.zone.id;
    next.cloudflare.lastError = "";
    try {
      this.saveState(next);
      await this.applyStateProcesses(next, {
        startProcesses: true,
        caddyOnlyIfConfigured: false,
      });
    } catch (error) {
      await this.restoreStateAndProcesses(before);
      await this.gatewayStore.appendAudit("cloudflare.token.save", "failed", {
        zone: verify.zone.name,
        error: error.message,
      });
      throw error;
    }
    let dnsResult;
    try {
      dnsResult = await this.syncDns({ force: true, reason: "token" });
    } catch (error) {
      await this.gatewayStore.appendAudit("cloudflare.token.save", "partial", {
        zone: verify.zone.name,
        dnsError: error.message,
      });
      await this.startScheduler();
      throw error;
    }
    await this.gatewayStore.appendAudit("cloudflare.token.save", "success", {
      zone: verify.zone.name,
    });
    await this.startScheduler();
    return {
      verify,
      dns: dnsResult,
      overview: await this.getOverview(),
    };
  }

  async addService(payload = {}) {
    const state = this.requireInitialized();
    if (!state.device.domain) throw new Error("请先设置设备域名。");
    const kind = String(payload.kind || "http").toLowerCase();
    const service = normalizeService({
      ...payload,
      kind,
      enabled: payload.enabled !== false,
    });
    const next = clone(state);
    next.services.push(service);
    validateServiceSet(next, { adminPort: this.adminPort });
    await this.applyServiceChange(state, next, {
      caddy: kind === "http",
      frpc: kind === "udp" || kind === "tcp",
    });
    await this.gatewayStore.appendAudit("gateway.service.add", "success", {
      id: service.id,
      kind: service.kind,
      name: service.name,
      localPort: service.localPort,
      remotePort: service.remotePort,
    });
    return { service, overview: await this.getOverview() };
  }

  async updateService(serviceId, payload = {}) {
    const state = this.requireInitialized();
    const index = state.services.findIndex((item) => item.id === serviceId);
    if (index < 0) throw new Error("服务不存在。");
    const previous = state.services[index];
    const service = normalizeService({
      ...payload,
      kind: previous.kind,
      name: payload.name ?? previous.name,
      localPort: payload.localPort ?? previous.localPort,
      remotePort: payload.remotePort ?? previous.remotePort,
      enabled: payload.enabled === undefined ? previous.enabled : payload.enabled,
    }, previous);
    const next = clone(state);
    next.services[index] = service;
    validateServiceSet(next, { adminPort: this.adminPort });
    await this.applyServiceChange(state, next, {
      caddy: service.kind === "http",
      frpc: service.kind === "udp" || service.kind === "tcp",
    });
    await this.gatewayStore.appendAudit("gateway.service.update", "success", {
      id: service.id,
      kind: service.kind,
      name: service.name,
      enabled: service.enabled,
    });
    return { service, overview: await this.getOverview() };
  }

  async deleteService(serviceId) {
    const state = this.requireInitialized();
    const service = state.services.find((item) => item.id === serviceId);
    if (!service) throw new Error("服务不存在。");
    const next = clone(state);
    next.services = next.services.filter((item) => item.id !== serviceId);
    validateServiceSet(next, { adminPort: this.adminPort });
    await this.applyServiceChange(state, next, {
      caddy: service.kind === "http",
      frpc: service.kind === "udp" || service.kind === "tcp",
    });
    await this.gatewayStore.appendAudit("gateway.service.delete", "success", {
      id: service.id,
      kind: service.kind,
      name: service.name,
    });
    return this.getOverview();
  }

  async applyServiceChange(before, next, { caddy = false, frpc = false } = {}) {
    const warnings = [];
    try {
      await this.relays.reconcile(next);
      if (caddy) {
        await this.applyCaddyState(next);
      }
      if (frpc) {
        await this.applyFrpcState(next);
      }
      this.saveState(next);
    } catch (error) {
      await this.restoreProcessState(before);
      await this.gatewayStore.appendAudit("gateway.service.change", "failed", {
        error: error.message,
      });
      throw error;
    }
    return warnings;
  }

  async updateSsh(payload = {}) {
    const state = this.requireInitialized();
    const before = clone(state);
    const next = clone(state);
    next.ssh = normalizeSsh({ ...state.ssh, ...payload });
    validateServiceSet(next, { adminPort: this.adminPort });
    await this.applyServiceChange(state, next, { frpc: true });
    await this.gatewayStore.appendAudit("gateway.ssh.update", "success", {
      enabled: next.ssh.enabled,
      localPort: next.ssh.localPort,
      remotePort: next.ssh.remotePort,
    });
    return this.getOverview();
  }

  sourceCheckIntervalMs(state = this.readState()) {
    return Math.max(
      MIN_SOURCE_CHECK_INTERVAL_MS,
      Number(state.settings?.sourceCheckIntervalMs) || DEFAULT_SOURCE_CHECK_INTERVAL_MS
    );
  }

  async refreshSourceIfDue(state) {
    if (!state?.source?.legacyInstanceId) {
      return { skipped: true, reason: "no-source" };
    }
    const now = Date.now();
    const failure = this.sourceSyncFailure;
    if (failure && failure.retryAt > now) {
      return { skipped: true, reason: "backoff" };
    }
    const intervalMs = this.sourceCheckIntervalMs(state);
    if (this.lastSourceCheckAt && now - this.lastSourceCheckAt < intervalMs) {
      return { skipped: true, reason: "not-due" };
    }
    this.lastSourceCheckAt = now;
    return this.syncSourceConfig({ automatic: true });
  }

  async syncSourceConfig({ automatic = false } = {}) {
    const state = this.requireInitialized();
    if (!state.source.legacyInstanceId) throw new Error("没有可同步的连接来源。");
    if (this.sourceSyncRunning) {
      return {
        changed: false,
        skipped: true,
        reason: "running",
        ...(automatic ? {} : { overview: await this.getOverview() }),
      };
    }
    this.sourceSyncRunning = true;
    const action = automatic ? "gateway.source.auto-sync" : "gateway.source.sync";
    try {
      const result = await this.syncService.syncInstance(state.source.legacyInstanceId, {
        restartOnChange: false,
      });
      await this.applyFrpcState(state);
      const finishedAt = nowIso();
      const previousRuntime = this.gatewayStore.readRuntime();
      this.gatewayStore.saveRuntime({
        source: {
          lastCheckAt: finishedAt,
          lastSuccessAt: finishedAt,
          lastChangedAt: result.changed ? finishedAt : previousRuntime.source.lastChangedAt,
          lastError: "",
          intervalMs: this.sourceCheckIntervalMs(state),
        },
      });
      this.sourceSyncFailure = null;
      this.lastSourceCheckAt = Date.now();
      await this.gatewayStore.appendAudit(action, "success", {
        changed: result.changed,
        runtimeAction: result.runtimeAction,
      });
      return {
        changed: result.changed,
        runtimeAction: result.runtimeAction,
        ...(automatic ? {} : { overview: await this.getOverview() }),
      };
    } catch (error) {
      const previousFailure = this.sourceSyncFailure;
      const failureCount = (previousFailure?.count || 0) + 1;
      const intervalMs = this.sourceCheckIntervalMs(state);
      const exponentialDelay = Math.min(intervalMs * (2 ** (failureCount - 1)), MAX_SOURCE_SYNC_BACKOFF_MS);
      const retryDelay = Math.min(
        Math.max(exponentialDelay, Number(error.retryAfterMs) || 0),
        MAX_SOURCE_SYNC_BACKOFF_MS
      );
      this.sourceSyncFailure = {
        count: failureCount,
        retryAt: Date.now() + retryDelay,
        message: error.message,
      };
      const failedAt = nowIso();
      this.gatewayStore.saveRuntime({
        source: {
          lastCheckAt: failedAt,
          lastError: error.message,
          intervalMs,
        },
      });
      await this.gatewayStore.appendAudit(action, "failed", { error: error.message });
      if (this.logger?.warn && (!previousFailure || previousFailure.message !== error.message)) {
        await this.logger.warn(
          `88FRP 来源自动同步失败，将在约 ${Math.ceil(retryDelay / 60_000)} 分钟后重试：${error.message}`
        );
      }
      throw error;
    } finally {
      this.sourceSyncRunning = false;
    }
  }

  async syncDns(options = {}) {
    const task = this.dnsSyncQueue.catch(() => {}).then(() => this.syncDnsInternal(options));
    this.dnsSyncQueue = task.catch(() => {});
    return task;
  }

  async syncDnsInternal({ force = false, reason = "manual" } = {}) {
    const state = this.requireInitialized();
    if (!state.device.domain) throw new Error("尚未设置设备域名。");
    if (!state.cloudflare.encryptedToken) throw new Error("尚未授权 Cloudflare。");
    const token = await this.decryptCloudflareToken(state);
    if (!state.cloudflare.zoneId) {
      const zone = await this.dns.discoverZone(token, state.device.domain);
      state.cloudflare.zoneName = zone.name;
      state.cloudflare.zoneId = zone.id;
      this.saveState(state);
    }
    let ipv4 = "";
    try {
      ipv4 = await this.resolveNodeIpv4(state);
    } catch (error) {
      state.cloudflare.lastCheckAt = nowIso();
      state.cloudflare.lastError = error.message;
      this.saveState(state);
      await this.gatewayStore.appendAudit("cloudflare.dns.sync", "failed", {
        reason,
        error: error.message,
      });
      throw error;
    }
    let ipv6 = "";
    if (state.device.ipv6Mode === "manual") ipv6 = state.device.manualIpv6;
    else {
      const detected = await this.ipv6Provider.detect({
        previousAddress: state.cloudflare.lastTarget?.ipv6 || "",
      });
      ipv6 = detected.address || "";
    }
    const target = {
      domain: state.device.domain,
      zoneName: state.cloudflare.zoneName,
      ipv4,
      ipv6,
    };
    if (!force && sameDnsTarget(state.cloudflare.lastTarget, target) && !state.cloudflare.lastError) {
      return { skipped: true, reason: "unchanged", target };
    }
    const desired = desiredDnsRecords(state, {
      ipv4,
      ipv6,
      zoneName: state.cloudflare.zoneName,
    });
    if (!desired.length) throw new Error("没有可发布的 DNS 记录，请检查设备域名和网络。");
    const cleanupDomains = new Set(
      [state.device.domain, state.cloudflare.lastTarget?.domain]
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const cleanupNames = [...cleanupDomains].flatMap((domain) => [
      domain,
      `*.${domain}`,
      `v6.${domain}`,
      `v4.${domain}`,
      `ssh-v6.${domain}`,
      `ssh-v4.${domain}`,
    ]);
    const result = await this.dns.syncRecords({
      token,
      zoneId: state.cloudflare.zoneId,
      desiredRecords: desired,
      managedRecordIds: state.cloudflare.managedRecordIds,
      allowedNames: cleanupNames,
    });
    const now = nowIso();
    const latest = this.readState();
    latest.cloudflare.lastCheckAt = now;
    latest.cloudflare.lastSyncAt = now;
    latest.cloudflare.lastTarget = target;
    latest.cloudflare.lastSummary = {
      desired: desired.length,
      changed: result.results.filter((item) => ["created", "updated", "deleted"].includes(item.action)).length,
      deleted: result.results.filter((item) => item.action === "deleted").length,
      conflicts: result.conflicts.length,
      cleanupSkipped: (result.cleanupSkipped || []).length,
    };
    latest.cloudflare.managedRecordIds = result.managedRecordIds;
    latest.cloudflare.lastError = groupCloudflareWarning(result.conflicts);
    this.saveState(latest);
    this.gatewayStore.saveRuntime({
      scheduler: {
        lastTickAt: now,
        lastSuccessAt: now,
        lastError: latest.cloudflare.lastError,
        ipv6Address: ipv6,
        nodeIpv4: ipv4,
      },
    });
    await this.gatewayStore.appendAudit("cloudflare.dns.sync", result.conflicts.length ? "partial" : "success", {
      reason,
      records: desired.map((item) => `${item.type} ${item.fqdn} -> ${item.content}`),
      actions: result.results.map((item) => `${item.key}:${item.action}`),
      cleaned: result.results
        .filter((item) => item.action === "deleted")
        .map((item) => `${item.type} ${item.fqdn}`),
      conflicts: result.conflicts.map((item) => item.message),
      cleanupSkipped: (result.cleanupSkipped || []).map((item) => item.message),
    });
    if (result.conflicts.length) {
      const error = new Error(groupCloudflareWarning(result.conflicts));
      error.summary = latest.cloudflare.lastSummary;
      throw error;
    }
    return {
      skipped: false,
      target,
      summary: latest.cloudflare.lastSummary,
      records: result.results,
    };
  }

  async resolveNodeIpv4(state) {
    const configText = await this.store.readConfig(state.source.legacyInstanceId);
    if (!configText.trim()) throw new Error("连接来源配置不存在，请先同步 88FRP 配置。");
    const serverAddr = parseFrpcServerAddr(configText);
    if (!serverAddr) throw new Error("连接来源缺少 serverAddr。");
    if (net.isIP(serverAddr) === 4) return serverAddr;
    if (net.isIP(serverAddr) === 6) throw new Error("88FRP 节点当前只有 IPv6 地址，无法生成 IPv4 备用 A 记录。");
    const addresses = await this.resolveIPv4(serverAddr);
    if (!addresses || !addresses.length) throw new Error(`无法解析 88FRP 节点 IPv4：${serverAddr}`);
    return addresses[0];
  }

  async decryptCloudflareToken(state = this.readState()) {
    if (!state.cloudflare.encryptedToken) return "";
    try {
      return await this.credentialStore.unprotect(state.cloudflare.encryptedToken, {
        rawDpapi: !state.cloudflare.encryptedToken.startsWith("machine:"),
      });
    } catch {
      throw new Error("Cloudflare 凭据无法解密，请重新授权 Token。");
    }
  }

  async applyStateProcesses(state, {
    startProcesses = true,
    caddyOnlyIfConfigured = false,
  } = {}) {
    const warnings = [];
    await this.relays.reconcile(state);
    if (state.device.domain && state.cloudflare.encryptedToken) {
      try {
        await this.applyCaddyState(state, { startProcess: startProcesses });
      } catch (error) {
    warnings.push(`网页访问：${error.message}`);
        if (!caddyOnlyIfConfigured) throw error;
      }
    } else if (this.caddy.getStatus().status === "running") {
      await this.caddy.stop().catch(() => undefined);
      warnings.push("尚未完成域名和 Cloudflare 授权，网页访问已暂停。");
    }
    try {
      await this.applyFrpcState(state, { startProcess: startProcesses });
    } catch (error) {
      warnings.push(`88FRP 隧道：${error.message}`);
    }
    return { warnings };
  }

  async applyCaddyState(state, { startProcess = true } = {}) {
    if (!state.device.domain) throw new Error("尚未设置设备域名。");
    if (!state.cloudflare.encryptedToken) throw new Error("尚未授权 Cloudflare。");
    const token = await this.decryptCloudflareToken(state);
    const configText = buildCaddyfile(state, {
      adminPort: this.adminPort,
      storageDir: this.gatewayStore.caddyStorageDir,
      accessLogPath: this.gatewayStore.caddyAccessLogPath,
    });
    if (!startProcess) {
      this.gatewayStore.writeCaddyfile(configText);
      return { changed: true, started: false };
    }
    return this.caddy.applyConfig(configText, { token });
  }

  async applyFrpcState(state, { startProcess = true } = {}) {
    const baseConfig = await this.store.readConfig(state.source.legacyInstanceId);
    if (!baseConfig.trim()) throw new Error("连接来源配置不存在。");
    const tunnelNames = buildTunnelNameMap(parseFrpcTunnels(baseConfig));
    const configText = buildFrpcConfig(baseConfig, state, { tunnelNames });
    if (!startProcess) {
      this.gatewayStore.writeFrpcConfig(configText);
      return { changed: true, started: false };
    }
    return this.frpc.applyConfig(configText, { startIfChanged: true });
  }

  async restoreProcessState(state) {
    await this.relays.reconcile(state).catch(async (error) => {
      await this.gatewayStore.appendAudit("gateway.rollback.relays", "failed", { error: error.message });
    });
    if (state.device.domain && state.cloudflare.encryptedToken) {
      try {
        await this.applyCaddyState(state);
      } catch (error) {
        await this.gatewayStore.appendAudit("gateway.rollback.caddy", "failed", { error: error.message });
      }
    } else {
      await this.caddy.stop().catch(() => undefined);
    }
    try {
      if (state.source.legacyInstanceId) await this.applyFrpcState(state);
    } catch (error) {
      await this.gatewayStore.appendAudit("gateway.rollback.frpc", "failed", { error: error.message });
    }
  }

  async restoreStateAndProcesses(snapshot) {
    try {
      this.saveState(snapshot);
    } catch (error) {
      await this.gatewayStore.appendAudit("gateway.rollback.state", "failed", {
        error: error.message,
      });
    }
    if (!snapshot.initialized) {
      const results = await Promise.allSettled([this.caddy.stop(), this.frpc.stop(), this.relays.stopAll()]);
      const failures = results.filter((item) => item.status === "rejected");
      if (failures.length) {
        await this.gatewayStore.appendAudit("gateway.rollback.processes", "failed", {
          error: failures.map((item) => item.reason?.message).filter(Boolean).join("；"),
        });
      }
      return;
    }
    await this.restoreProcessState(snapshot);
  }

  async startAll({ respectAutoStart = false } = {}) {
    const state = this.readState();
    if (!state.initialized) return { started: false };
    if (respectAutoStart && !state.device.autoStart) {
      await this.gatewayStore.appendAudit("gateway.start", "skipped", {
        reason: "autoStart-disabled",
      });
      return { started: false, skipped: true, reason: "autoStart-disabled", warnings: [] };
    }
    const applied = await this.applyStateProcesses(state, {
      startProcesses: true,
      caddyOnlyIfConfigured: true,
    });
    await this.startScheduler();
    this.started = true;
    await this.gatewayStore.appendAudit("gateway.start", applied.warnings.length ? "partial" : "success", {
      warnings: applied.warnings,
    });
    return {
      started: true,
      warnings: applied.warnings,
    };
  }

  async stopAll() {
    this.stopScheduler();
    const results = await Promise.allSettled([
      this.caddy.stop(),
      this.frpc.stop(),
      this.relays.stopAll(),
    ]);
    this.started = false;
    await this.gatewayStore.appendAudit("gateway.stop", "success", {
      failures: results.filter((item) => item.status === "rejected").length,
    });
  }

  async restartRuntime() {
    const state = this.requireInitialized();
    const before = clone(state);
    try {
      await this.caddy.stop().catch(() => undefined);
      await this.frpc.stop().catch(() => undefined);
      await this.relays.stopAll().catch(() => undefined);
      const applied = await this.applyStateProcesses(state, { startProcesses: true });
      this.started = true;
      await this.startScheduler();
      await this.gatewayStore.appendAudit("gateway.runtime.restart", applied.warnings.length ? "partial" : "success", {
        warnings: applied.warnings,
      });
      return { overview: await this.getOverview(), warnings: applied.warnings };
    } catch (error) {
      await this.restoreProcessState(before);
      throw error;
    }
  }

  async openFirewall() {
    const state = this.requireInitialized();
    const tcpPorts = state.services
      .filter((service) => service.kind === "tcp" && service.enabled)
      .map((service) => service.remotePort);
    const udpPorts = state.services
      .filter((service) => service.kind === "udp" && service.enabled)
      .map((service) => service.remotePort);
    const result = await this.firewall.ensureRules({
      gatewayPort: state.device.gatewayPort,
      sshEnabled: state.ssh.enabled,
      sshPublicPort: state.ssh.remotePort,
      tcpPublicPorts: tcpPorts,
      udpPublicPorts: udpPorts,
    });
    state.settings.firewallManaged = true;
    this.saveState(state);
    await this.gatewayStore.appendAudit("gateway.firewall.open", "success", result);
    return {
      ...result,
      overview: await this.getOverview(),
    };
  }

  async getLogs(lineLimit = 200) {
    return this.gatewayStore.readLogs(lineLimit);
  }

  requireInitialized() {
    const state = this.readState();
    if (!state.initialized) throw new Error("统一入口尚未初始化，请先导入连接来源。");
    return state;
  }

  async startScheduler() {
    const state = this.readState();
    if (!state.initialized) return;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    const interval = Math.max(MIN_DNS_CHECK_INTERVAL_MS, Number(state.settings.dnsCheckIntervalMs) || MIN_DNS_CHECK_INTERVAL_MS);
    this.schedulerTimer = setInterval(() => {
      this.schedulerTick().catch(() => undefined);
    }, interval);
    if (typeof this.schedulerTimer.unref === "function") this.schedulerTimer.unref();
  }

  stopScheduler() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  async schedulerTick() {
    if (this.schedulerRunning) return { skipped: true };
    this.schedulerRunning = true;
    try {
      const state = this.readState();
      if (!state.initialized) return { skipped: true };
      try {
        await this.relays.reconcile(state);
      } catch (error) {
        await this.gatewayStore.appendAudit("relay.recover", "failed", {
          error: error.message,
        });
      }
      try {
        await this.refreshSourceIfDue(state);
      } catch {
        // syncSourceConfig records the failure and backoff; DNS and process
        // recovery must continue with the last known-good source config.
      }
      await this.ensureProcessRunning("caddy", async () => {
        if (!state.device.domain || !state.cloudflare.encryptedToken) return;
        if (state.cloudflare.encryptedToken) {
          const token = await this.decryptCloudflareToken(state);
          this.caddy.setToken(token);
        }
        if (!this.gatewayStore.readCaddyfile()) await this.applyCaddyState(state);
        else await this.caddy.start();
      });
      await this.ensureProcessRunning("frpc", async () => {
        if (!this.gatewayStore.readFrpcConfig()) await this.applyFrpcState(state);
        else await this.frpc.start();
      });
      if (state.device.domain && state.cloudflare.encryptedToken) {
        try {
          await this.syncDns({ force: false, reason: "scheduler" });
        } catch (error) {
          const runtime = this.gatewayStore.readRuntime();
          this.gatewayStore.saveRuntime({
            scheduler: {
              lastTickAt: nowIso(),
              lastError: error.message,
              ipv6Address: runtime.scheduler.ipv6Address,
              nodeIpv4: runtime.scheduler.nodeIpv4,
            },
          });
        }
      }
      return { ok: true };
    } finally {
      this.schedulerRunning = false;
    }
  }

  async ensureProcessRunning(name, startFn) {
    const statusKey = name === "caddy" ? "caddy" : "frpc";
    const status = name === "caddy" ? this.caddy.getStatus() : this.frpc.getStatus();
    if (status.status === "running" && status.pid && isPidAlive(status.pid)) return;
    const backoff = this.failureBackoff.get(name);
    if (backoff && backoff.nextAt > Date.now()) return;
    try {
      await startFn();
      this.failureBackoff.delete(name);
    } catch (error) {
      this.failureBackoff.set(name, {
        nextAt: Date.now() + 15_000,
        message: error.message,
      });
      await this.gatewayStore.appendAudit(`${statusKey}.recover`, "failed", {
        error: error.message,
      });
    }
  }

  async activeLegacyInstanceIds() {
    const instances = await this.store.listInstances();
    return instances
      .filter((instance) => {
        const runtime = instance.runtime || {};
        const alive = runtime.pid && typeof this.processManager.checkPid === "function"
          ? this.processManager.checkPid(runtime.pid)
          : false;
        return alive || ["running", "starting", "reconnecting"].includes(runtime.status);
      })
      .map((instance) => instance.id);
  }

  async restoreLegacyInstances(instanceIds, originalError) {
    for (const instanceId of instanceIds) {
      try {
        const instance = await this.store.getInstance(instanceId);
        if (!instance || !instance.hasConfig) continue;
        const runtime = instance.runtime || {};
        if (runtime.pid && typeof this.processManager.checkPid === "function"
          && this.processManager.checkPid(runtime.pid)) continue;
        await this.processManager.start(instance);
        await this.gatewayStore.appendAudit("gateway.migrate.rollback.instance", "success", {
          instanceId,
          instanceName: instance.name,
        });
      } catch (error) {
        await this.gatewayStore.appendAudit("gateway.migrate.rollback.instance", "failed", {
          instanceId,
          originalError: originalError?.message || "",
          error: error.message,
        });
      }
    }
  }
}

function validateStateForWriteSafe(state) {
  if (!state || typeof state !== "object") throw new Error("网关状态无效。");
  if (!state.device?.name) throw new Error("设备名称不能为空。");
  if (!state.source?.legacyInstanceId) throw new Error("连接来源不能为空。");
  return true;
}

function friendlyRuntimeError(value) {
  const text = String(value || "");
  if (!text) return "";
  if (/发现旧\s*(Caddy|frpc)\s*进程\s*PID=\d+/.test(text)) {
    return "检测到一个旧的后台进程，但无法确认归属；为避免影响其他程序，已停止自动启动。";
  }
  return text
    .replace(/发现旧\s*Caddy\s*进程\s*PID=\d+[，,]\s*/g, "")
    .replace(/发现旧\s*frpc\s*进程\s*PID=\d+[，,]\s*/g, "")
    .replace(/\s*PID=\d+/g, "");
}

module.exports = {
  GatewayService,
  isLoopbackAddress,
  normalizeIp,
  probeTcp,
  safeDomainFromBinding,
};
