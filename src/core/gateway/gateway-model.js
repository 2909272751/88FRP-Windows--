"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

const RESERVED_SERVICE_NAMES = new Set(["admin", "root", "portal", "www", "v4", "v6", "ssh-v4", "ssh-v6"]);
const MANAGED_DNS_COMMENT = "88FRP Gateway 自动管理；请勿手工修改";
const LEGACY_MANAGED_DNS_COMMENT = "由 88FRP 域名绑定自动创建，请勿手工删除";
const DEFAULT_GATEWAY_PORT = 7777;
const DEFAULT_ADMIN_PORT = 8801;
const MIN_DNS_CHECK_INTERVAL_MS = 5_000;

const DEFAULT_STATE = {
  version: 1,
  initialized: false,
  migratedAt: "",
  device: {
    name: "",
    domain: "",
    gatewayPort: DEFAULT_GATEWAY_PORT,
    ipv6Mode: "auto",
    manualIpv6: "",
    autoStart: true,
    createdAt: "",
    updatedAt: "",
  },
  source: {
    legacyInstanceId: "",
    migratedInstanceName: "",
    createdAt: "",
    updatedAt: "",
  },
  cloudflare: {
    encryptedToken: "",
    zoneName: "",
    zoneId: "",
    ttl: 60,
    lastSyncAt: "",
    lastCheckAt: "",
    lastError: "",
    lastTarget: null,
    lastSummary: null,
    managedRecordIds: {},
  },
  settings: {
    dnsCheckIntervalMs: MIN_DNS_CHECK_INTERVAL_MS,
    firewallManaged: false,
  },
  ssh: {
    enabled: false,
    localHost: "127.0.0.1",
    localPort: 22,
    remotePort: 0,
  },
  services: [],
};

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizePort(value, label, { allowZero = false } = {}) {
  const port = Number(value);
  if (allowZero && port === 0) return 0;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}必须是 1 到 65535 的端口号。`);
  }
  return port;
}

function normalizeDomain(value) {
  let domain = String(value || "").trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!domain) return "";
  if (domain === "localhost" || net.isIP(domain)) {
    throw new Error("设备域名必须是可公开解析的域名，不能使用 IP 或 localhost。");
  }
  if (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes("..")) {
    throw new Error("设备域名格式不正确。例如：xps.example.com");
  }
  if (!domain.includes(".")) throw new Error("设备域名至少需要包含一个点，例如 xps.example.com。");
  return domain;
}

function normalizeServiceName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name) throw new Error("子域名前缀不能为空。");
  if (name.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error("子域名只能使用小写字母、数字和中间的连字符，最长 63 个字符。");
  }
  if (RESERVED_SERVICE_NAMES.has(name)) {
    throw new Error(`子域名 ${name} 是系统保留名称，请换一个。`);
  }
  return name;
}

function slugifyServiceName(value, fallback = "service") {
  const slug = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  if (slug && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) && !RESERVED_SERVICE_NAMES.has(slug)) {
    return slug;
  }
  return fallback;
}

function uniqueServiceName(base, existingNames) {
  const used = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
  let candidate = slugifyServiceName(base);
  if (!used.has(candidate)) return candidate;
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${index}`;
    candidate = `${slugifyServiceName(base).slice(0, 63 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(candidate) && !RESERVED_SERVICE_NAMES.has(candidate)) return candidate;
  }
  throw new Error("无法生成唯一服务名，请手动指定。");
}

function normalizeLocalHost(value) {
  const host = String(value || "127.0.0.1").trim();
  if (!host || host.length > 253 || /[\s/:?#[\]@]/.test(host) && net.isIP(host) === 0) {
    if (net.isIP(host) === 0) throw new Error("本地地址格式不正确。");
  }
  if (net.isIP(host) !== 0) return host;
  if (host.toLowerCase() === "localhost") return "localhost";
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes("..")) {
    throw new Error("本地地址格式不正确。");
  }
  return host;
}

function normalizeTitle(value, fallback) {
  const title = String(value || "").trim() || fallback || "未命名服务";
  if (title.length > 80 || /[\u0000-\u001f]/.test(title)) throw new Error("服务名称最多 80 个字符，且不能包含控制字符。");
  return title;
}

function normalizeTag(value) {
  const tag = String(value || "").trim() || "服务";
  if (tag.length > 24 || /[\u0000-\u001f]/.test(tag)) throw new Error("服务标签最多 24 个字符，且不能包含控制字符。");
  return tag;
}

function normalizeDescription(value) {
  const description = String(value || "").trim();
  if (description.length > 240 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(description)) {
    throw new Error("服务说明最多 240 个字符，且不能包含控制字符。");
  }
  return description;
}

function normalizeService(raw, existing = null) {
  const kind = String(raw.kind || existing?.kind || "http").toLowerCase();
  if (!["http", "udp", "tcp"].includes(kind)) throw new Error("服务类型必须是 http、tcp 或 udp。");
  const localPort = normalizePort(raw.localPort ?? existing?.localPort, "本地端口");
  const remotePort = kind === "udp"
    ? normalizePort(raw.remotePort ?? existing?.remotePort, "公网 UDP 端口")
    : kind === "tcp"
      ? normalizePort(raw.remotePort ?? existing?.remotePort, "公网 TCP 端口")
      : 0;
  const createdAt = existing?.createdAt || raw.createdAt || nowIso();
  const normalizedTag = normalizeTag(raw.tag ?? existing?.tag);
  const normalizedDescription = normalizeDescription(raw.description ?? existing?.description);
  return {
    id: existing?.id || raw.id || crypto.randomUUID(),
    kind,
    name: normalizeServiceName(raw.name ?? existing?.name),
    title: normalizeTitle(raw.title ?? existing?.title, raw.name ?? existing?.name),
    tag: normalizedTag === "旧服务" ? (kind === "http" ? "网页服务" : normalizedTag) : normalizedTag,
    description: normalizedDescription.startsWith("从旧版隧道导入") ? "" : normalizedDescription,
    localHost: normalizeLocalHost(raw.localHost ?? existing?.localHost),
    localPort,
    remotePort,
    enabled: raw.enabled === undefined ? (existing?.enabled ?? true) : Boolean(raw.enabled),
    createdAt,
    updatedAt: raw.updatedAt || existing?.updatedAt || nowIso(),
  };
}

function normalizeSsh(raw = {}) {
  const enabled = Boolean(raw.enabled);
  const remotePort = raw.remotePort === "" || raw.remotePort === null || raw.remotePort === undefined
    ? 0
    : normalizePort(raw.remotePort, "SSH 公网端口", { allowZero: true });
  if (enabled && !remotePort) throw new Error("启用 SSH 映射时必须填写公网端口。");
  return {
    enabled,
    localHost: normalizeLocalHost(raw.localHost || "127.0.0.1"),
    localPort: normalizePort(raw.localPort || 22, "SSH 本地端口"),
    remotePort,
  };
}

function normalizeState(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const device = source.device && typeof source.device === "object" ? source.device : {};
  const cloudflare = source.cloudflare && typeof source.cloudflare === "object" ? source.cloudflare : {};
  const sourceInfo = source.source && typeof source.source === "object" ? source.source : {};
  const settings = source.settings && typeof source.settings === "object" ? source.settings : {};
  const domain = normalizeDomain(device.domain || "");
  const ipv6Mode = device.ipv6Mode === "manual" ? "manual" : "auto";
  const manualIpv6 = String(device.manualIpv6 || "").trim().toLowerCase();
  if (manualIpv6 && !isGlobalIPv6(manualIpv6)) throw new Error("手动 IPv6 必须是公网 IPv6 地址。");
  const services = [];
  const seenIds = new Set();
  for (const item of Array.isArray(source.services) ? source.services : []) {
    const normalized = normalizeService(item);
    if (seenIds.has(normalized.id)) normalized.id = crypto.randomUUID();
    seenIds.add(normalized.id);
    services.push(normalized);
  }
  const ssh = normalizeSsh(source.ssh || {});
  const gatewayPort = normalizePort(device.gatewayPort || DEFAULT_GATEWAY_PORT, "统一入口端口");
  const interval = Math.max(MIN_DNS_CHECK_INTERVAL_MS, Number(settings.dnsCheckIntervalMs) || MIN_DNS_CHECK_INTERVAL_MS);
  return {
    ...source,
    version: 1,
    initialized: Boolean(source.initialized),
    migratedAt: String(source.migratedAt || ""),
    device: {
      ...device,
      name: String(device.name || "").trim(),
      domain,
      gatewayPort,
      ipv6Mode,
      manualIpv6,
      autoStart: device.autoStart !== false,
      createdAt: String(device.createdAt || ""),
      updatedAt: String(device.updatedAt || ""),
    },
    source: {
      ...sourceInfo,
      legacyInstanceId: String(sourceInfo.legacyInstanceId || ""),
      migratedInstanceName: String(sourceInfo.migratedInstanceName || ""),
      createdAt: String(sourceInfo.createdAt || ""),
      updatedAt: String(sourceInfo.updatedAt || ""),
    },
    cloudflare: {
      ...cloudflare,
      encryptedToken: String(cloudflare.encryptedToken || ""),
      zoneName: String(cloudflare.zoneName || ""),
      zoneId: String(cloudflare.zoneId || ""),
      ttl: Math.max(60, Math.min(86_400, Number(cloudflare.ttl) || 60)),
      lastSyncAt: String(cloudflare.lastSyncAt || ""),
      lastCheckAt: String(cloudflare.lastCheckAt || ""),
      lastError: String(cloudflare.lastError || ""),
      lastTarget: cloudflare.lastTarget && typeof cloudflare.lastTarget === "object" ? cloudflare.lastTarget : null,
      lastSummary: cloudflare.lastSummary && typeof cloudflare.lastSummary === "object" ? cloudflare.lastSummary : null,
      managedRecordIds: cloudflare.managedRecordIds && typeof cloudflare.managedRecordIds === "object"
        ? cloudflare.managedRecordIds
        : {},
    },
    settings: {
      ...settings,
      dnsCheckIntervalMs: interval,
      firewallManaged: Boolean(settings.firewallManaged),
    },
    ssh,
    services,
  };
}

function validateServiceSet(state, { adminPort = DEFAULT_ADMIN_PORT } = {}) {
  const names = new Set();
  const udpPorts = new Set();
  const tcpPorts = new Set();
  for (const service of state.services) {
    if (names.has(service.name)) throw new Error(`子域名 ${service.name} 已被其他服务使用。`);
    names.add(service.name);
    if (service.kind === "http" && [state.device.gatewayPort, adminPort].includes(service.localPort)) {
      throw new Error(`服务「${service.title}」不能反向代理到统一入口或管理端口 ${service.localPort}，会形成回环。`);
    }
    if (service.kind === "udp") {
      if (udpPorts.has(service.remotePort)) throw new Error(`UDP 公网端口 ${service.remotePort} 已被其他服务使用。`);
      udpPorts.add(service.remotePort);
    }
    if (service.kind === "tcp") {
      if (tcpPorts.has(service.remotePort)) throw new Error(`TCP 公网端口 ${service.remotePort} 已被其他服务使用。`);
      if (service.remotePort === state.device.gatewayPort) {
        throw new Error(`TCP 公网端口 ${service.remotePort} 不能与统一入口端口相同。`);
      }
      if (service.remotePort === adminPort) {
        throw new Error(`TCP 公网端口 ${service.remotePort} 不能与本机管理端口相同。`);
      }
      tcpPorts.add(service.remotePort);
    }
  }
  if (state.ssh.enabled) {
    if (state.ssh.remotePort === state.device.gatewayPort) {
      throw new Error("SSH 公网端口不能与统一入口 TCP 端口相同。");
    }
    if (state.ssh.remotePort === adminPort) {
      throw new Error("SSH 公网端口不能与本机管理端口相同。");
    }
    if (tcpPorts.has(state.ssh.remotePort)) {
      throw new Error("SSH 公网端口与 TCP 直通服务冲突。");
    }
  }
  return true;
}

function isGlobalIPv6(value) {
  const address = String(value || "").trim().toLowerCase();
  if (net.isIP(address) !== 6) return false;
  if (address === "::" || address === "::1" || address.startsWith("fe80:") || address.startsWith("fd") || address.startsWith("fc")) {
    return false;
  }
  const first = address.split(":")[0];
  if (!first) return false;
  const numeric = Number.parseInt(first, 16);
  return Number.isFinite(numeric) && numeric >= 0x2000 && numeric <= 0x3fff;
}

function formatHostPort(host, port) {
  const target = String(host || "127.0.0.1");
  return net.isIP(target) === 6 ? `[${target}]:${port}` : `${target}:${port}`;
}

function lineDomain(domain, family = "auto") {
  const base = String(domain || "").trim();
  if (!base) return "";
  if (family === "ipv6") return `v6.${base}`;
  if (family === "ipv4") return `v4.${base}`;
  return base;
}

function publicUrlFor(state, family = "auto") {
  const host = lineDomain(state.device.domain, family);
  if (!host) return "";
  const port = state.device.gatewayPort === 443 ? "" : `:${state.device.gatewayPort}`;
  return `https://${host}${port}`;
}

