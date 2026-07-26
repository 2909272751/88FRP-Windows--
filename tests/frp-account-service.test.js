const test = require("node:test");
const assert = require("node:assert/strict");
const { FrpAccountService } = require("../src/core/frp-account-service");

class MemoryStore {
  constructor() { this.account = {}; }
  async getFrpAccount() { return this.account; }
  async saveFrpAccount(value) { this.account = value; return value; }
  async clearFrpAccount() { this.account = {}; }
}

const credentials = {
  async protect(value) { return `protected:${value}`; },
  async unprotect(value) { return String(value).replace(/^protected:/, ""); },
};

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

test("连接账号默认保存密码并仅返回脱敏状态", async () => {
  const store = new MemoryStore();
  const service = new FrpAccountService({
    store,
    credentialStore: credentials,
    fetchImpl: async () => response(200, { success: true, data: { token: "token-1" } }),
  });

  const status = await service.connect({ username: "demo@example.com", password: "secret" });

  assert.equal(status.connected, true);
  assert.equal(status.username, "demo@example.com");
  assert.equal(status.autoLoginEnabled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(status, "token"), false);
  assert.equal(store.account.encryptedPassword, "protected:secret");
  assert.equal(store.account.encryptedToken, "protected:token-1");
});

test("令牌失效时仅在允许自动登录且保存密码的情况下重新登录", async () => {
  const store = new MemoryStore();
  store.account = {
    username: "demo@example.com",
    encryptedToken: "protected:expired",
    encryptedPassword: "protected:secret",
    autoLoginEnabled: true,
  };
  const requests = [];
  const service = new FrpAccountService({
    store,
    credentialStore: credentials,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/subscriptions/mine") && options.headers.Authorization === "Bearer expired") {
        return response(401, { success: false, message: "expired" });
      }
      if (url.endsWith("/auth/login")) return response(200, { success: true, data: { token: "fresh" } });
      if (url.endsWith("/subscriptions/mine")) return response(200, { success: true, data: [] });
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await service.refreshTunnelLabels();

  assert.equal(result.reason, "updated");
  assert.equal(store.account.encryptedToken, "protected:fresh");
  assert.equal(requests.filter((item) => item.url.endsWith("/auth/login")).length, 1);
});
