const test = require("node:test");
const assert = require("node:assert/strict");

const { CloudflareDnsService } = require("../src/core/gateway/cloudflare-dns");
const { MANAGED_DNS_COMMENT } = require("../src/core/gateway/gateway-model");

function jsonResponse(result, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { success: status >= 200 && status < 300, result, errors: [] };
    },
  };
}

function desiredRecord(key, type, fqdn, content) {
  return {
    key,
    type,
    fqdn,
    content,
    ttl: 60,
    proxied: false,
    comment: MANAGED_DNS_COMMENT,
  };
}

test("IPv6 消失后只删除本机账本中的过期 AAAA 记录", async () => {
  const deleted = [];
  const records = {
    a1: {
      id: "a1",
      type: "A",
      name: "xps.example.com",
      content: "203.0.113.7",
      ttl: 60,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    },
    a2: {
      id: "a2",
      type: "A",
      name: "*.xps.example.com",
      content: "203.0.113.7",
      ttl: 60,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    },
    aaaa1: {
      id: "aaaa1",
      type: "AAAA",
      name: "xps.example.com",
      content: "2408:8207::1",
      ttl: 60,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    },
    aaaa2: {
      id: "aaaa2",
      type: "AAAA",
      name: "*.xps.example.com",
      content: "2408:8207::1",
      ttl: 60,
      proxied: false,
      comment: MANAGED_DNS_COMMENT,
    },
  };
  const service = new CloudflareDnsService({
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (options.method === "GET" && parsed.pathname === "/client/v4/zones/zone-id/dns_records") {
        const type = parsed.searchParams.get("type");
        const name = parsed.searchParams.get("name");
        return jsonResponse(Object.values(records).filter((item) => item.type === type && item.name === name));
      }
      if (options.method === "GET" && parsed.pathname.startsWith("/client/v4/zones/zone-id/dns_records/")) {
        return jsonResponse(records[parsed.pathname.split("/").pop()]);
      }
      if (options.method === "DELETE") {
        deleted.push(parsed.pathname.split("/").pop());
        return jsonResponse({ id: deleted.at(-1) });
      }
      throw new Error(`Unexpected request: ${options.method} ${parsed.pathname}`);
    },
  });

  const result = await service.syncRecords({
    token: "token",
    zoneId: "zone-id",
    desiredRecords: [
      desiredRecord("root-a", "A", "xps.example.com", "203.0.113.7"),
      desiredRecord("wildcard-a", "A", "*.xps.example.com", "203.0.113.7"),
    ],
    managedRecordIds: { "root-a": "a1", "wildcard-a": "a2", "root-aaaa": "aaaa1", "wildcard-aaaa": "aaaa2" },
    allowedNames: ["xps.example.com", "*.xps.example.com"],
  });

  assert.deepEqual(deleted.sort(), ["aaaa1", "aaaa2"]);
  assert.deepEqual(result.managedRecordIds, { "root-a": "a1", "wildcard-a": "a2" });
  assert.equal(result.results.filter((item) => item.action === "deleted").length, 2);
});

test("备注或域名范围不匹配时绝不删除旧记录", async () => {
  let deleteCalls = 0;
  const service = new CloudflareDnsService({
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (options.method === "GET" && parsed.pathname === "/client/v4/zones/zone-id/dns_records") {
        return jsonResponse([]);
      }
      if (options.method === "GET" && parsed.pathname.endsWith("/manual-record")) {
        return jsonResponse({
          id: "manual-record",
          type: "AAAA",
          name: "manual.example.com",
          content: "2408:8207::2",
          comment: "",
        });
      }
      if (options.method === "DELETE") {
        deleteCalls += 1;
        return jsonResponse({ id: "manual-record" });
      }
      throw new Error(`Unexpected request: ${options.method} ${parsed.pathname}`);
    },
  });

  const result = await service.syncRecords({
    token: "token",
    zoneId: "zone-id",
    desiredRecords: [],
    managedRecordIds: { "root-aaaa": "manual-record" },
    allowedNames: ["xps.example.com", "*.xps.example.com"],
  });

  assert.equal(deleteCalls, 0);
  assert.equal(result.cleanupSkipped.length, 1);
  assert.deepEqual(result.managedRecordIds, {});
});
