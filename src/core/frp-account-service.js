const API_BASE_URL = "https://api.88frp.com/api";

function sanitizeAccount(account) {
  return {
    connected: Boolean(account && account.encryptedToken),
    username: account && account.username ? account.username : "",
    autoLoginEnabled: Boolean(account && account.autoLoginEnabled),
    lastConnectedAt: account && account.lastConnectedAt ? account.lastConnectedAt : "",
    lastRefreshedAt: account && account.lastRefreshedAt ? account.lastRefreshedAt : "",
    lastError: account && account.lastError ? account.lastError : "",
  };
}

class FrpAccountService {
  constructor({ store, credentialStore, fetchImpl = fetch }) {
    this.store = store;
    this.credentialStore = credentialStore;
    this.fetch = fetchImpl;
  }

  async getStatus() {
    return sanitizeAccount(await this.store.getFrpAccount());
  }

  async connect({ username, password, autoLoginEnabled = true }) {
    if (!String(username || "").trim() || !String(password || "")) {
      throw new Error("请输入 88FRP 账号和密码。");
    }

    const login = await this.login(String(username).trim(), String(password));
    const now = new Date().toISOString();
    await this.store.saveFrpAccount({
      username: String(username).trim(),
      encryptedToken: await this.credentialStore.protect(login.token),
      encryptedPassword: autoLoginEnabled ? await this.credentialStore.protect(String(password)) : "",
      autoLoginEnabled: Boolean(autoLoginEnabled),
      lastConnectedAt: now,
      lastRefreshedAt: "",
      lastError: "",
    });
    return this.getStatus();
  }

  async disconnect() {
    await this.store.clearFrpAccount();
    return this.getStatus();
  }

  async refreshTunnelLabels() {
    const account = await this.store.getFrpAccount();
    if (!account.encryptedToken) {
      return { attempted: false, reason: "not-connected", labels: {} };
    }

    try {
      const token = await this.getUsableToken(account);
      const labels = await this.fetchAllTunnelLabels(token);
      const latestAccount = await this.store.getFrpAccount();
      await this.store.saveFrpAccount({
        ...latestAccount,
        lastRefreshedAt: new Date().toISOString(),
        lastError: "",
      });
      return { attempted: true, reason: "updated", labels };
    } catch (error) {
      await this.store.saveFrpAccount({
        ...account,
        lastError: this.toFriendlyError(error),
      });
      return { attempted: true, reason: "failed", labels: {}, error: this.toFriendlyError(error) };
    }
  }

  async getUsableToken(account) {
    let token = await this.credentialStore.unprotect(account.encryptedToken);
    try {
      await this.fetchJson("/subscriptions/mine", token);
      return token;
    } catch (error) {
      if (error.status !== 401 || !account.autoLoginEnabled || !account.encryptedPassword) {
        throw error;
      }
      const password = await this.credentialStore.unprotect(account.encryptedPassword);
      const login = await this.login(account.username, password);
      token = login.token;
      await this.store.saveFrpAccount({
        ...account,
        encryptedToken: await this.credentialStore.protect(token),
        lastConnectedAt: new Date().toISOString(),
        lastError: "",
      });
      return token;
    }
  }

  async login(username, password) {
    const response = await this.fetch(`${API_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(12_000),
    });
    const payload = await this.readPayload(response);
    const token = payload && payload.data && payload.data.token;
    if (!token) throw new Error("88FRP 登录未返回有效授权令牌。");
    return { token };
  }

  async fetchAllTunnelLabels(token) {
    const subscriptionsPayload = await this.fetchJson("/subscriptions/mine", token);
    const subscriptions = Array.isArray(subscriptionsPayload.data) ? subscriptionsPayload.data : [];
    const labels = {};
    for (const subscription of subscriptions) {
      if (!subscription || !subscription.id) continue;
      const tunnelsPayload = await this.fetchJson(`/tunnels/subscription/${subscription.id}`, token);
      const tunnels = Array.isArray(tunnelsPayload.data) ? tunnelsPayload.data : [];
      for (const tunnel of tunnels) {
        if (!tunnel || !tunnel.proxies_name || !tunnel.name) continue;
        labels[tunnel.proxies_name] = {
          displayName: String(tunnel.name),
          localPort: tunnel.local_port ?? "",
          remotePort: tunnel.remote_port ?? "",
          updatedAt: new Date().toISOString(),
        };
      }
    }
    return labels;
  }

  async fetchJson(path, token) {
    const response = await this.fetch(`${API_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12_000),
    });
    return this.readPayload(response);
  }

  async readPayload(response) {
    let payload = null;
    try { payload = await response.json(); } catch { }
    if (!response.ok || !payload || payload.success !== true) {
      const error = new Error((payload && payload.message) || `88FRP 请求失败: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  toFriendlyError(error) {
    if (error && error.status === 401) return "88FRP 登录已失效，请重新连接账号。";
    if (error && error.name === "TimeoutError") return "88FRP 请求超时，请稍后重试。";
    return error && error.message ? error.message : "88FRP 名称同步失败。";
  }
}

module.exports = {
  API_BASE_URL,
  FrpAccountService,
  sanitizeAccount,
};
