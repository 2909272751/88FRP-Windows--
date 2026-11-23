const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../src/core/store");
const { GatewayService } = require("../src/core/gateway/gateway-service");
const { DEFAULT_STATE, clone, normalizeState } = require("../src/core/gateway/gateway-model");

function createFakes() {
  const caddy = {
    failNext: false,
    applied: [],
    stopped: 0,
    status: { status: "stopped", pid: null, lastError: "" },
    getStatus() {
      return {
        ...this.status,
        binary: { path: "C:\\tools\\caddy.exe", exists: true },
      };
    },
    getVersion: async () => "v2.10.0",
    setToken() {},
    async applyConfig(text) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("caddy failed");
      }
      this.applied.push(text);
      this.status = { status: "running", pid: 100, lastError: "" };
      return { changed: true, started: true };
    },
    async stop() {
      this.stopped += 1;
      this.status = { status: "stopped", pid: null, lastError: "" };
    },
    async start() {
      this.status = { status: "running", pid: 100, lastError: "" };
    },
  };
  const frpc = {
    failNext: false,
    applied: [],
    stopped: 0,
    status: { status: "stopped", pid: null, lastError: "" },
    getStatus() {
      return {
        ...this.status,
        binary: { path: "C:\\tools\\88frpc.exe", exists: true },
      };
    },
    async applyConfig(text) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("frpc failed");
      }
      this.applied.push(text);
      this.status = { status: "running", pid: 200, lastError: "" };
      return { changed: true };
    },
    async stop() {
      this.stopped += 1;
      this.status = { status: "stopped", pid: null, lastError: "" };
    },
    async start() {
      this.status = { status: "running", pid: 200, lastError: "" };
    },
  };
  const dns = {
    syncError: null,
    writes: 0,
    async discoverZone() {
      return { id: "zone-id", name: "example.com" };
    },
    async verifyToken() {
      return { ok: true, zone: { id: "zone-id", name: "example.com" }, checks: [] };
    },
    async syncRecords({ desiredRecords }) {
      this.writes += 1;
      if (this.syncError) throw this.syncError;
      return {
        applied: false,
        conflicts: [],
        results: desiredRecords.map((item) => ({ key: item.key, action: "unchanged", recordId: `${item.key}-id`, managed: true })),
        managedRecordIds: Object.fromEntries(desiredRecords.map((item) => [item.key, `${item.key}-id`])),
      };
    },
  };
  const credentialStore = {
    async protect(value) { return `protected:${value}`; },
    async unprotect(value) { return String(value).replace(/^protected:/, ""); },
  };
  const processManager = {
    stopAllCalls: 0,
    startCalls: 0,
    async stopAll() { this.stopAllCalls += 1; },
    checkPid() { return false; },
    async start() { this.startCalls += 1; return { status: "running" }; },
  };
  const instanceService = {
    updates: [],
    async get(id) { return { id, name: "旧实例" }; },
    async update(id, payload) {
      this.updates.push({ id, payload });
      return { id, name: "旧实例", ...payload };
    },
  };
  const tunnelService = {
    async list() { return { tunnels: [] }; },
  };
  const domainBindingService = {
    read() { return null; },
  };
  const ipv6Provider = {
    async detect() {
      return {
        address: "2408:8207:1234:5678:9abc:def0:1234:5678",
        interfaceName: "以太网",
        candidates: [],
        warning: "",
      };
    },
  };
  const firewallService = {
    async getStatus() { return { supported: true, tcpRule: false, udpRule: false }; },
    async ensureRules() { return { tcpPorts: [7777], udpPorts: [], rules: [] }; },
  };
  const relayManager = {
    states: [],
    statuses: [],
    stopped: 0,
    async reconcile(state) { this.states.push(state); },
    getStatus() { return this.statuses; },
    async stopAll() { this.stopped += 1; this.statuses = []; },
  };
  const logger = { info() {}, warn() {}, error() {} };
  return {
    caddy,
    frpc,
    dns,
    credentialStore,
    processManager,
    instanceService,
    tunnelService,
    domainBindingService,
    ipv6Provider,
    firewallService,
    relayManager,
    logger,
  };
}

