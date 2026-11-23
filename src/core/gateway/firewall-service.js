"use strict";

const { spawn } = require("node:child_process");

const RULE_PREFIX = "88FRP Gateway";
const TCP_RULE = `${RULE_PREFIX} TCP`;
const UDP_RULE = `${RULE_PREFIX} UDP`;

function runPowerShell(script, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); ${script}`,
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* Best effort. */ }
      reject(new Error("Windows 防火墙操作超时。"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Windows 防火墙命令退出码=${code}`));
    });
  });
}

function validPorts(values) {
  const unique = [...new Set(values.map(Number).filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))];
  return unique;
}

function parsePortValues(values) {
  const ports = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const text = String(value ?? "").trim();
    if (!text) return;
    for (const part of text.split(",")) {
      const token = part.trim();
      if (!token) continue;
      if (token.includes("-")) {
        const [startText, endText] = token.split("-", 2);
        const start = Number(startText);
        const end = Number(endText);
        if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end <= 65535 && start <= end) {
          for (let port = start; port <= end && ports.length < 1024; port += 1) ports.push(port);
        }
        continue;
      }
      const port = Number(token);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.push(port);
    }
  };
  for (const value of values) visit(value);
  return validPorts(ports);
}

function decorateStatus(status, expectedTcpPorts = [], expectedUdpPorts = []) {
  const expectedTcp = validPorts(expectedTcpPorts);
  const expectedUdp = validPorts(expectedUdpPorts);
  const actualTcp = parsePortValues(status.tcpPorts || []);
  const actualUdp = parsePortValues(status.udpPorts || []);
  const missingTcpPorts = expectedTcp.filter((port) => !actualTcp.includes(port));
  const missingUdpPorts = expectedUdp.filter((port) => !actualUdp.includes(port));
  return {
    ...status,
    tcpPorts: actualTcp,
    udpPorts: actualUdp,
    expectedTcpPorts: expectedTcp,
    expectedUdpPorts: expectedUdp,
    missingTcpPorts,
    missingUdpPorts,
    tcpCovered: expectedTcp.length > 0 && missingTcpPorts.length === 0,
    udpCovered: expectedUdp.length === 0 || missingUdpPorts.length === 0,
  };
}

class FirewallService {
  constructor({ runPowerShellImpl = runPowerShell, cacheTtlMs = 30_000 } = {}) {
    this.runPowerShell = runPowerShellImpl;
    this.cacheTtlMs = cacheTtlMs;
    this.statusCache = null;
    this.statusCacheAt = 0;
    this.statusRefresh = null;
  }

  async getStatus({ expectedTcpPorts = [], expectedUdpPorts = [] } = {}) {
    if (process.platform !== "win32") {
      return {
        supported: false,
        tcpRule: false,
        udpRule: false,
        detail: "仅 Windows 支持自动防火墙规则。",
      };
    }
    const fresh = this.statusCache && Date.now() - this.statusCacheAt < this.cacheTtlMs;
    if (!fresh) this.refreshStatusInBackground();
    if (this.statusCache) {
      return {
        ...decorateStatus(this.statusCache, expectedTcpPorts, expectedUdpPorts),
        cached: true,
      };
    }
    return {
      supported: true,
      tcpRule: false,
      udpRule: false,
      pending: true,
      detail: "正在后台检查防火墙规则…",
    };
  }

  refreshStatusInBackground() {
    if (this.statusRefresh) return this.statusRefresh;
    this.statusRefresh = this.readStatus()
      .then((status) => {
        this.statusCache = status;
        this.statusCacheAt = Date.now();
        return status;
      })
      .catch(() => this.statusCache)
      .finally(() => {
        this.statusRefresh = null;
      });
    return this.statusRefresh;
  }

