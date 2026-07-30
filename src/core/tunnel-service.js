function normalizeLineEndings(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

function parseScalarValue(value) {
  const trimmed = String(value || "").trim();
  const quoted = trimmed.match(/^["'](.*)["']$/);
  if (quoted) {
    return quoted[1];
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function parseStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const source = String(value || "").trim();
  if (!source) return [];
  if (source.startsWith("[") && source.endsWith("]")) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch {
      return source.slice(1, -1).split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
  }
  return [source];
}

function normalizeGroupName(value, { strict = false } = {}) {
  const source = String(value || "").replace(/[\r\n\t]+/g, " ").trim().replace(/\s+/g, " ");
  if (!source) return "";
  if (source.length > 40 || /[\u0000-\u001f]/.test(source)) {
    if (strict) throw new Error("分组名称最多 40 个字符，且不能包含控制字符。");
    return source.slice(0, 40).trim();
  }
  return source;
}

function displayNameForGrouping(tunnel) {
  return String(tunnel.displayName || tunnel.name || "").trim();
}

function explicitGroupPrefix(name) {
  const match = String(name || "").trim().match(/^(.+?)[\s_\-/|:：]+\S/);
  return match ? normalizeGroupName(match[1]) : "";
}

function commonGroupPrefix(left, right) {
  const a = Array.from(String(left || "").trim());
  const b = Array.from(String(right || "").trim());
  const shared = [];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index].toLocaleLowerCase() !== b[index].toLocaleLowerCase()) break;
    shared.push(a[index]);
  }
  const value = normalizeGroupName(shared.join("").replace(/[\s_\-/|:：]+$/, ""));
  if (!value) return "";
  const includesChinese = /[\u3400-\u9fff]/.test(value);
  if (includesChinese) return value;
  return Array.from(value).length >= 4 ? value : "";
}

function inferTunnelGroups(tunnels, groupOverrides = {}) {
  const labels = tunnels.map((tunnel) => ({
    name: tunnel.name,
    label: displayNameForGrouping(tunnel),
  }));
  const automatic = new Map();

  for (const item of labels) {
    const explicit = explicitGroupPrefix(item.label);
    if (explicit) automatic.set(item.name, explicit);
  }

  for (const item of labels) {
    if (automatic.has(item.name)) continue;
    let candidate = "";
    for (const other of labels) {
      if (other.name === item.name) continue;
      const shared = commonGroupPrefix(item.label, other.label);
      if (Array.from(shared).length > Array.from(candidate).length) candidate = shared;
    }
    if (candidate) automatic.set(item.name, candidate);
  }

  return tunnels.map((tunnel) => {
    const groupOverride = normalizeGroupName(groupOverrides[tunnel.name]);
    const automaticGroup = automatic.get(tunnel.name) || "";
    return {
      ...tunnel,
      group: groupOverride || automaticGroup || "未分组",
      groupSource: groupOverride ? "manual" : automaticGroup ? "automatic" : "none",
      groupOverride,
    };
  });
}

function parseFrpcServerAddr(configText) {
  const normalized = normalizeLineEndings(configText);
  const head = normalized.split(/^\s*\[\[proxies\]\]\s*$/m)[0] || normalized;
  const fields = parseProxyFields(head.split("\n"));
  return String(fields.serverAddr || fields.server_addr || "").trim();
}

function parseProxyFields(lines) {
  const fields = {};
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!match) {
      continue;
    }
    fields[match[1]] = parseScalarValue(match[2]);
  }
  return fields;
}

function parseFrpcTunnels(configText) {
  const normalized = normalizeLineEndings(configText);
  const lines = normalized.split("\n");
  const blocks = [];
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[\[proxies\]\]\s*$/.test(line)) {
      if (current) {
        current.endLine = index;
        current.fields = parseProxyFields(lines.slice(current.startLine, current.endLine));
        blocks.push(current);
      }
      current = {
        startLine: index,
        endLine: lines.length,
        fields: {},
      };
      continue;
    }
  }

  if (current) {
    current.fields = parseProxyFields(lines.slice(current.startLine, current.endLine));
    blocks.push(current);
  }

  return blocks
    .map((block, index) => {
      const name = String(block.fields.name || "").trim();
      return {
        id: name || `proxy-${index + 1}`,
        name: name || `proxy-${index + 1}`,
        type: block.fields.type || "",
        localIP: block.fields.localIP || block.fields.localIp || "",
        localPort: block.fields.localPort ?? "",
        remotePort: block.fields.remotePort ?? "",
        customDomains: parseStringList(block.fields.customDomains || block.fields.custom_domains),
        subdomain: String(block.fields.subdomain || "").trim(),
        startLine: block.startLine,
        endLine: block.endLine,
      };
    })
    .filter((tunnel) => tunnel.name);
}

