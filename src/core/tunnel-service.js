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
    const selection = await this.store.getTunnelSelection(instanceId);
    const labels = await this.store.getTunnelLabels(instanceId);
    const tunnels = parseFrpcTunnels(configText).map((tunnel) => ({
      ...tunnel,
      displayName: labels[tunnel.name] && labels[tunnel.name].displayName ? labels[tunnel.name].displayName : "",
      enabled: Boolean(selection[tunnel.name]),
    }));

    return {
      instanceId,
      tunnels,
      selection,
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
    const nextSelection = {};

    for (const tunnel of tunnels) {
      nextSelection[tunnel.name] = Boolean(currentSelection[tunnel.name]);
    }

    await this.store.saveTunnelSelection(instanceId, nextSelection);
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
  parseFrpcTunnels,
};
