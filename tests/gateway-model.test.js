const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_STATE,
  buildCaddyfile,
  buildFrpcConfig,
  buildTunnelNameMap,
  desiredDnsRecords,
  normalizeService,
  normalizeSsh,
  normalizeState,
  udpEndpoint,
} = require("../src/core/gateway/gateway-model");
const { buildRelayPlan } = require("../src/core/gateway/relay-manager");

function sampleState() {
  return normalizeState({
    ...DEFAULT_STATE,
    initialized: true,
    device: {
      ...DEFAULT_STATE.device,
      name: "XPS",
      domain: "xps.example.com",
      gatewayPort: 7777,
    },
    source: { legacyInstanceId: "legacy" },
    cloudflare: {
      ...DEFAULT_STATE.cloudflare,
      encryptedToken: "protected",
      zoneName: "example.com",
      zoneId: "zone",
    },
    ssh: {
      enabled: true,
      localHost: "127.0.0.1",
      localPort: 22,
      remotePort: 22022,
    },
    services: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "http",
        name: "alist",
        title: "AList",
        localHost: "127.0.0.1",
        localPort: 5244,
        enabled: true,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        kind: "udp",
        name: "game",
        title: "Game",
        localHost: "192.168.0.9",
        localPort: 27015,
        remotePort: 27015,
        enabled: true,
      },
    ],
  });
}

test("空 SSH 公网端口 0 可被状态规范化接受", () => {
  const ssh = normalizeSsh({
    enabled: false,
    localHost: "127.0.0.1",
    localPort: 22,
    remotePort: 0,
  });
  assert.equal(ssh.remotePort, 0);
  assert.throws(() => normalizeSsh({ enabled: true, remotePort: 0 }), /公网端口/);
});

