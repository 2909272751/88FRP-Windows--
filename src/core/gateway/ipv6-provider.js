"use strict";

const os = require("node:os");
const { spawn } = require("node:child_process");
const { isGlobalIPv6 } = require("./gateway-model");

function runText(command, args, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* Best effort. */ }
      reject(new Error("IPv6 地址检查超时。"));
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
      else reject(new Error(stderr.trim() || `IPv6 检查命令退出码=${code}`));
    });
  });
}

function scoreCandidate(item, previousAddress) {
  let score = 0;
  const prefixOrigin = String(item.prefixOrigin || "").toLowerCase();
  const suffixOrigin = String(item.suffixOrigin || "").toLowerCase();
  if (item.address === previousAddress) score += 20;
  if (prefixOrigin === "routeradvertisement") score += 50;
  if (suffixOrigin === "link" || suffixOrigin === "linklayeraddress") score += 40;
  else if (suffixOrigin === "random") score += 5;
  else if (suffixOrigin === "dhcp") score -= 10;
  else if (suffixOrigin) score += 12;
  if (Number(item.prefixLength) === 64) score += 10;
  if (item.skipAsSource) score -= 80;
  if (String(item.interfaceName || "").toLowerCase() === "loopback") score -= 100;
  if (/vethernet|virtual|vmware|hyper-v|bluetooth/i.test(item.interfaceName || "")) score -= 4;
  if (/wi-?fi|wlan|ethernet/i.test(item.interfaceName || "")) score += 2;
  return score;
}

function normalizeOrigin(value, kind) {
  const text = String(value ?? "").trim().toLowerCase();
  const prefixMap = { "0": "other", "1": "manual", "2": "wellknown", "3": "dhcp", "4": "routeradvertisement" };
  const suffixMap = { "0": "other", "1": "manual", "2": "wellknown", "3": "dhcp", "4": "link", "5": "random" };
  return (kind === "prefix" ? prefixMap[text] : suffixMap[text]) || text;
}

function deduplicateCandidates(items) {
  const map = new Map();
  for (const item of items) {
    const address = String(item.address || item.IPAddress || item.ip || "").trim().toLowerCase();
    if (!isGlobalIPv6(address)) continue;
    const normalized = {
      address,
      interfaceName: String(item.interfaceName || item.InterfaceAlias || ""),
      suffixOrigin: normalizeOrigin(item.suffixOrigin ?? item.SuffixOrigin, "suffix"),
      prefixOrigin: normalizeOrigin(item.prefixOrigin ?? item.PrefixOrigin, "prefix"),
      prefixLength: Number(item.prefixLength || item.PrefixLength || 64),
      skipAsSource: Boolean(item.skipAsSource ?? item.SkipAsSource),
    };
    const existing = map.get(address);
    if (!existing || scoreCandidate(normalized, "") > scoreCandidate(existing, "")) map.set(address, normalized);
  }
  return [...map.values()];
}

function selectBestCandidate(candidates, previousAddress = "") {
  const sorted = [...candidates].sort((left, right) => {
    const score = scoreCandidate(right, previousAddress) - scoreCandidate(left, previousAddress);
    if (score !== 0) return score;
    if (left.interfaceName !== right.interfaceName) return left.interfaceName.localeCompare(right.interfaceName);
    return left.address.localeCompare(right.address);
  });
  return sorted[0] || null;
}

function candidatesFromNodeInterfaces() {
  const items = [];
  for (const [interfaceName, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      const family = typeof address.family === "string" ? address.family : `IPv${address.family}`;
      if (family !== "IPv6" || address.internal) continue;
      items.push({
        address: address.address,
        interfaceName,
        suffixOrigin: "",
        prefixOrigin: "",
        prefixLength: address.cidr ? Number(String(address.cidr).split("/")[1]) : 64,
      });
    }
  }
  return deduplicateCandidates(items);
}

class Ipv6Provider {
  constructor({ commandRunner = runText, networkInterfaces = os.networkInterfaces } = {}) {
    this.commandRunner = commandRunner;
    this.networkInterfaces = networkInterfaces;
  }

  async listCandidates() {
    if (process.platform === "win32") {
      const script = [
        "$ErrorActionPreference='Stop'",
        "$items = Get-NetIPAddress -AddressFamily IPv6 -AddressState Preferred -ErrorAction Stop",
        "$items = $items | Where-Object { $_.IPAddress -notmatch '^(fe80|::1)' -and $_.PrefixOrigin -ne 'WellKnown' -and $_.InterfaceAlias -notmatch 'Loopback' }",
        "$items | Select-Object IPAddress, InterfaceAlias, PrefixOrigin, SuffixOrigin, PrefixLength, SkipAsSource | ConvertTo-Json -Compress",
      ].join("; ");
      const output = await this.commandRunner(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]
      );
      if (!output) return [];
      const parsed = JSON.parse(output);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      return deduplicateCandidates(items);
    }

    const items = [];
    for (const [interfaceName, addresses] of Object.entries(this.networkInterfaces())) {
      for (const address of addresses || []) {
        const family = typeof address.family === "string" ? address.family : `IPv${address.family}`;
        if (family !== "IPv6" || address.internal) continue;
        items.push({
          address: address.address,
          interfaceName,
          suffixOrigin: "",
          prefixOrigin: "",
          prefixLength: address.cidr ? Number(String(address.cidr).split("/")[1]) : 64,
        });
      }
    }
    return deduplicateCandidates(items);
  }

  async detect({ previousAddress = "" } = {}) {
    let candidates = [];
    let warning = "";
    try {
      candidates = await this.listCandidates();
    } catch (error) {
      warning = error.message;
      candidates = candidatesFromNodeInterfaces();
    }
    if (!candidates.length) {
      return {
        address: "",
        interfaceName: "",
        candidates: [],
        warning: warning || "没有检测到公网 IPv6，请确认网络已下发 IPv6。",
      };
    }
    const best = selectBestCandidate(candidates, previousAddress);
    return {
      address: best.address,
      interfaceName: best.interfaceName,
      candidates,
      warning,
    };
  }
}

module.exports = {
  Ipv6Provider,
  candidatesFromNodeInterfaces,
  deduplicateCandidates,
  normalizeOrigin,
  runText,
  scoreCandidate,
  selectBestCandidate,
};