function buildRuntimeConfig(configText, selection) {
  const normalized = normalizeLineEndings(configText);
  const lines = normalized.split("\n");
  const tunnels = parseFrpcTunnels(normalized);

  if (!tunnels.length) {
    return normalized;
  }

  const ranges = tunnels.map((tunnel) => ({
    startLine: tunnel.startLine,
    endLine: tunnel.endLine,
    enabled: Boolean(selection[tunnel.name]),
  }));
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const range = ranges.find((item) => index >= item.startLine && index < item.endLine);
    if (range && !range.enabled) {
      continue;
    }
    output.push(lines[index]);
  }

  return output.join("\n").trimEnd() + "\n";
}

class TunnelService {
  constructor({ store }) {
    this.store = store;
  }

  async list(instanceId) {
    const configText = await this.store.readConfig(instanceId);
    const [selection, labels, groupOverrides] = await Promise.all([
      this.store.getTunnelSelection(instanceId),
      this.store.getTunnelLabels(instanceId),
      typeof this.store.getTunnelGroupOverrides === "function" ? this.store.getTunnelGroupOverrides(instanceId) : Promise.resolve({}),
    ]);
    const parsed = parseFrpcTunnels(configText).map((tunnel) => ({
      ...tunnel,
      displayName: labels[tunnel.name] && labels[tunnel.name].displayName ? labels[tunnel.name].displayName : "",
      enabled: Boolean(selection[tunnel.name]),
    }));
    const tunnels = inferTunnelGroups(parsed, groupOverrides);

    return {
      instanceId,
      tunnels,
      selection,
      groupOverrides,
    };
  }

  async applyLabels(instanceId, labels) {
    const tunnels = parseFrpcTunnels(await this.store.readConfig(instanceId));
    const nextLabels = {};
    for (const tunnel of tunnels) {
      if (labels[tunnel.name]) nextLabels[tunnel.name] = labels[tunnel.name];
    }
    await this.store.saveTunnelLabels(instanceId, nextLabels);
    return nextLabels;
  }

  async reconcileSelection(instanceId) {
    const configText = await this.store.readConfig(instanceId);
    const tunnels = parseFrpcTunnels(configText);
    const currentSelection = await this.store.getTunnelSelection(instanceId);
    const currentGroups = await this.store.getTunnelGroupOverrides(instanceId);
    const nextSelection = {};
    const nextGroups = {};

    for (const tunnel of tunnels) {
      nextSelection[tunnel.name] = Boolean(currentSelection[tunnel.name]);
      const group = normalizeGroupName(currentGroups[tunnel.name]);
      if (group) nextGroups[tunnel.name] = group;
    }

    await this.store.saveTunnelSelection(instanceId, nextSelection);
    await this.store.saveTunnelGroupOverrides(instanceId, nextGroups);
    return nextSelection;
  }

  async saveSelection(instanceId, selection) {
    const tunnels = parseFrpcTunnels(await this.store.readConfig(instanceId));
    const allowed = new Set(tunnels.map((tunnel) => tunnel.name));
    const nextSelection = {};

    for (const tunnelName of allowed) {
      nextSelection[tunnelName] = Boolean(selection[tunnelName]);
    }

    await this.store.saveTunnelSelection(instanceId, nextSelection);
    return this.list(instanceId);
  }

  async saveGroupOverrides(instanceId, groupOverrides) {
    const tunnels = parseFrpcTunnels(await this.store.readConfig(instanceId));
    const nextGroups = {};
    for (const tunnel of tunnels) {
      const group = normalizeGroupName(groupOverrides && groupOverrides[tunnel.name], { strict: true });
      if (group) nextGroups[tunnel.name] = group;
    }
    await this.store.saveTunnelGroupOverrides(instanceId, nextGroups);
    return this.list(instanceId);
  }

  async prepareRuntimeConfig(instanceId) {
    const configText = await this.store.readConfig(instanceId);
    const selection = await this.reconcileSelection(instanceId);
    const runtimeConfig = buildRuntimeConfig(configText, selection);
    await this.store.saveRuntimeConfig(instanceId, runtimeConfig);
    return this.store.getRuntimeConfigPath(instanceId);
  }
}

module.exports = {
  TunnelService,
  buildRuntimeConfig,
  inferTunnelGroups,
  normalizeGroupName,
  parseFrpcServerAddr,
  parseFrpcTunnels,
};
