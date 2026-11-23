const test = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const net = require("node:net");

const { DEFAULT_STATE, normalizeState } = require("../src/core/gateway/gateway-model");
const { RelayManager } = require("../src/core/gateway/relay-manager");

function closeTcp(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeUdp(socket) {
  return new Promise((resolve) => {
    try { socket.close(() => resolve()); }
    catch { resolve(); }
  });
}

async function freeTcpPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await closeTcp(server);
  return port;
}

async function freeUdpPort() {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await closeUdp(socket);
  return port;
}

test("TCP 中继从同一公网端口转发到不同本地端口", async () => {
  const target = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(`echo:${chunk.toString("utf8")}`));
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = target.address().port;
  const publicPort = await freeTcpPort();
  const store = { appendAudit: async () => undefined };
  const manager = new RelayManager({ store });
  const state = normalizeState({
    ...DEFAULT_STATE,
    initialized: true,
    device: { ...DEFAULT_STATE.device, name: "test", domain: "xps.example.com", gatewayPort: 7777 },
    source: { legacyInstanceId: "legacy" },
    ssh: { enabled: true, localHost: "127.0.0.1", localPort: targetPort, remotePort: publicPort },
  });
  try {
    await manager.reconcile(state);
    const answer = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: publicPort });
      socket.once("connect", () => socket.write("ok"));
      socket.once("data", (chunk) => {
        socket.destroy();
        resolve(chunk.toString("utf8"));
      });
      socket.once("error", reject);
    });
    assert.equal(answer, "echo:ok");
  } finally {
    await manager.stopAll();
    await closeTcp(target);
  }
});

test("UDP 中继从同一公网端口转发到不同本地端口", async () => {
  const target = dgram.createSocket("udp4");
  target.on("message", (message, remote) => {
    target.send(Buffer.from(`echo:${message.toString("utf8")}`), remote.port, remote.address);
  });
  await new Promise((resolve) => target.bind(0, "127.0.0.1", resolve));
  const targetPort = target.address().port;
  const publicPort = await freeUdpPort();
  const store = { appendAudit: async () => undefined };
  const manager = new RelayManager({ store });
  const state = normalizeState({
    ...DEFAULT_STATE,
    initialized: true,
    device: { ...DEFAULT_STATE.device, name: "test", domain: "xps.example.com", gatewayPort: 7777 },
    source: { legacyInstanceId: "legacy" },
    services: [{
      kind: "udp",
      name: "game",
      title: "Game",
      localHost: "127.0.0.1",
      localPort: targetPort,
      remotePort: publicPort,
      enabled: true,
    }],
  });
  const client = dgram.createSocket("udp4");
  try {
    await manager.reconcile(state);
    await new Promise((resolve) => client.bind(0, "127.0.0.1", resolve));
    const answer = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("UDP relay timeout")), 3000);
      client.once("message", (message) => {
        clearTimeout(timeout);
        resolve(message.toString("utf8"));
      });
      client.send("ok", publicPort, "127.0.0.1");
    });
    assert.equal(answer, "echo:ok");
  } finally {
    await closeUdp(client);
    await manager.stopAll();
    await closeUdp(target);
  }
});

test("停止 TCP 中继会主动断开仍未结束的连接", async () => {
  const target = net.createServer(() => undefined);
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = target.address().port;
  const publicPort = await freeTcpPort();
  const manager = new RelayManager({ store: { appendAudit: async () => undefined } });
  const state = normalizeState({
    ...DEFAULT_STATE,
    initialized: true,
    device: { ...DEFAULT_STATE.device, name: "test", domain: "xps.example.com", gatewayPort: 7777 },
    source: { legacyInstanceId: "legacy" },
    ssh: { enabled: true, localHost: "127.0.0.1", localPort: targetPort, remotePort: publicPort },
  });
  let client;
  try {
    await manager.reconcile(state);
    client = net.connect({ host: "127.0.0.1", port: publicPort });
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    const stopped = await Promise.race([
      manager.stopAll().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    assert.equal(stopped, true);
  } finally {
    client?.destroy();
    await manager.stopAll();
    await closeTcp(target);
  }
});
