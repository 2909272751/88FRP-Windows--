const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

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
