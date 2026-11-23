"use strict";

const dgram = require("node:dgram");
const dns = require("node:dns/promises");
const net = require("node:net");

const LOOPBACK_HOST = "127.0.0.1";
const PUBLIC_IPV6_HOST = "::";
const RETRY_DELAY_MS = 15_000;
const UDP_SESSION_IDLE_MS = 45_000;

function describeTarget(relay) {
  const host = net.isIP(relay.targetHost) === 6 ? `[${relay.targetHost}]` : relay.targetHost;
  return `${host}:${relay.targetPort}`;
}

function buildRelayPlan(state) {
  if (!state?.initialized) return [];
  const relays = [];
  if (state.ssh?.enabled && Number(state.ssh.remotePort) > 0) {
    relays.push({
      id: "ssh",
      kind: "tcp",
      publicPort: Number(state.ssh.remotePort),
      targetHost: state.ssh.localHost || LOOPBACK_HOST,
      targetPort: Number(state.ssh.localPort),
      label: "SSH",
      proxyFrp: Number(state.ssh.remotePort) !== Number(state.ssh.localPort),
    });
  }
  for (const service of state.services || []) {
    if (!["tcp", "udp"].includes(service.kind) || !service.enabled) continue;
    relays.push({
      id: `${service.kind}:${service.id}`,
      kind: service.kind,
      publicPort: Number(service.remotePort),
      targetHost: service.localHost || LOOPBACK_HOST,
      targetPort: Number(service.localPort),
      label: service.title || service.name || (service.kind === "tcp" ? "TCP 服务" : "UDP 服务"),
      proxyFrp: Number(service.remotePort) !== Number(service.localPort),
    });
  }
  return relays;
}

function samePlanEntry(left, right) {
  return Boolean(left && right)
    && left.kind === right.kind
    && left.publicPort === right.publicPort
    && left.targetHost === right.targetHost
    && left.targetPort === right.targetPort
    && left.proxyFrp === right.proxyFrp;
}

function listenTcp(server, port, host, ipv6Only = false) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, ipv6Only, exclusive: true });
  });
}

function bindUdp(socket, port, host, ipv6Only = false) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      socket.removeListener("error", onError);
      resolve(socket.address());
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind({ port, address: host, ipv6Only, exclusive: true });
  });
}