async function withService(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-gateway-service-"));
  const store = new Store({ dataDir });
  await store.initialize();
  await store.saveConfig("legacy", '[common]\nserverAddr = "203.0.113.7"\nserverPort = 7000\n');
  const fakes = createFakes();
  const service = new GatewayService({
    store,
    logger: fakes.logger,
    credentialStore: fakes.credentialStore,
    processManager: fakes.processManager,
    instanceService: fakes.instanceService,
    tunnelService: fakes.tunnelService,
    domainBindingService: fakes.domainBindingService,
    syncService: {},
    caddyManager: fakes.caddy,
    frpcManager: fakes.frpc,
    dnsService: fakes.dns,
    ipv6Provider: fakes.ipv6Provider,
    firewallService: fakes.firewallService,
    relayManager: fakes.relayManager,
    frpcBinaryPath: "C:\\tools\\88frpc.exe",
    caddyBinaryPath: "C:\\tools\\caddy.exe",
    adminPort: 8801,
  });
  await service.initialize();
  try {
    await run({ service, store, fakes });
  } finally {
    service.stopScheduler();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function initializedState() {
  const now = new Date().toISOString();
  return normalizeState({
    ...clone(DEFAULT_STATE),
    initialized: true,
    migratedAt: now,
    device: {
      ...DEFAULT_STATE.device,
      name: "XPS",
      domain: "xps.example.com",
      gatewayPort: 7777,
      createdAt: now,
      updatedAt: now,
    },
    source: {
      legacyInstanceId: "legacy",
      migratedInstanceName: "旧实例",
      createdAt: now,
      updatedAt: now,
    },
    cloudflare: {
      ...DEFAULT_STATE.cloudflare,
      encryptedToken: "protected:old-token",
      zoneName: "example.com",
      zoneId: "zone-id",
    },
  });
}

test("Cloudflare 授权在 Caddy 启动失败时恢复旧状态与旧进程配置", async () => {
  await withService(async ({ service, fakes }) => {
    service.saveState(initializedState());
    fakes.caddy.failNext = true;
    await assert.rejects(
      service.saveCloudflareToken({ token: "new-token", domain: "xps.example.com" }),
      /caddy failed/
    );
    const state = service.readState();
    assert.equal(state.device.domain, "xps.example.com");
    assert.equal(state.cloudflare.encryptedToken, "protected:old-token");
    assert.equal(fakes.dns.writes, 0);
    assert.ok(fakes.caddy.applied.length >= 1);
  });
});

test("迁移失败时不会让设备卡在已初始化但不可用的状态", async () => {
  await withService(async ({ service, fakes }) => {
    fakes.domainBindingService.read = () => ({
      zone: "example.com",
      encryptedToken: "protected:token",
      ttl: 60,
    });
    fakes.caddy.failNext = true;
    await assert.rejects(
      service.migrate({
        instanceId: "legacy",
        name: "XPS",
        domain: "xps.example.com",
        gatewayPort: 7777,
        importServices: false,
      }),
      /caddy failed/
    );
    const state = service.readState();
    assert.equal(state.initialized, false);
    assert.equal(fakes.processManager.stopAllCalls, 1);
    assert.ok(fakes.caddy.stopped >= 1);
    assert.ok(fakes.frpc.stopped >= 1);
  });
});

test("迁移时从旧授权恢复 Cloudflare Zone ID 并立即写入 DNS", async () => {
  await withService(async ({ service, fakes }) => {
    let discovered = "";
    fakes.domainBindingService.read = () => ({
      zone: "example.com",
      encryptedToken: "protected:token",
      ttl: 60,
    });
    fakes.dns.discoverZone = async (_token, domain) => {
      discovered = domain;
      return { id: "zone-id", name: "example.com" };
    };
    await service.migrate({
      instanceId: "legacy",
      name: "XPS",
      domain: "xps.example.com",
      gatewayPort: 7777,
      importServices: false,
    });
    const state = service.readState();
    assert.equal(discovered, "xps.example.com");
    assert.equal(state.cloudflare.zoneId, "zone-id");
    assert.equal(state.cloudflare.zoneName, "example.com");
    assert.equal(fakes.dns.writes, 1);
    assert.equal(state.cloudflare.lastTarget.domain, "xps.example.com");
  });
});

test("迁移旧 RDP 隧道为 TCP 直通并关闭旧实例自启动", async () => {
  await withService(async ({ service, fakes }) => {
    fakes.tunnelService.list = async () => ({
      tunnels: [
        {
          name: "xps-rdp",
          displayName: "XPS 电脑",
          type: "tcp",
          localPort: 3389,
          remotePort: 64540,
          enabled: true,
        },
        {
          name: "xps-web",
          displayName: "XPS Web",
          type: "tcp",
          localPort: 8080,
          remotePort: 18080,
          enabled: true,
        },
      ],
    });
    await service.migrate({
      instanceId: "legacy",
      name: "XPS",
      domain: "xps.example.com",
      gatewayPort: 7777,
      importServices: true,
    });
    const state = service.readState();
    const rdp = state.services.find((item) => item.localPort === 3389);
    assert.equal(rdp.kind, "tcp");
    assert.equal(rdp.remotePort, 64540);
    assert.equal(state.services.find((item) => item.localPort === 8080).kind, "http");
    assert.deepEqual(fakes.instanceService.updates[0], {
      id: "legacy",
      payload: { autoStartEnabled: false, autoSyncEnabled: false },
    });
  });
});

test("授权已验证但 DNS 写失败时保留 Token，交给调度器继续重试", async () => {
  await withService(async ({ service, fakes }) => {
    service.saveState(initializedState());
    fakes.dns.syncError = new Error("cloudflare temporary failure");
    await assert.rejects(
      service.saveCloudflareToken({ token: "new-token", domain: "xps.example.com" }),
      /cloudflare temporary failure/
    );
    const state = service.readState();
    assert.equal(state.cloudflare.encryptedToken, "protected:new-token");
    assert.equal(state.initialized, true);
    assert.equal(fakes.dns.writes, 1);
    assert.ok(service.schedulerTimer);
  });
});

test("未初始化时总览不调用 IPv6 探测命令", async () => {
  await withService(async ({ service, fakes }) => {
    let detects = 0;
    fakes.ipv6Provider.detect = async () => {
      detects += 1;
      return { address: "", interfaceName: "", candidates: [], warning: "" };
    };
    const overview = await service.getOverview({ includeHealth: false });
    assert.equal(overview.initialized, false);
    assert.equal(detects, 0);
  });
});

test("快速总览复用上次 IPv6 且不执行本机健康探测", async () => {
  await withService(async ({ service }) => {
    const state = initializedState();
    state.ssh = { enabled: true, localHost: "127.0.0.1", localPort: 22, remotePort: 50258 };
    state.services = [{
      id: "quick-service",
      kind: "http",
      name: "quick",
      title: "快速服务",
      tag: "网页",
      description: "",
      localHost: "127.0.0.1",
      localPort: 3000,
      remotePort: 0,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }];
    state.cloudflare.lastTarget = {
      domain: "xps.example.com",
      ipv4: "203.0.113.7",
      ipv6: "2408:8207:1234:5678:9abc:def0:1234:5678",
      zoneName: "example.com",
    };
    service.saveState(state);

    let probes = 0;
    let detects = 0;
    service.probeTcp = async () => { probes += 1; return true; };
    service.ipv6Provider.detect = async () => {
      detects += 1;
      return { address: "2408:8207::2", interfaceName: "以太网", candidates: [], warning: "" };
    };

    const overview = await service.getOverview({ includeHealth: false });
    assert.equal(probes, 0);
    assert.equal(detects, 0);
    assert.equal(overview.device.ipv6Detected.address, "2408:8207:1234:5678:9abc:def0:1234:5678");
    assert.equal(overview.services[0].online, null);
  });
});

test("迁移失败后会恢复迁移前正在运行的旧实例", async () => {
  await withService(async ({ service, store, fakes }) => {
    const instance = await store.createInstance({
      name: "运行中的旧实例",
      secretKey: "test",
      autoStartEnabled: false,
      autoSyncEnabled: false,
    });
    await store.saveConfig(instance.id, '[common]\nserverAddr = "203.0.113.7"\nserverPort = 7000\n');
    await store.saveRuntime(instance.id, {
      status: "running",
      pid: 4321,
      binaryPath: "C:\\tools\\88frpc.exe",
    });
    fakes.domainBindingService.read = () => ({
      zone: "example.com",
      encryptedToken: "protected:token",
      ttl: 60,
    });
    fakes.caddy.failNext = true;
    await assert.rejects(
      service.migrate({
        instanceId: instance.id,
        name: "XPS",
        domain: "xps.example.com",
        gatewayPort: 7777,
        importServices: false,
      }),
      /caddy failed/
    );
    assert.equal(fakes.processManager.startCalls, 1);
    const state = service.readState();
    assert.equal(state.initialized, false);
  });
});

test("手动与定时 DNS 同步串行执行，不会并发写 Cloudflare", async () => {
  await withService(async ({ service, fakes }) => {
    service.saveState(initializedState());
    let active = 0;
    let maximum = 0;
    const originalSync = fakes.dns.syncRecords.bind(fakes.dns);
    fakes.dns.syncRecords = async (payload) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 35));
      try {
        return await originalSync(payload);
      } finally {
        active -= 1;
      }
    };
    await Promise.all([
      service.syncDns({ force: true, reason: "test-manual" }),
      service.syncDns({ force: true, reason: "test-scheduler" }),
    ]);
    assert.equal(maximum, 1);
    assert.equal(fakes.dns.writes, 2);
  });
});