test("读取状态不会改写服务更新时间", () => {
  const service = normalizeService({
    kind: "http",
    name: "alist",
    title: "AList",
    localPort: 5244,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(service.updatedAt, "2026-01-02T00:00:00.000Z");
  const state = normalizeState({
    ...DEFAULT_STATE,
    services: [service],
  });
  assert.equal(state.services[0].updatedAt, "2026-01-02T00:00:00.000Z");
});

test("Caddy 对每个反代都删除伪造的桌面请求头", () => {
  const caddyfile = buildCaddyfile(sampleState(), {
    adminPort: 8801,
    storageDir: "C:\\data\\caddy",
    accessLogPath: "C:\\data\\caddy-access.log",
  });
  const proxyCount = (caddyfile.match(/^\s*reverse_proxy /gm) || []).length;
  const stripCount = (caddyfile.match(/header_up -X-88FRP-Desktop/g) || []).length;
  assert.equal(proxyCount, 4);
  assert.equal(stripCount, proxyCount);
  assert.match(caddyfile, /https:\/\/xps\.example\.com:7777, https:\/\/\*\.xps\.example\.com:7777/);
  assert.match(caddyfile, /@admin host admin\.xps\.example\.com/);
  assert.match(caddyfile, /host alist\.xps\.example\.com/);
  assert.doesNotMatch(caddyfile, /resolvers 1\.1\.1\.1/);
});

test("统一 frpc 配置让 SSH/UDP 先进入本机同端口中继，再转发真实服务", () => {
  const state = sampleState();
  state.ssh.localHost = "192.168.0.9";
  const config = buildFrpcConfig(
    '[common]\nserverAddr = "node.example.com"\nserverPort = 7000\nauth.token = "keep"\n',
    state
  );
  assert.equal((config.match(/\[\[proxies\]\]/g) || []).length, 3);
  assert.match(config, /name = "88frp-gateway-http"[\s\S]*localIP = "127\.0\.0\.1"[\s\S]*localPort = 7777[\s\S]*remotePort = 7777/);
  assert.match(config, /name = "88frp-gateway-ssh"[\s\S]*localIP = "127\.0\.0\.1"[\s\S]*localPort = 22022[\s\S]*remotePort = 22022/);
  assert.match(config, /name = "88frp-gateway-udp-game-22222222"[\s\S]*localIP = "192\.168\.0\.9"[\s\S]*localPort = 27015[\s\S]*remotePort = 27015/);
  assert.match(config, /auth\.token = "keep"/);
});

test("SSH/UDP 中继计划覆盖 IPv6 直连与 IPv4 兜底", () => {
  const state = sampleState();
  state.ssh.localHost = "192.168.0.9";
  const relays = buildRelayPlan(state);
  assert.deepEqual(relays.map((item) => item.id), ["ssh", "udp:22222222-2222-4222-8222-222222222222"]);
  assert.deepEqual(relays[0], {
    id: "ssh",
    kind: "tcp",
    publicPort: 22022,
    targetHost: "192.168.0.9",
    targetPort: 22,
    label: "SSH",
    proxyFrp: true,
  });
  assert.equal(relays[1].publicPort, 27015);
  assert.equal(relays[1].proxyFrp, false);
  assert.equal(udpEndpoint(state, state.services[1]), "xps.example.com:27015");
});

test("frpc 配置优先使用 88FRP 账号里真实存在的隧道 ID", () => {
  const state = sampleState();
  state.ssh.localHost = "192.168.0.9";
  const baseConfig = [
    '[common]',
    'serverAddr = "node.example.com"',
    'serverPort = 7000',
    '',
    '[[proxies]]',
    'name = "MrO2SDXSxrra"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = 7777',
    'remotePort = 7777',
    '',
    '[[proxies]]',
    'name = "pneXwObX9Iy7"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = 22',
    'remotePort = 22022',
    '',
  ].join("\n");
  const tunnelNames = buildTunnelNameMap([
    { name: "MrO2SDXSxrra", localPort: 7777, remotePort: 7777 },
    { name: "pneXwObX9Iy7", localPort: 22, remotePort: 22022 },
  ]);
  const config = buildFrpcConfig(baseConfig, state, { tunnelNames });
  assert.match(config, /name = "MrO2SDXSxrra"[\s\S]*localPort = 7777[\s\S]*remotePort = 7777/);
  assert.match(config, /name = "pneXwObX9Iy7"[\s\S]*localPort = 22022[\s\S]*remotePort = 22022/);
  assert.doesNotMatch(config, /name = "88frp-gateway-http"/);
  assert.doesNotMatch(config, /name = "88frp-gateway-ssh"/);
});

test("SSH 公网端口完全相同时使用目标服务自身监听，不额外占用回环端口", () => {
  const state = sampleState();
  state.ssh.remotePort = 22;
  state.ssh.localHost = "192.168.0.9";
  const config = buildFrpcConfig(
    '[common]\nserverAddr = "node.example.com"\nserverPort = 7000\n',
    state
  );
  assert.match(config, /name = "88frp-gateway-ssh"[\s\S]*localIP = "192\.168\.0\.9"[\s\S]*localPort = 22[\s\S]*remotePort = 22/);
  assert.equal(buildRelayPlan(state).find((item) => item.id === "ssh").proxyFrp, false);
});

test("TCP 直通使用独立公网端口并进入 frpc 与中继计划", () => {
  const service = normalizeService({
    id: "33333333-3333-4333-8333-333333333333",
    kind: "tcp",
    name: "rdp",
    title: "远程桌面",
    localHost: "127.0.0.1",
    localPort: 3389,
    remotePort: 64540,
    enabled: true,
  });
  const state = sampleState();
  state.services.push(service);
  const config = buildFrpcConfig(
    '[common]\nserverAddr = "node.example.com"\nserverPort = 7000\n',
    state
  );
  assert.equal((config.match(/\[\[proxies\]\]/g) || []).length, 4);
  assert.match(config, /name = "88frp-gateway-tcp-rdp-33333333"[\s\S]*localIP = "127\.0\.0\.1"[\s\S]*localPort = 64540[\s\S]*remotePort = 64540/);
  const relay = buildRelayPlan(state).find((item) => item.id === "tcp:33333333-3333-4333-8333-333333333333");
  assert.equal(relay.kind, "tcp");
  assert.equal(relay.publicPort, 64540);
  assert.equal(relay.targetPort, 3389);
});

test("DNS 生成双栈主域、专用 v6/v4 与 SSH 记录", () => {
  const records = desiredDnsRecords(sampleState(), {
    ipv4: "203.0.113.7",
    ipv6: "2408:8207:1234:5678:9abc:def0:1234:5678",
    zoneName: "example.com",
  });
  assert.deepEqual(
    records.map((item) => `${item.type} ${item.fqdn}`),
    [
      "A xps.example.com",
      "A *.xps.example.com",
      "A v4.xps.example.com",
      "A ssh-v4.xps.example.com",
      "AAAA xps.example.com",
      "AAAA *.xps.example.com",
      "AAAA v6.xps.example.com",
      "AAAA ssh-v6.xps.example.com",
    ]
  );
  assert.equal(records.every((item) => item.proxied === false), true);
});
