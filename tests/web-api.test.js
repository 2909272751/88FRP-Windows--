const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const { DEFAULT_REMOTE_URL } = require("../src/shared/constants");
const { createWebApp, listenWebApp } = require("../src/web/server");

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

test("后台端口已占用时第二个监听会立即失败", async () => {
  const first = await listenWebApp(express(), 0, "127.0.0.1");
  const port = first.address().port;
  try {
    await assert.rejects(
      listenWebApp(express(), port, "127.0.0.1"),
      (error) => error && error.code === "EADDRINUSE"
    );
  } finally {
    await new Promise((resolve, reject) => {
      first.close((error) => (error ? reject(error) : resolve()));
    });
  }
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

test("实例可以通过 API 删除且不会残留在列表中", async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name: "待删除实例" }),
    });
    const created = await createResponse.json();

    const deleteResponse = await fetch(`${baseUrl}/api/instances/${created.data.id}`, {
      method: "DELETE",
    });
    const deleted = await deleteResponse.json();
    const listResponse = await fetch(`${baseUrl}/api/instances`);
    const listed = await listResponse.json();

    assert.equal(deleteResponse.status, 200);
    assert.equal(deleted.success, true);
    assert.deepEqual(listed.data, []);
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

test("实例名称可通过 API 完整保存和读取中文字符", async () => {
  await withServer(async (baseUrl) => {
    const name = "公司主机 · 远程办公";
    const createResponse = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        name,
        secretKey: "demo-secret",
      }),
    });
    const created = await createResponse.json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.data.name, name);

    const getResponse = await fetch(`${baseUrl}/api/instances/${created.data.id}`);
    const fetched = await getResponse.json();

    assert.equal(getResponse.status, 200);
    assert.equal(fetched.data.name, name);
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
  assert.match(script, /tunnelLoadState/);
  assert.match(script, /retry-tunnels/);
  assert.match(script, /instance-menu-button/);
  assert.match(script, /deleteInstance\(instance\)/);
  assert.match(api, /\/api\/88frp\/account\/connect/);
  assert.match(styles, /\.sidebar\.is-expanded/);
  assert.match(styles, /\.instance-menu\.is-open/);
  assert.match(styles, /\.content-area\s*\{[^}]*display:\s*flex/s);
  assert.match(styles, /\.view-panel\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.doesNotMatch(styles, /\.view-panel\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /safe-area-inset-bottom/);
});

test("Web 核心可提供本地 Lucide 图标字体", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/css/lucide.woff2`);
    const bytes = await response.arrayBuffer();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /font|octet-stream/);
    assert.ok(bytes.byteLength > 100000);
  });
});

test("Web 核心可提供 88FRP Logo", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/88frp-logo.png`);
    const bytes = await response.arrayBuffer();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /image\/png/);
    assert.ok(bytes.byteLength > 100000);
  });
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