function closeUdpSocket(socket) {
  if (!socket) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

class RelayManager {
  constructor({
    store,
    logger,
    createTcpServer = () => net.createServer(),
    createTcpConnection = (options) => net.connect(options),
    createUdpSocket = (type) => dgram.createSocket({ type, reuseAddr: false }),
    lookupHost = dns.lookup,
  } = {}) {
    this.store = store;
    this.logger = logger;
    this.createTcpServer = createTcpServer;
    this.createTcpConnection = createTcpConnection;
    this.createUdpSocket = createUdpSocket;
    this.lookupHost = lookupHost;
    this.entries = new Map();
    this.reconcileQueue = Promise.resolve();
  }

  getStatus() {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      status: entry.status,
      publicPort: entry.publicPort,
      target: describeTarget(entry),
      listeners: entry.listeners.map((item) => ({ ...item })),
      connections: entry.connections,
      warning: entry.warning || "",
      lastError: entry.lastError || "",
      startedAt: entry.startedAt || "",
    }));
  }

  find(id) {
    const entry = this.entries.get(id);
    return entry ? this.getStatus().find((item) => item.id === id) || null : null;
  }

  async reconcile(state) {
    const task = this.reconcileQueue.catch(() => {}).then(() => this.reconcileInternal(state));
    this.reconcileQueue = task.catch(() => {});
    return task;
  }

  async reconcileInternal(state) {
    const desired = buildRelayPlan(state);
    const desiredById = new Map(desired.map((item) => [item.id, item]));
    for (const [id, entry] of [...this.entries]) {
      const next = desiredById.get(id);
      if (!next || !samePlanEntry(entry.plan, next)) {
        await this.stopEntry(id, "config-changed");
      }
    }

    const failures = [];
    for (const plan of desired) {
      const existing = this.entries.get(plan.id);
      if (existing && existing.status !== "error") continue;
      if (existing?.status === "error" && Date.now() < (existing.retryAt || 0)) continue;
      try {
        await this.startEntry(plan);
      } catch (error) {
        failures.push(`${plan.kind.toUpperCase()} ${plan.publicPort}：${error.message}`);
      }
    }
    if (failures.length) {
      await this.audit("relay.reconcile", "failed", { errors: failures });
      throw new Error(`统一入口端口中继启动失败：${failures.join("；")}`);
    }
    return { relays: this.getStatus() };
  }

  async startEntry(plan) {
    const entry = {
      ...plan,
      plan,
      status: "starting",
      listeners: [],
      tcpServers: [],
      tcpSockets: new Set(),
      udpSockets: [],
      sessions: new Map(),
      connections: 0,
      warning: "",
      lastError: "",
      startedAt: "",
      retryAt: 0,
    };
    this.entries.set(plan.id, entry);
    try {
      if (plan.kind === "tcp") await this.startTcpEntry(entry);
      else await this.startUdpEntry(entry);
      entry.status = entry.status === "direct" ? "direct" : "running";
      entry.startedAt = new Date().toISOString();
      await this.audit("relay.start", "success", {
        id: entry.id,
        kind: entry.kind,
        publicPort: entry.publicPort,
        target: describeTarget(entry),
        listeners: entry.listeners,
        warning: entry.warning,
      });
    } catch (error) {
      entry.status = "error";
      entry.lastError = error.message;
      entry.retryAt = Date.now() + RETRY_DELAY_MS;
      await this.closeEntry(entry);
      await this.audit("relay.start", "failed", {
        id: entry.id,
        kind: entry.kind,
        publicPort: entry.publicPort,
        target: describeTarget(entry),
        error: error.message,
      });
      throw error;
    }
  }

  async startTcpEntry(entry) {
    const publicServer = this.createTcpServer();
    publicServer.on("connection", (socket) => this.handleTcpConnection(entry, socket));
    publicServer.on("error", (error) => {
      entry.status = "error";
      entry.lastError = error.message;
      entry.retryAt = Date.now() + RETRY_DELAY_MS;
    });
    try {
      const address = await listenTcp(publicServer, entry.publicPort, PUBLIC_IPV6_HOST, true);
      entry.tcpServers.push(publicServer);
      entry.listeners.push({ protocol: "tcp", family: "ipv6", host: address.address, port: address.port });
    } catch (error) {
      await new Promise((resolve) => publicServer.close(() => resolve())).catch(() => undefined);
      if (error.code === "EADDRINUSE" && !entry.proxyFrp) {
        entry.status = "direct";
        entry.warning = `公网端口 ${entry.publicPort} 已由目标服务占用，按目标服务自身 IPv6 监听直连。`;
        return;
      }
      throw error;
    }

    if (!entry.proxyFrp) return;
    const loopbackServer = this.createTcpServer();
    loopbackServer.on("connection", (socket) => this.handleTcpConnection(entry, socket));
    loopbackServer.on("error", (error) => {
      entry.status = "error";
      entry.lastError = error.message;
      entry.retryAt = Date.now() + RETRY_DELAY_MS;
    });
    try {
      const address = await listenTcp(loopbackServer, entry.publicPort, LOOPBACK_HOST, false);
      entry.tcpServers.push(loopbackServer);
      entry.listeners.push({ protocol: "tcp", family: "ipv4", host: address.address, port: address.port });
    } catch (error) {
      await new Promise((resolve) => loopbackServer.close(() => resolve())).catch(() => undefined);
      throw new Error(`无法建立 88FRP 回环中继 127.0.0.1:${entry.publicPort}：${error.message}`);
    }
  }

  handleTcpConnection(entry, socket) {
    const upstream = this.createTcpConnection({
      host: entry.targetHost,
      port: entry.targetPort,
    });
    entry.connections += 1;
    entry.tcpSockets.add(socket);
    entry.tcpSockets.add(upstream);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      entry.connections = Math.max(0, entry.connections - 1);
      entry.tcpSockets.delete(socket);
      entry.tcpSockets.delete(upstream);
    };
    socket.once("close", close);
    upstream.once("close", close);
    socket.on("error", (error) => {
      entry.lastError = error.message;
      socket.destroy();
      upstream.destroy();
    });
    upstream.on("error", (error) => {
      entry.lastError = error.message;
      socket.destroy();
      upstream.destroy();
    });
    socket.pipe(upstream);
    upstream.pipe(socket);
  }

  async startUdpEntry(entry) {
    const publicSocket = this.createUdpSocket("udp6");
    publicSocket.on("message", (message, remote) => this.handleUdpMessage(entry, publicSocket, message, remote));
    publicSocket.on("error", (error) => {
      entry.status = "error";
      entry.lastError = error.message;
      entry.retryAt = Date.now() + RETRY_DELAY_MS;
    });
    try {
      const address = await bindUdp(publicSocket, entry.publicPort, PUBLIC_IPV6_HOST, true);
      entry.udpSockets.push(publicSocket);
      entry.listeners.push({ protocol: "udp", family: "ipv6", host: address.address, port: address.port });
    } catch (error) {
      await closeUdpSocket(publicSocket);
      if (error.code === "EADDRINUSE" && !entry.proxyFrp) {
        entry.status = "direct";
        entry.warning = `公网 UDP 端口 ${entry.publicPort} 已由目标服务占用，按目标服务自身 IPv6 监听直连。`;
        return;
      }
      throw error;
    }

    if (!entry.proxyFrp) return;
    const loopbackSocket = this.createUdpSocket("udp4");
    loopbackSocket.on("message", (message, remote) => this.handleUdpMessage(entry, loopbackSocket, message, remote));
    loopbackSocket.on("error", (error) => {
      entry.status = "error";
      entry.lastError = error.message;
      entry.retryAt = Date.now() + RETRY_DELAY_MS;
    });
    try {
      const address = await bindUdp(loopbackSocket, entry.publicPort, LOOPBACK_HOST, false);
      entry.udpSockets.push(loopbackSocket);
      entry.listeners.push({ protocol: "udp", family: "ipv4", host: address.address, port: address.port });
    } catch (error) {
      await closeUdpSocket(loopbackSocket);
      throw new Error(`无法建立 88FRP UDP 回环中继 127.0.0.1:${entry.publicPort}：${error.message}`);
    }
  }

  handleUdpMessage(entry, listenerSocket, message, remote) {
    const key = `${listenerSocket.address().family}|${remote.address}|${remote.port}`;
    let session = entry.sessions.get(key);
    if (!session) {
      const targetType = net.isIP(entry.targetHost) === 6 ? "udp6" : "udp4";
      const targetSocket = this.createUdpSocket(targetType);
      session = {
        socket: targetSocket,
        key,
        remoteAddress: remote.address,
        remotePort: remote.port,
        listenerSocket,
        timer: null,
        lastActivity: Date.now(),
      };
      targetSocket.on("message", (response) => {
        session.lastActivity = Date.now();
        listenerSocket.send(response, session.remotePort, session.remoteAddress, () => undefined);
      });
      targetSocket.on("error", (error) => {
        entry.lastError = error.message;
        this.closeUdpSession(entry, key);
      });
      entry.sessions.set(key, session);
    }
    session.lastActivity = Date.now();
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.closeUdpSession(entry, key), UDP_SESSION_IDLE_MS);
    if (typeof session.timer.unref === "function") session.timer.unref();
    session.socket.send(message, entry.targetPort, entry.targetHost, () => undefined);
  }

  closeUdpSession(entry, key) {
    const session = entry.sessions.get(key);
    if (!session) return;
    entry.sessions.delete(key);
    clearTimeout(session.timer);
    try {
      session.socket.close();
    } catch {
      // The session may have failed before binding.
    }
  }

  async stopEntry(id, reason = "manual") {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    await this.closeEntry(entry);
    await this.audit("relay.stop", "success", {
      id: entry.id,
      kind: entry.kind,
      publicPort: entry.publicPort,
      reason,
    });
    return true;
  }

  async closeEntry(entry) {
    for (const key of [...entry.sessions.keys()]) this.closeUdpSession(entry, key);
    for (const socket of entry.udpSockets) await closeUdpSocket(socket);
    for (const socket of entry.tcpSockets) {
      try {
        socket.destroy();
      } catch {
        // The socket may already have been closed by the peer.
      }
    }
    entry.tcpSockets.clear();
    for (const server of entry.tcpServers) {
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
          server.closeAllConnections?.();
        } catch {
          resolve();
        }
      });
    }
    entry.udpSockets = [];
    entry.tcpServers = [];
    entry.listeners = [];
  }

  async stopAll() {
    for (const id of [...this.entries.keys()]) await this.stopEntry(id, "shutdown");
  }

  async audit(action, outcome, detail) {
    if (this.store?.appendAudit) await this.store.appendAudit(action, outcome, detail);
  }
}

module.exports = {
  LOOPBACK_HOST,
  PUBLIC_IPV6_HOST,
  RETRY_DELAY_MS,
  RelayManager,
  UDP_SESSION_IDLE_MS,
  buildRelayPlan,
  describeTarget,
  samePlanEntry,
};