function publicBaseUrl(state) {
  return publicUrlFor(state, "auto");
}

function publicEndpointUrls(state) {
  return {
    auto: publicUrlFor(state, "auto"),
    ipv6: publicUrlFor(state, "ipv6"),
    ipv4: publicUrlFor(state, "ipv4"),
  };
}

function serviceUrl(state, service) {
  if (!state.device.domain || service.kind !== "http" || !service.enabled) return "";
  const port = state.device.gatewayPort === 443 ? "" : `:${state.device.gatewayPort}`;
  return `https://${service.name}.${state.device.domain}${port}/`;
}

function adminUrl(state) {
  if (!state.device.domain) return "";
  const port = state.device.gatewayPort === 443 ? "" : `:${state.device.gatewayPort}`;
  return `https://admin.${state.device.domain}${port}/`;
}

function sshHost(state, family = "auto") {
  if (!state.device.domain) return "";
  if (family === "ipv6") return `ssh-v6.${state.device.domain}`;
  if (family === "ipv4") return `ssh-v4.${state.device.domain}`;
  return `ssh.${state.device.domain}`;
}

function sshEndpointFor(state, family = "auto") {
  if (!state.ssh.enabled || !state.ssh.remotePort || !state.device.domain) return "";
  return `${sshHost(state, family)}:${state.ssh.remotePort}`;
}

