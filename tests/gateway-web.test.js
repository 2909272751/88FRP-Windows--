const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { createWebApp } = require("../src/web/server");

async function withWeb(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-gateway-web-"));
  const bundle = await createWebApp({
    dataDir,
    initializeRuntime: false,
    caddyBinaryPath: path.join(dataDir, "missing-caddy"),
    frpcBinaryPath: path.join(dataDir, "missing-frpc"),
  });
  const server = await new Promise((resolve) => {
    const instance = bundle.app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl, bundle);
  } finally {
    bundle.scheduler.stop();
    await bundle.context.gatewayService.stopAll().catch(() => undefined);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function request(baseUrl, requestPath, headers = {}) {
  const target = new URL(requestPath, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET",
      headers,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.once("error", reject);
    req.end();
  });
}

test("公开门户免登录并带安全响应头，管理页仍要求登录", async () => {
  await withWeb(async (baseUrl) => {
    const portal = await fetch(`${baseUrl}/portal`);
    assert.equal(portal.status, 200);
    assert.match(await portal.text(), /id="portalGrid"/);
    assert.equal(portal.headers.get("x-frame-options"), "DENY");
    assert.equal(portal.headers.get("x-content-type-options"), "nosniff");

    const publicApi = await fetch(`${baseUrl}/api/gateway/public`);
    assert.equal(publicApi.status, 200);
    const publicBody = await publicApi.json();
    assert.equal(publicBody.success, true);
    assert.equal(publicBody.data.remoteAccess, null);

    const gateway = await fetch(`${baseUrl}/`, { redirect: "manual" });
    assert.equal(gateway.status, 302);
    assert.match(gateway.headers.get("location") || "", /\/login/);

    const legacy = await fetch(`${baseUrl}/legacy`, { redirect: "manual" });
    assert.equal(legacy.status, 302);
    assert.match(legacy.headers.get("location") || "", /\/login/);
  });
});

test("公网 Host 携带伪造桌面头不能绕过控制台登录", async () => {
  await withWeb(async (baseUrl) => {
    const forged = await request(baseUrl, "/api/gateway", {
      Host: "xps.example.com",
      "X-88FRP-Desktop": "1",
    });
    assert.equal(forged.status, 401);

    const localDesktop = await request(baseUrl, "/api/gateway", {
      Host: "127.0.0.1",
      "X-88FRP-Desktop": "1",
    });
    assert.equal(localDesktop.status, 200);
  });
});

test("管理页加载失败时提供重试和重新登录入口", async () => {
  const publicDir = path.join(__dirname, "../src/web/public");
  const [html, script] = await Promise.all([
    fs.readFile(path.join(publicDir, "gateway.html"), "utf8"),
    fs.readFile(path.join(publicDir, "js/gateway.js"), "utf8"),
  ]);
  assert.match(html, /id="btnRetryGatewayLoad"/);
  assert.match(html, /href="\/login"/);
  assert.match(script, /function showLoadError/);
  assert.match(script, /el\.gatewayLoading\.hidden = false/);
  assert.doesNotMatch(html, /把本机变成一台设备入口/);
  assert.match(html, /value="tcp"/);
  assert.match(script, /tcpEndpoint/);
});

test("公开门户采用整卡直达并保留加载失败重试", async () => {
  const publicDir = path.join(__dirname, "../src/web/public");
  const [html, script] = await Promise.all([
    fs.readFile(path.join(publicDir, "portal.html"), "utf8"),
    fs.readFile(path.join(publicDir, "js/portal.js"), "utf8"),
  ]);
  assert.match(html, /id="portalGrid"/);
  assert.match(html, /id="remoteAccess"/);
  assert.match(html, /id="remoteGrid"/);
  assert.match(html, /\/css\/portal\.css/);
  assert.match(script, /createSkeleton/);
  assert.match(script, /card\.className = "card skeleton"/);
  assert.match(script, /\/api\/gateway\/public/);
  assert.match(script, /card\.href = href/);
  assert.match(script, /function renderRemoteAccess/);
  assert.match(script, /navigator\.clipboard/);
  assert.match(script, /暂时无法打开设备入口/);
  assert.doesNotMatch(script, /data-copy-url/);
});

test("3.7.0 登录页使用当前产品文案且不再出现旧实例隧道入口", async () => {
  const publicDir = path.join(__dirname, "../src/web/public");
  const html = await fs.readFile(path.join(publicDir, "console-login.html"), "utf8");
  assert.match(html, /v3\.7\.0/);
  assert.match(html, /管理这台电脑的服务与远程访问/);
  assert.match(html, /IPv6 优先直连，IPv4 自动兜底/);
  assert.match(html, /id="loginForm"/);
  assert.doesNotMatch(html, /实例、隧道和账号/);
});

test("3.7.0 网页、远程桌面和 SSH 都提供自动、IPv6、IPv4 三条线路", async () => {
  const publicDir = path.join(__dirname, "../src/web/public");
  const [gatewayHtml, gatewayScript, portalHtml, portalScript, nativeWorkspace] = await Promise.all([
    fs.readFile(path.join(publicDir, "gateway.html"), "utf8"),
    fs.readFile(path.join(publicDir, "js/gateway.js"), "utf8"),
    fs.readFile(path.join(publicDir, "portal.html"), "utf8"),
    fs.readFile(path.join(publicDir, "js/portal.js"), "utf8"),
    fs.readFile(path.join(__dirname, "../src/windows-launcher/GatewayWorkspace.cs"), "utf8"),
  ]);

  assert.match(gatewayHtml, /v3\.7\.0/);
  assert.match(gatewayHtml, /id="webV6Url"/);
  assert.match(gatewayHtml, /id="webV4Url"/);
  assert.match(gatewayHtml, /id="sshEndpointV6"/);
  assert.match(gatewayHtml, /id="sshEndpointV4"/);
  assert.match(gatewayScript, /webEndpoints\.ipv6/);
  assert.match(gatewayScript, /webEndpoints\.ipv4/);
  assert.match(gatewayScript, /sshEndpoints\.ipv6/);
  assert.match(gatewayScript, /sshEndpoints\.ipv4/);

  assert.match(portalHtml, /data-line="auto"/);
  assert.match(portalHtml, /data-line="ipv6"/);
  assert.match(portalHtml, /data-line="ipv4"/);
  assert.match(portalScript, /renderWebRoutes/);
  assert.match(portalScript, /target\.family === "ipv6"/);
  assert.match(portalScript, /target\.family === "ipv4"/);

  assert.match(nativeWorkspace, /gatewayWebV6Box = GatewayEndpointRow/);
  assert.match(nativeWorkspace, /gatewayWebV4Box = GatewayEndpointRow/);
  assert.match(nativeWorkspace, /gatewayRdpCommandBox = GatewayEndpointRow/);
  assert.match(nativeWorkspace, /gatewayRdpCommandV4Box = GatewayEndpointRow/);
  assert.match(nativeWorkspace, /gatewaySshV6Box = GatewayEndpointRow/);
  assert.match(nativeWorkspace, /gatewaySshV4Box = GatewayEndpointRow/);
  assert.match(nativeWorkspace, /Header = "手动切换网页线路"[\s\S]{0,160}IsExpanded = false/);
  assert.match(nativeWorkspace, /Expander sshSettings = new Expander \{ Header = "SSH 设置"[\s\S]{0,120}IsExpanded = false/);
  assert.match(nativeWorkspace, /BuildGatewayFirewallCard\(\)/);
  assert.match(nativeWorkspace, /gatewayDeviceCard = new Border \{ Visibility = Visibility\.Collapsed \}/);
  assert.match(nativeWorkspace, /AddGatewayServiceSection\("网页服务"/);
  assert.match(nativeWorkspace, /AddGatewayServiceSection\("直连服务"/);
});

test("3.7.0 服务卡片带独立图标配色，设置页日志按需加载", async () => {
  const publicDir = path.join(__dirname, "../src/web/public");
  const [gatewayScript, portalScript] = await Promise.all([
    fs.readFile(path.join(publicDir, "js/gateway.js"), "utf8"),
    fs.readFile(path.join(publicDir, "js/portal.js"), "utf8"),
  ]);

  assert.match(gatewayScript, /function serviceVisual/);
  assert.match(gatewayScript, /tone-\$\{meta\.tone\}/);
  assert.match(portalScript, /tone-\$\{meta\.tone \|\| "blue"\}/);
  assert.match(gatewayScript, /state\.logsLoaded/);
  assert.match(gatewayScript, /logDetails\.addEventListener\("toggle"/);
  assert.doesNotMatch(gatewayScript, /if \(target === "settings"\) loadLogs/);
});