test("旧状态缺少 Zone ID 时，DNS 同步会先自动恢复再写入", async () => {
  await withService(async ({ service, fakes }) => {
    const state = initializedState();
    state.cloudflare.zoneId = "";
    service.saveState(state);
    let discovered = "";
    fakes.dns.discoverZone = async (_token, domain) => {
      discovered = domain;
      return { id: "recovered-zone-id", name: "example.com" };
    };
    await service.syncDns({ force: true, reason: "recovery" });
    const saved = service.readState();
    assert.equal(discovered, "xps.example.com");
    assert.equal(saved.cloudflare.zoneId, "recovered-zone-id");
    assert.equal(fakes.dns.writes, 1);
  });
});

test("关闭自动启动后，开机恢复入口会跳过 Caddy 与 frpc 启动", async () => {
  await withService(async ({ service, fakes }) => {
    const state = initializedState();
    state.device.autoStart = false;
    service.saveState(state);
    const appliedBefore = fakes.frpc.applied.length;
    const result = await service.startAll({ respectAutoStart: true });
    assert.equal(result.skipped, true);
    assert.equal(fakes.frpc.applied.length, appliedBefore);
    assert.equal(service.schedulerTimer, null);
  });
});

test("公开门户的 SSH 支持双栈，远程桌面优先域名反代并保留 IPv6 直连", async () => {
  await withService(async ({ service }) => {
    const state = initializedState();
    state.ssh = {
      enabled: true,
      localHost: "127.0.0.1",
      localPort: 22,
      remotePort: 50258,
    };
    const now = new Date().toISOString();
    state.services = [{
      id: "rdp-service",
      kind: "tcp",
      name: "xps-rdp",
      title: "远程桌面",
      tag: "远程桌面",
      description: "",
      localHost: "127.0.0.1",
      localPort: 3389,
      remotePort: 64540,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }];
    state.cloudflare.lastTarget = {
      domain: "xps.example.com",
      ipv4: "203.0.113.7",
      ipv6: "2408:8207:1234:5678:9abc:def0:1234:5678",
      zoneName: "example.com",
    };
    service.saveState(state);
    service.gatewayStore.saveRuntime({
      scheduler: {
        nodeIpv4: "203.0.113.7",
        ipv6Address: "2408:8207:1234:5678:9abc:def0:1234:5678",
      },
    });

    const portal = await service.getPublicPortal({ remoteAddress: "2408:8207::1", host: "xps.example.com" });
    assert.equal(portal.remoteAccess.ssh.enabled, true);
    assert.equal(portal.remoteAccess.ssh.port, 50258);
    assert.deepEqual(
      portal.remoteAccess.ssh.targets.map((item) => item.family),
      ["ipv6", "ipv4"]
    );
    assert.equal(portal.remoteAccess.ssh.targets[0].endpoint, "ssh-v6.xps.example.com:50258");
    assert.equal(portal.remoteAccess.ssh.targets[1].endpoint, "ssh-v4.xps.example.com:50258");
    assert.match(portal.remoteAccess.ssh.targets[0].command, /^ssh -p 50258 <用户名>@ssh-v6\.xps\.example\.com$/);
    assert.equal(portal.remoteAccess.ssh.endpoints.auto, "ssh.xps.example.com:50258");
    assert.equal(portal.remoteAccess.rdp.enabled, true);
    assert.deepEqual(portal.remoteAccess.rdp.targets.map((item) => item.family), ["auto", "ipv6", "ipv4"]);
    assert.equal(portal.remoteAccess.rdp.targets[0].endpoint, "xps.example.com:64540");
    assert.equal(portal.remoteAccess.rdp.targets[1].endpoint, "v6.xps.example.com:64540");
    assert.equal(portal.remoteAccess.rdp.targets[2].endpoint, "v4.xps.example.com:64540");
    assert.equal(portal.remoteAccess.rdp.tunnelPort, undefined);
    assert.equal(portal.remoteAccess.rdp.connectAddress, undefined);
    assert.doesNotMatch(JSON.stringify(portal), /13389|安全隧道|SSH 隧道/);
    assert.doesNotMatch(JSON.stringify(portal), /protected:old-token|encryptedToken/i);

    const overview = await service.getOverview({ includeHealth: false });
    assert.deepEqual(overview.device.publicEndpoints, {
      auto: "https://xps.example.com:7777",
      ipv6: "https://v6.xps.example.com:7777",
      ipv4: "https://v4.xps.example.com:7777",
    });
    assert.deepEqual(overview.ssh.endpoints, {
      auto: "ssh.xps.example.com:50258",
      ipv6: "ssh-v6.xps.example.com:50258",
      ipv4: "ssh-v4.xps.example.com:50258",
    });
    assert.deepEqual(overview.remoteAccess.rdp.targets.map((item) => item.family), ["auto", "ipv6", "ipv4"]);
    assert.equal(overview.remoteAccess.rdp.targets[1].endpoint, "v6.xps.example.com:64540");
    assert.equal(overview.remoteAccess.rdp.targets[2].endpoint, "v4.xps.example.com:64540");
  });
});

test("添加 TCP 远程桌面服务会同时更新 frpc 配置", async () => {
  await withService(async ({ service, fakes }) => {
    service.saveState(initializedState());
    const appliedBefore = fakes.frpc.applied.length;
    const result = await service.addService({
      kind: "tcp",
      name: "xps-rdp",
      title: "远程桌面",
      tag: "远程桌面",
      localHost: "127.0.0.1",
      localPort: 3389,
      remotePort: 64540,
      enabled: true,
    });
    assert.equal(result.service.kind, "tcp");
    const added = result.overview.services.find((item) => item.id === result.service.id);
    assert.equal(added.tcpEndpoint, "xps.example.com:64540");
    assert.ok(fakes.frpc.applied.length > appliedBefore);
    const config = fakes.frpc.applied[fakes.frpc.applied.length - 1];
    assert.match(config, /localPort = 64540/);
    assert.match(config, /remotePort = 64540/);
  });
});