function sshEndpoint(state) {
  return sshEndpointFor(state, "auto");
}

function sshEndpointUrls(state) {
  return {
    auto: sshEndpointFor(state, "auto"),
    ipv6: sshEndpointFor(state, "ipv6"),
    ipv4: sshEndpointFor(state, "ipv4"),
  };
}

function udpEndpoint(state, service) {
  if (!state.device.domain || service.kind !== "udp" || !service.enabled || !service.remotePort) return "";
  return `${state.device.domain}:${service.remotePort}`;
}

function tcpEndpoint(state, service) {
  if (!state.device.domain || service.kind !== "tcp" || !service.enabled || !service.remotePort) return "";
  return `${state.device.domain}:${service.remotePort}`;
}

function caddyPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/"/g, '\\"');
}

function indent(lines, size = 1) {
  const prefix = "\t".repeat(size);
  return lines.map((line) => (line ? `${prefix}${line}` : ""));
}

function buildCaddyfile(state, {
  adminPort = DEFAULT_ADMIN_PORT,
  storageDir,
  accessLogPath,
} = {}) {
  if (!state.device.domain) throw new Error("尚未配置设备域名。");
  const root = state.device.domain;
  const port = state.device.gatewayPort;
  const upstream = (host, localPort) => formatHostPort(host, localPort);
  const proxyBlock = (host, localPort) => [
    `reverse_proxy ${upstream(host, localPort)} {`,
    "\theader_up X-Real-IP {http.request.remote.host}",
    "\theader_up X-Forwarded-Proto https",
    "\theader_up -X-88FRP-Desktop",
    "}",
  ];
  const lines = [
    "{",
    "\tadmin off",
    "\tauto_https disable_redirects",
    "\tservers {",
    "\t\tprotocols h1 h2",
    "\t}",
    storageDir ? `\tstorage file_system "${caddyPath(storageDir)}"` : "",
    "}",
    "",
    `https://${root}:${port}, https://*.${root}:${port} {`,
    "\ttls {",
    "\t\tdns cloudflare {env.CF_API_TOKEN}",
    "\t\tpropagation_delay 10s",
    "\t\tpropagation_timeout -1",
    "\t}",
    "\tencode zstd gzip",
    "\troute {",
    "\t\t@portal {",
    `\t\t\thost ${root} v6.${root} v4.${root}`,
    "\t\t\tpath /",
    "\t\t}",
    "\t\thandle @portal {",
    "\t\t\trewrite * /portal",
    ...indent(proxyBlock("127.0.0.1", adminPort), 3),
    "\t\t}",
    `\t\t@admin host admin.${root}`,
    "\t\thandle @admin {",
    ...indent(proxyBlock("127.0.0.1", adminPort), 3),
    "\t\t}",
  ];

  for (const service of state.services.filter((item) => item.kind === "http" && item.enabled)) {
    const matcher = `svc_${service.id.replace(/-/g, "_")}`;
    lines.push(`\t\t@${matcher} host ${service.name}.${root}`);
    lines.push(`\t\thandle @${matcher} {`);
    lines.push(...indent(proxyBlock(service.localHost, service.localPort), 3));
    lines.push("\t\t}");
  }

  lines.push(
    `\t\t@root host ${root} v6.${root} v4.${root}`,
    "\t\thandle @root {",
    ...indent(proxyBlock("127.0.0.1", adminPort), 3),
    "\t\t}",
    "\t\thandle {",
    '\t\t\trespond "Service not found" 404',
    "\t\t}",
    "\t}",
    accessLogPath ? "\tlog {" : "",
    accessLogPath ? `\t\toutput file "${caddyPath(accessLogPath)}" {` : "",
    accessLogPath ? "\t\t\troll_size 10MiB" : "",
    accessLogPath ? "\t\t\troll_keep 5" : "",
    accessLogPath ? "\t\t}" : "",
    accessLogPath ? "\t\tformat json" : "",
    accessLogPath ? "\t}" : "",
    "}",
    ""
  );
  return lines.filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== "")).join("\n");
}