  async readStatus() {
    try {
      const output = await this.runPowerShell(
        `$tcp=Get-NetFirewallRule -DisplayName '${TCP_RULE}' -ErrorAction SilentlyContinue;`
        + `$udp=Get-NetFirewallRule -DisplayName '${UDP_RULE}' -ErrorAction SilentlyContinue;`
        + "$tcpPorts=@();$udpPorts=@();"
        + "if($tcp){$tcpPorts=@($tcp|Get-NetFirewallPortFilter|Select-Object -ExpandProperty LocalPort)};"
        + "if($udp){$udpPorts=@($udp|Get-NetFirewallPortFilter|Select-Object -ExpandProperty LocalPort)};"
        + "$profiles=@(Get-NetFirewallProfile -ErrorAction SilentlyContinue|ForEach-Object{[pscustomobject]@{name=[string]$_.Name;enabled=[bool]$_.Enabled}});"
        + "$enabled=@($profiles|Where-Object{$_.enabled}).Count -gt 0;"
        + "[pscustomobject]@{tcp=[bool]$tcp;udp=[bool]$udp;tcpPorts=$tcpPorts;udpPorts=$udpPorts;firewallEnabled=$enabled;profiles=$profiles}|ConvertTo-Json -Compress -Depth 5",
        10_000
      );
      const value = JSON.parse(output || "{}");
      return {
        supported: true,
        tcpRule: Boolean(value.tcp),
        udpRule: Boolean(value.udp),
        tcpPorts: Array.isArray(value.tcpPorts) ? value.tcpPorts : [],
        udpPorts: Array.isArray(value.udpPorts) ? value.udpPorts : [],
        firewallEnabled: Boolean(value.firewallEnabled),
        profiles: Array.isArray(value.profiles) ? value.profiles : [],
      };
    } catch (error) {
      return {
        supported: true,
        tcpRule: false,
        udpRule: false,
        firewallEnabled: null,
        detail: error.message,
      };
    }
  }

  async ensureRules({
    gatewayPort,
    sshPublicPort,
    sshEnabled,
    tcpPublicPorts = [],
    udpPublicPorts = [],
  }) {
    if (process.platform !== "win32") throw new Error("自动开放防火墙端口仅支持 Windows。");
    const tcp = validPorts([
      gatewayPort,
      ...(sshEnabled ? [sshPublicPort] : []),
      ...tcpPublicPorts,
    ]);
    const udp = validPorts(udpPublicPorts);
    if (!tcp.length) throw new Error("没有需要开放的 TCP 端口。");
    const tcpText = tcp.join(",");
    const udpText = udp.join(",");
    const script = [
      `$tcpPorts=@(${tcpText})`,
      `$tcpRule=Get-NetFirewallRule -DisplayName '${TCP_RULE}' -ErrorAction SilentlyContinue`,
      "if ($tcpRule) {",
      `  $tcpRule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any -ErrorAction Stop`,
      `  $tcpRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $tcpPorts -ErrorAction Stop`,
      "} else {",
      `  New-NetFirewallRule -DisplayName '${TCP_RULE}' -Group '${RULE_PREFIX}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $tcpPorts -Profile Any -ErrorAction Stop | Out-Null`,
      "}",
      udp.length
        ? [
          `$udpPorts=@(${udpText})`,
          `$udpRule=Get-NetFirewallRule -DisplayName '${UDP_RULE}' -ErrorAction SilentlyContinue`,
          "if ($udpRule) {",
          `  $udpRule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any -ErrorAction Stop`,
          `  $udpRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol UDP -LocalPort $udpPorts -ErrorAction Stop`,
          "} else {",
          `  New-NetFirewallRule -DisplayName '${UDP_RULE}' -Group '${RULE_PREFIX}' -Direction Inbound -Action Allow -Protocol UDP -LocalPort $udpPorts -Profile Any -ErrorAction Stop | Out-Null`,
          "}",
        ].join(";")
        : `Remove-NetFirewallRule -DisplayName '${UDP_RULE}' -ErrorAction SilentlyContinue`,
      "'ok'",
    ].join("; ");
    await this.runPowerShell(script, 25_000);
    this.statusCache = {
      supported: true,
      tcpRule: true,
      udpRule: udp.length > 0,
      tcpPorts: tcp,
      udpPorts: udp,
      firewallEnabled: this.statusCache?.firewallEnabled ?? null,
      profiles: this.statusCache?.profiles || [],
    };
    this.statusCacheAt = Date.now();
    return {
      tcpPorts: tcp,
      udpPorts: udp,
      rules: [TCP_RULE, ...(udp.length ? [UDP_RULE] : [])],
    };
  }
}

module.exports = {
  RULE_PREFIX,
  TCP_RULE,
  UDP_RULE,
  FirewallService,
  decorateStatus,
  parsePortValues,
  runPowerShell,
  validPorts,
};
