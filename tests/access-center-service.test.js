const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { EventEmitter } = require("node:events");

const { AccessCenterService, buildLink, createAccessCenterApp } = require("../src/core/access-center-service");
const { Store } = require("../src/core/store");
const { TunnelService } = require("../src/core/tunnel-service");

const credentialStore = {
  async protect(value) { return `protected:${Buffer.from(String(value), "utf8").toString("base64")}`; },
  async unprotect(value) {
    if (!String(value).startsWith("protected:")) return "";
    return Buffer.from(String(value).slice("protected:".length), "base64").toString("utf8");
  },
};

class FakeFrpcChild extends EventEmitter {
  constructor(pid, alive) {
    super();
    this.pid = pid;
    this.alive = alive;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    alive.add(pid);
  }

  start() {
    setImmediate(() => this.emit("spawn"));
  }

  crash(code = 1) {
    if (this.alive.delete(this.pid)) this.emit("close", code);
  }

  kill() {
    this.killed = true;
    if (this.alive.delete(this.pid)) this.emit("close", 0);
    return true;
  }
}

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(predicate, timeoutMs = 800) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached before timeout");
}

async function withAccessCenter(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-access-center-"));
  const store = new Store({ dataDir });
  await store.initialize();
  const instance = await store.createInstance({ name: "家中 NAS" });
  await store.saveConfig(instance.id, [
    'serverAddr = "edge.example.test"',
    "serverPort = 7000",
    "",
    "[[proxies]]",
    'name = "web_01"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    "localPort = 8801",
    "remotePort = 41001",
    "",
  ].join("\n"));
  await store.saveTunnelSelection(instance.id, { web_01: true });
  await store.saveTunnelLabels(instance.id, { web_01: { displayName: "公司 NAS" } });
  const tunnelService = new TunnelService({ store });
  const service = new AccessCenterService({
    store,
    tunnelService,
    credentialStore,
    logger: { info: async () => {}, warn: async () => {}, error: async () => {} },
    frpcBinaryPath: path.join(dataDir, "missing-frpc"),
  });

  try {
    await run({ instance, service, store });
  } finally {
    await service.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test("访问中心根据已同步备注和实例配置生成浏览器链接", async () => {
  await withAccessCenter(async ({ service }) => {
    await service.configure({
      enabled: false,
      name: "我的访问中心",
      serverAddr: "hub.example.test",
      serverPort: 18926,
      remotePort: 18928,
      localPort: 8802,
      frpToken: "frp-token",
    });

    const [link] = await service.listLinks();
    const status = await service.getStatus();

    assert.equal(link.name, "公司 NAS");
    assert.equal(link.url, "http://edge.example.test:41001");
    assert.equal(link.enabled, true);
    assert.equal(status.configured, true);
    assert.equal(Object.prototype.hasOwnProperty.call(status, "encryptedFrpToken"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(status, "encryptedAccessKey"), false);
  });
});

test("访问中心允许为不能自动判断的隧道保存自定义链接", async () => {
  await withAccessCenter(async ({ instance, service }) => {
    await service.configure({
      enabled: false,
      serverAddr: "hub.example.test",
      serverPort: 18926,
      remotePort: 18928,
      localPort: 8802,
      frpToken: "frp-token",
    });
    const key = `${instance.id}:web_01`;
    const links = await service.updateLinkProfile(key, {
      mode: "custom",
      customUrl: "https://nas.example.test/login",
    });

    assert.equal(links[0].url, "https://nas.example.test/login");
    assert.equal(links[0].canOpen, true);
  });
});

test("访问中心打开后无需登录即可读取隧道", async () => {
  await withAccessCenter(async ({ service }) => {
    await service.configure({
      enabled: false,
      serverAddr: "hub.example.test",
      serverPort: 18926,
      remotePort: 18928,
      localPort: 8802,
      frpToken: "frp-token",
    });
    const app = createAccessCenterApp(service);
    const server = await new Promise((resolve) => {
      const current = app.listen(0, "127.0.0.1", () => resolve(current));
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const page = await fetch(`${baseUrl}/access/`);
      assert.equal(page.status, 200);
      const pageText = await page.text();
      assert.match(pageText, /88FRP 访问中心/);
      assert.doesNotMatch(pageText, /访问密码/);
      const linksResponse = await fetch(`${baseUrl}/access/api/links`);
      const links = await linksResponse.json();
      assert.equal(linksResponse.status, 200);
      assert.equal(links.data[0].name, "公司 NAS");
      const authResponse = await fetch(`${baseUrl}/access/api/auth/challenge`);
      assert.equal(authResponse.status, 404);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("访问中心始终公开只读，且不提供公网链接设置接口", async () => {
  await withAccessCenter(async ({ instance, service }) => {
    await service.configure({
      enabled: false,
      serverAddr: "hub.example.test",
      serverPort: 18926,
      remotePort: 18928,
      localPort: 8802,
      frpToken: "frp-token",
    });
    const status = await service.getStatus();
    assert.equal(status.configured, true);
    assert.equal(status.accessMode, "public-read-only");

    const app = createAccessCenterApp(service);
    const server = await new Promise((resolve) => {
      const current = app.listen(0, "127.0.0.1", () => resolve(current));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const linksResponse = await fetch(`${baseUrl}/access/api/links`);
      const links = await linksResponse.json();
      assert.equal(linksResponse.status, 200);
      assert.equal(links.data[0].group, "公司");

      const updateResponse = await fetch(`${baseUrl}/access/api/links/${encodeURIComponent(`${instance.id}:web_01`)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "custom", customUrl: "https://example.test" }),
      });
      assert.equal(updateResponse.status, 404);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("访问中心提供有时长上限的临时测速数据流", async () => {
  await withAccessCenter(async ({ service }) => {
    const app = createAccessCenterApp(service);
    const server = await new Promise((resolve) => {
      const current = app.listen(0, "127.0.0.1", () => resolve(current));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${baseUrl}/access/api/speed-test?duration=999`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/octet-stream");
      assert.equal(response.headers.get("x-speed-test-duration"), "20");
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.ok(first.value.byteLength > 0);
      await reader.cancel();
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("测速流在客户端读取缓慢时仍会按设定时长结束", async () => {
  await withAccessCenter(async ({ service }) => {
    const app = createAccessCenterApp(service);
    const server = await new Promise((resolve) => {
      const current = app.listen(0, "127.0.0.1", () => resolve(current));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const startedAt = Date.now();
      const response = await fetch(`${baseUrl}/access/api/speed-test?duration=3`);
      await new Promise((resolve) => setTimeout(resolve, 3300));
      const reader = response.body.getReader();
      while (!(await reader.read()).done) { /* Drain the bounded response. */ }
      assert.ok(Date.now() - startedAt < 4500);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("升级时会忽略并清理旧版访问密码字段", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-access-center-legacy-"));
  const store = new Store({ dataDir });
  try {
    await store.initialize();
    await fs.writeFile(store.accessCenterFile, JSON.stringify({ enabled: true, encryptedAccessKey: "legacy-value" }), "utf8");

    const config = await store.getAccessCenter();
    assert.equal(config.enabled, true);
    assert.equal(Object.prototype.hasOwnProperty.call(config, "passwordRequired"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(config, "encryptedAccessKey"), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("不可浏览器直开的协议不会伪造网页链接", () => {
  const result = buildLink({ type: "stcp", remotePort: 2200 }, "edge.example.test");
  assert.equal(result.canOpen, false);
  assert.equal(result.mode, "visitor");
});

test("所有 TCP 隧道默认生成 HTTP 访问链接", () => {
  const result = buildLink({ type: "tcp", localPort: 3389, remotePort: 13966 }, "edge.example.test");
  assert.equal(result.url, "http://edge.example.test:13966");
  assert.equal(result.canOpen, true);
});

test("能够识别 Windows PowerShell 返回的访问中心进程字段", async () => {
  const binaryPath = path.join("D:\\88FRP", "resources", "88frpc.exe");
  const startedAt = "2026-08-09T06:52:00.808Z";
  const service = new AccessCenterService({
    store: {},
    tunnelService: {},
    credentialStore: {},
    logger: {},
    frpcBinaryPath: binaryPath,
    pidAlive: () => true,
    processInspector: async () => ({
      Name: "88frpc",
      Path: null,
      StartTime: "2026-08-09T06:52:00.8062455Z",
    }),
  });

  assert.equal(await service.isOwnedAccessProcess(404, { lastStartedAt: startedAt }), true);
});

test("无法停止旧访问中心 FRPC 时会接管原进程而不是重复启动", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-access-adopt-"));
  const store = new Store({ dataDir });
  let service;
  let alive = true;
  try {
    await store.initialize();
    const binaryPath = path.join(dataDir, "88frpc.exe");
    await fs.writeFile(binaryPath, "fake", "utf8");
    const localPort = await getAvailablePort();
    await store.saveAccessCenter({
      enabled: true,
      serverAddr: "hub.example.test",
      serverPort: 18926,
      remotePort: 18928,
      localHost: "127.0.0.1",
      localPort,
      publicUrl: "http://hub.example.test:18928/access",
      encryptedFrpToken: "unused-while-adopting",
    });
    const startedAt = new Date().toISOString();
    await store.saveAccessCenterRuntime({
      status: "running",
      pid: 43_211,
      ownerPid: process.pid + 1,
      binaryPath,
      lastStartedAt: startedAt,
    });
    let spawnCount = 0;
    const warnings = [];
    service = new AccessCenterService({
      store,
      tunnelService: new TunnelService({ store }),
      credentialStore,
      logger: {
        async info() {},
        async warn(message) { warnings.push(message); },
        async error() {},
      },
      frpcBinaryPath: binaryPath,
      pidAlive: () => alive,
      processInspector: async () => ({ name: "88frpc", path: binaryPath, startTime: startedAt }),
      signalProcess() {
        const error = new Error("operation not permitted");
        error.code = "EPERM";
        throw error;
      },
      spawnProcess() {
        spawnCount += 1;
        throw new Error("must not spawn");
      },
    });

    await service.start();

    const runtime = await store.getAccessCenterRuntime();
    assert.equal(spawnCount, 0);
    assert.equal(runtime.pid, 43_211);
    assert.equal(runtime.status, "running");
    assert.equal(warnings.length, 1);
  } finally {
    alive = false;
    if (service) await service.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("访问中心配置允许首次连接失败后持续重试", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-access-recovery-"));
  const store = new Store({ dataDir });
  const alive = new Set();
  const children = [];
  let nextPid = 60_000;
  let service;
  try {
    await store.initialize();
    const binaryPath = path.join(dataDir, "88frpc.exe");
    await fs.writeFile(binaryPath, "fake", "utf8");
    service = new AccessCenterService({
      store,
      tunnelService: new TunnelService({ store }),
      credentialStore,
      logger: { async info() {}, async warn() {}, async error() {} },
      frpcBinaryPath: binaryPath,
      restartDelays: [5, 10],
      stableAfterMs: 60,
      monitorIntervalMs: 100,
      startupProbeMs: 2,
      pidAlive: (pid) => alive.has(pid),
      processInspector: async () => null,
      spawnProcess() {
        const child = new FakeFrpcChild(nextPid++, alive);
        children.push(child);
        child.start();
        return child;
      },
    });
    const localPort = await getAvailablePort();
    await service.configure({
      enabled: true,
      serverAddr: "hub.example.test",
      serverPort: 18926,
      remotePort: 18928,
      localPort,
      frpToken: "frp-token",
    });
    assert.equal(children.length, 1);
    assert.match(
      service.buildFrpcConfig(await store.getAccessCenter(), "frp-token"),
      /loginFailExit = false/
    );

    children[0].crash(1);
    await waitFor(async () => children.length === 2 && (await store.getAccessCenterRuntime()).status === "running");
    assert.equal(children.length, 2);

    await service.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(children.length, 2, "manual stop must cancel access-center recovery");
  } finally {
    if (service) await service.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
