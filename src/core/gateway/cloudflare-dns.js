"use strict";

const { isManagedDnsRecord } = require("./gateway-model");

const CF_API = "https://api.cloudflare.com/client/v4";
const MANAGED_DNS_KEYS = new Set([
  "root-a",
  "wildcard-a",
  "v4-a",
  "ssh-v4-a",
  "root-aaaa",
  "wildcard-aaaa",
  "v6-aaaa",
  "ssh-v6-aaaa",
]);

function managedTypeForKey(key) {
  if (["root-a", "wildcard-a", "v4-a", "ssh-v4-a"].includes(key)) return "A";
  if (["root-aaaa", "wildcard-aaaa", "v6-aaaa", "ssh-v6-aaaa"].includes(key)) return "AAAA";
  return "";
}

function normalizeRecordName(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function friendlyCloudflareError(status, payload) {
  const detail = payload?.errors?.map((item) => item.message).filter(Boolean).join("；");
  if (status === 401 || status === 403) return "Cloudflare Token 无效或缺少 DNS 权限。";
  if (status === 429) return "Cloudflare 请求过于频繁，请稍后重试。";
  if (detail) return `Cloudflare 返回错误：${detail}`;
  return `Cloudflare 请求失败，HTTP ${status}。`;
}

class CloudflareDnsService {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl;
  }

  async request(token, method, apiPath, body = null) {
    let response;
    try {
      response = await this.fetch(`${CF_API}${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error("连接 Cloudflare 超时，请检查网络或代理。");
      }
      throw new Error("无法连接 Cloudflare，请检查网络或代理。");
    }
    let payload = null;
    try { payload = await response.json(); }
    catch { payload = null; }
    if (!response.ok || !payload || payload.success !== true) {
      throw new Error(friendlyCloudflareError(response.status, payload));
    }
    return payload.result;
  }

  async discoverZone(token, domain) {
    const labels = String(domain || "").toLowerCase().split(".").filter(Boolean);
    if (labels.length < 2) throw new Error("设备域名无效。");
    const errors = [];
    for (let index = 1; index < labels.length; index += 1) {
      const candidate = labels.slice(index).join(".");
      try {
        const zones = await this.request(token, "GET", `/zones?name=${encodeURIComponent(candidate)}&per_page=50`);
        if (Array.isArray(zones) && zones.length) {
          const exact = zones.find((zone) => String(zone.name || "").toLowerCase() === candidate);
          if (exact) return { id: exact.id, name: exact.name };
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
    throw new Error(errors[0] || `Token 中找不到 ${domain} 所属的 Cloudflare 域名。`);
  }

  async verifyToken(token, domain) {
    const checks = [];
    const zone = await this.discoverZone(token, domain);
    checks.push({ name: "读取域名", ok: true, detail: `${zone.name} (${zone.id})` });
    const records = await this.request(
      token,
      "GET",
      `/zones/${zone.id}/dns_records?per_page=5`
    );
    checks.push({
      name: "读取解析",
      ok: true,
      detail: `当前至少 ${Array.isArray(records) ? records.length : 0} 条记录`,
    });
    return { ok: true, checks, zone };
  }

  async listRecords(token, zoneId, { type, name }) {
    const params = new URLSearchParams({
      type,
      name,
      per_page: "100",
    });
    const records = await this.request(token, "GET", `/zones/${zoneId}/dns_records?${params}`);
    if (!Array.isArray(records)) throw new Error("Cloudflare 解析列表格式不正确，已停止写入。");
    return records;
  }

  async getRecord(token, zoneId, recordId) {
    try {
      return await this.request(
        token,
        "GET",
        `/zones/${zoneId}/dns_records/${encodeURIComponent(recordId)}`
      );
    } catch (error) {
      if (/HTTP 404/.test(error.message)) return null;
      throw error;
    }
  }

  async deleteRecord(token, zoneId, recordId) {
    try {
      await this.request(
        token,
        "DELETE",
        `/zones/${zoneId}/dns_records/${encodeURIComponent(recordId)}`
      );
      return true;
    } catch (error) {
      if (/HTTP 404/.test(error.message)) return false;
      throw error;
    }
  }

  async ensureRecord(token, zoneId, desired, managedRecordIds = {}) {
    const lookup = { type: desired.type, name: desired.fqdn };
    const records = await this.listRecords(token, zoneId, lookup);
    const sameType = records.filter((record) => String(record.type || "").toUpperCase() === desired.type);
    const managed = sameType.filter(isManagedDnsRecord);
    const foreign = sameType.filter((record) => !isManagedDnsRecord(record));
    const foreignConflict = foreign.find((record) => record.content !== desired.content);
    if (foreignConflict) {
      return {
        key: desired.key,
        action: "conflict",
        recordId: foreignConflict.id || managedRecordIds[desired.key] || "",
        message: `${desired.fqdn} 已有一条非本程序管理的 ${desired.type} 记录，为避免覆盖已跳过。`,
      };
    }
    const sameContent = foreign.find((record) => record.content === desired.content);
    const target = managed[0] || null;
    if (target) {
      const changed = target.content !== desired.content
        || Number(target.ttl || 0) !== Number(desired.ttl)
        || target.proxied !== false
        || target.comment !== desired.comment;
      if (!changed) {
        return {
          key: desired.key,
          action: "unchanged",
          recordId: target.id,
          managed: true,
        };
      }
      const updated = await this.request(token, "PATCH", `/zones/${zoneId}/dns_records/${target.id}`, desiredBody(desired));
      return {
        key: desired.key,
        action: "updated",
        recordId: updated?.id || target.id,
        managed: true,
      };
    }
    if (sameContent) {
      return {
        key: desired.key,
        action: "unchanged",
        recordId: sameContent.id,
        managed: false,
      };
    }
    try {
      const created = await this.request(token, "POST", `/zones/${zoneId}/dns_records`, desiredBody(desired));
      return {
        key: desired.key,
        action: "created",
        recordId: created?.id || "",
        managed: true,
      };
    } catch (error) {
      if (!/already exists|81058/i.test(error.message)) throw error;
      const latest = await this.listRecords(token, zoneId, lookup);
      const existing = latest.find((record) => isManagedDnsRecord(record))
        || latest.find((record) => record.content === desired.content);
      if (!existing) throw error;
      return {
        key: desired.key,
        action: "unchanged",
        recordId: existing.id,
        managed: isManagedDnsRecord(existing),
      };
    }
  }

  async cleanupStaleRecords({
    token,
    zoneId,
    desiredKeys,
    managedRecordIds = {},
    allowedNames = [],
  }) {
    const keep = new Set(desiredKeys || []);
    const allowed = new Set((allowedNames || []).map(normalizeRecordName).filter(Boolean));
    const results = [];
    const skipped = [];
    if (!allowed.size) {
      return {
        results,
        skipped: Object.entries(managedRecordIds)
          .filter(([key, recordId]) => !keep.has(key) && Boolean(recordId))
          .map(([key]) => ({ key, action: "kept", message: "缺少允许清理的域名范围，已跳过删除。" })),
      };
    }

    for (const [key, recordId] of Object.entries(managedRecordIds || {})) {
      if (keep.has(key) || !recordId || !MANAGED_DNS_KEYS.has(key)) continue;
      const expectedType = managedTypeForKey(key);
      const record = await this.getRecord(token, zoneId, recordId);
      if (!record) {
        results.push({ key, action: "missing", recordId, managed: true });
        continue;
      }
      const recordName = normalizeRecordName(record.name);
      const recordType = String(record.type || "").toUpperCase();
      if (!isManagedDnsRecord(record) || recordType !== expectedType || !allowed.has(recordName)) {
        skipped.push({
          key,
          action: "kept",
          recordId,
          message: `${record.name || "未知记录"} 不再需要，但备注、类型或域名范围不匹配本程序账本，已保留。`,
        });
        continue;
      }
      const removed = await this.deleteRecord(token, zoneId, recordId);
      results.push({
        key,
        action: removed ? "deleted" : "missing",
        recordId,
        fqdn: record.name,
        type: recordType,
        managed: true,
      });
    }
    return { results, skipped };
  }

  async syncRecords({
    token,
    zoneId,
    desiredRecords,
    managedRecordIds = {},
    allowedNames = [],
  }) {
    const results = [];
    const nextManagedIds = {};
    for (const desired of desiredRecords) {
      const result = await this.ensureRecord(token, zoneId, desired, managedRecordIds);
      results.push(result);
      if (result.managed && result.recordId) nextManagedIds[result.key] = result.recordId;
    }
    const conflicts = results.filter((item) => item.action === "conflict");
    const cleanup = await this.cleanupStaleRecords({
      token,
      zoneId,
      desiredKeys: desiredRecords.map((item) => item.key),
      managedRecordIds,
      allowedNames,
    });
    results.push(...cleanup.results);
    return {
      applied: results.some((item) => ["created", "updated", "deleted"].includes(item.action)),
      conflicts,
      results,
      cleanupSkipped: cleanup.skipped,
      managedRecordIds: nextManagedIds,
    };
  }
}

function desiredBody(desired) {
  return {
    type: desired.type,
    name: desired.fqdn,
    content: desired.content,
    ttl: desired.ttl,
    proxied: false,
    comment: desired.comment,
  };
}

module.exports = {
  CF_API,
  CloudflareDnsService,
  desiredBody,
  friendlyCloudflareError,
  managedTypeForKey,
  normalizeRecordName,
};