function splitFrpcBaseConfig(baseConfigText) {
  const normalized = String(baseConfigText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const head = normalized.split(/^\s*\[\[proxies\]\]\s*$/m)[0].trimEnd();
  if (!/^\s*serverAddr\s*=\s*.+$/m.test(head)) {
    throw new Error("连接来源配置缺少 serverAddr，无法生成统一 frpc 配置。");
  }
  return `${head}\n`;
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function buildTunnelNameMap(tunnels = []) {
  const map = {};
  for (const tunnel of tunnels) {
    const name = String(tunnel?.name || "").trim();
    if (!name) continue;
    const localPort = Number(tunnel.localPort);
    const remotePort = Number(tunnel.remotePort);
    if (remotePort) {
      map[`remote:${remotePort}`] = map[`remote:${remotePort}`] || name;
    }
    if (localPort && remotePort) {
      map[`${localPort}:${remotePort}`] = name;
    }
  }
  return map;
}

function buildFrpcConfig(baseConfigText, state, { tunnelNames = {} } = {}) {
  const head = splitFrpcBaseConfig(baseConfigText);
  const resolveName = (fallback, localPort, remotePort) => (
    tunnelNames[`${Number(localPort)}:${Number(remotePort)}`]
    || tunnelNames[`remote:${Number(remotePort)}`]
    || fallback
  );
  const blocks = [
    [
      resolveName("88frp-gateway-http", state.device.gatewayPort, state.device.gatewayPort),
      "tcp",
      "127.0.0.1",
      state.device.gatewayPort,
      state.device.gatewayPort,
    ],
  ];
  if (state.ssh.enabled) {
    const proxied = Number(state.ssh.remotePort) !== Number(state.ssh.localPort);
    const localPort = proxied ? state.ssh.remotePort : state.ssh.localPort;
    blocks.push([
      resolveName("88frp-gateway-ssh", localPort, state.ssh.remotePort),
      "tcp",
      proxied ? "127.0.0.1" : state.ssh.localHost,
      localPort,
      state.ssh.remotePort,
    ]);
  }
  for (const service of state.services.filter((item) => item.kind === "udp" && item.enabled)) {
    const proxied = Number(service.remotePort) !== Number(service.localPort);
    const localPort = proxied ? service.remotePort : service.localPort;
    blocks.push([
      resolveName(`88frp-gateway-udp-${service.name}-${service.id.slice(0, 8)}`, localPort, service.remotePort),
      "udp",
      proxied ? "127.0.0.1" : service.localHost,
      localPort,
      service.remotePort,
    ]);
  }
  for (const service of state.services.filter((item) => item.kind === "tcp" && item.enabled)) {
    const proxied = Number(service.remotePort) !== Number(service.localPort);
    const localPort = proxied ? service.remotePort : service.localPort;
    blocks.push([
      resolveName(`88frp-gateway-tcp-${service.name}-${service.id.slice(0, 8)}`, localPort, service.remotePort),
      "tcp",
      proxied ? "127.0.0.1" : service.localHost,
      localPort,
      service.remotePort,
    ]);
  }

  const lines = [head.trimEnd(), ""];
  for (const [name, type, localIP, localPort, remotePort] of blocks) {
    lines.push(
      "[[proxies]]",
      `name = ${tomlString(name)}`,
      `type = ${tomlString(type)}`,
      `localIP = ${tomlString(localIP)}`,
      `localPort = ${localPort}`,
      `remotePort = ${remotePort}`,
      ""
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function desiredDnsRecords(state, { ipv4, ipv6, zoneName }) {
  const domain = state.device.domain;
  if (!domain || !zoneName) return [];
  const ttl = Math.max(60, Number(state.cloudflare.ttl) || 60);
  const records = [];
  if (ipv4 && net.isIP(ipv4) === 4) {
    records.push({
      key: "root-a",
      type: "A",
      fqdn: domain,
      content: ipv4,
      ttl,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    });
    records.push({
      key: "wildcard-a",
      type: "A",
      fqdn: `*.${domain}`,
      content: ipv4,
      ttl,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    });
    records.push({
      key: "v4-a",
      type: "A",
      fqdn: `v4.${domain}`,
      content: ipv4,
      ttl,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    });
    records.push({
      key: "ssh-v4-a",
      type: "A",
      fqdn: `ssh-v4.${domain}`,
      content: ipv4,
      ttl,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    });
  }
  if (ipv6 && isGlobalIPv6(ipv6)) {
    records.push({
      key: "root-aaaa",
      type: "AAAA",
      fqdn: domain,
      content: ipv6,
      ttl,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    });
    records.push({
      key: "wildcard-aaaa",
      type: "AAAA",
      fqdn: `*.${domain}`,
      content: ipv6,
      ttl,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    });
    records.push({
      key: "v6-aaaa",
      type: "AAAA",
      fqdn: `v6.${domain}`,
      content: ipv6,
      ttl,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    });
    records.push({
      key: "ssh-v6-aaaa",
      type: "AAAA",
      fqdn: `ssh-v6.${domain}`,
      content: ipv6,
      ttl,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    });
  }
  return records;
}

function sameDnsTarget(left, right) {
  if (!left || !right) return false;
  return String(left.domain || "") === String(right.domain || "")
    && String(left.ipv4 || "") === String(right.ipv4 || "")
    && String(left.ipv6 || "") === String(right.ipv6 || "")
    && String(left.zoneName || "") === String(right.zoneName || "");
}

function isManagedDnsRecord(record) {
  const comment = String(record?.comment || "");
  return comment === MANAGED_DNS_COMMENT || comment === LEGACY_MANAGED_DNS_COMMENT;
}

function redactSensitive(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") {
    return value
      .replace(/cfat_[A-Za-z0-9_-]+/g, "cfat_***")
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
      .replace(/((?:token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1***");
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|password|secret|authorization|cookie/i.test(key)) output[key] = "***";
    else output[key] = redactSensitive(item, depth + 1);
  }
  return output;
}

function buildSummary(state) {
  const httpCount = state.services.filter((item) => item.kind === "http").length;
  const tcpCount = state.services.filter((item) => item.kind === "tcp").length;
  const udpCount = state.services.filter((item) => item.kind === "udp").length;
  return {
    title: state.device.name || "本机设备",
    domain: state.device.domain,
    gatewayPort: state.device.gatewayPort,
    baseUrl: publicBaseUrl(state),
    endpoints: publicEndpointUrls(state),
    adminUrl: adminUrl(state),
    sshEndpoint: sshEndpoint(state),
    sshEndpoints: sshEndpointUrls(state),
    serviceCount: state.services.length,
    httpCount,
    tcpCount,
    udpCount,
  };
}

function validateStateForWrite(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("网关状态格式不正确。");
  if (!Array.isArray(state.services)) throw new Error("网关服务列表格式不正确。");
  if (!state.device || typeof state.device !== "object") throw new Error("网关设备配置格式不正确。");
  normalizeDomain(state.device.domain || "");
  normalizePort(state.device.gatewayPort, "统一入口端口");
  validateServiceSet(state);
  return true;
}

module.exports = {
  DEFAULT_ADMIN_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_STATE,
  LEGACY_MANAGED_DNS_COMMENT,
  MANAGED_DNS_COMMENT,
  MIN_DNS_CHECK_INTERVAL_MS,
  RESERVED_SERVICE_NAMES,
  adminUrl,
  buildCaddyfile,
  buildFrpcConfig,
  buildTunnelNameMap,
  buildSummary,
  clone,
  desiredDnsRecords,
  formatHostPort,
  isGlobalIPv6,
  isManagedDnsRecord,
  lineDomain,
  normalizeDomain,
  normalizeLocalHost,
  normalizePort,
  normalizeService,
  normalizeServiceName,
  normalizeSsh,
  normalizeState,
  nowIso,
  publicBaseUrl,
  publicEndpointUrls,
  redactSensitive,
  sameDnsTarget,
  serviceUrl,
  sshEndpointUrls,
  slugifyServiceName,
  splitFrpcBaseConfig,
  tcpEndpoint,
  udpEndpoint,
  uniqueServiceName,
  validateServiceSet,
  validateStateForWrite,
};
