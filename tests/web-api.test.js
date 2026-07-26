const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { DEFAULT_REMOTE_URL } = require("../src/shared/constants");
const { createWebApp } = require("../src/web/server");

async function withServer(run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-node-test-"));
  process.env.DATA_DIR = tempDir;
  process.env.INSTANCE_AUTO_START_ON_BOOT = "0";
  process.env.FRPC_BINARY_PATH = path.join(tempDir, "88frpc");

  const { app, scheduler } = await createWebApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    scheduler.stop();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    delete process.env.INSTANCE_AUTO_START_ON_BOOT;
    delete process.env.FRPC_BINARY_PATH;
  }
}

test("健康检查接口返回服务状态", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.service, "88frp-node-web");
  });
});

test("实例列表接口在空数据目录下返回空数组", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/instances`);
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.deepEqual(json.data, []);
  });
});

test("创建实例时默认使用项目内置远程配置地址", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "默认地址实例",
        secretKey: "demo-secret",
      }),
    });
    const json = await response.json();

    assert.equal(response.status, 201);
    assert.equal(json.success, true);
    assert.equal(json.data.remoteUrl, DEFAULT_REMOTE_URL);
  });
});

test("Web 页面资源包含隧道备注名称和移动端适配入口", async () => {
  const publicDir = path.join(__dirname, "..", "src", "web", "public");
  const [page, script, api, styles] = await Promise.all([
    fs.readFile(path.join(publicDir, "index.html"), "utf8"),
    fs.readFile(path.join(publicDir, "js", "app.js"), "utf8"),
    fs.readFile(path.join(publicDir, "js", "api.js"), "utf8"),
    fs.readFile(path.join(publicDir, "css", "style.css"), "utf8"),
  ]);

  assert.match(page, /btnShowInstances/);
  assert.match(page, /btnShowInstancesEmpty/);
  assert.match(page, /btnFrpAccount/);
  assert.match(script, /tunnel\.displayName \|\| tunnel\.name/);
  assert.match(script, /labelRefresh\?\.reason === "updated"/);
  assert.match(script, /connectFrpAccount/);
  assert.match(api, /\/api\/88frp\/account\/connect/);
  assert.match(styles, /\.sidebar\.is-expanded/);
  assert.match(styles, /@media \(max-width: 480px\)/);
});

test("88FRP 账号状态默认未连接且不会泄露凭据", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/88frp/account`);
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.connected, false);
    assert.equal(Object.prototype.hasOwnProperty.call(json.data, "encryptedToken"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(json.data, "encryptedPassword"), false);
  });
});
