window.API = (() => {
  async function request(url, options = {}) {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok || !data?.success) {
      throw new Error(data?.message || `请求失败: HTTP ${response.status}`);
    }

    return data;
  }

  return {
    getHealth() {
      return request("/api/health");
    },
    logoutConsole() {
      return request("/api/console-auth/logout", { method: "POST", body: "{}" });
    },
    getFrpAccount() {
      return request("/api/88frp/account");
    },
    connectFrpAccount(payload) {
      return request("/api/88frp/account/connect", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    refreshFrpTunnelLabels() {
      return request("/api/88frp/account/refresh-labels", { method: "POST", body: "{}" });
    },
    disconnectFrpAccount() {
      return request("/api/88frp/account", { method: "DELETE" });
    },
    getInstances() {
      return request("/api/instances");
    },
    getInstance(id) {
      return request(`/api/instances/${id}`);
    },
    createInstance(payload) {
      return request("/api/instances", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    updateInstance(id, payload) {
      return request(`/api/instances/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    },
    deleteInstance(id) {
      return request(`/api/instances/${id}`, {
        method: "DELETE",
      });
    },
    getConfig(id) {
      return request(`/api/instances/${id}/config`);
    },
    saveConfig(id, configText) {
      return request(`/api/instances/${id}/config`, {
        method: "PUT",
        body: JSON.stringify({ configText }),
      });
    },
    getStatus(id) {
      return request(`/api/instances/${id}/status`);
    },
    getLogs(id, tail = 200) {
      return request(`/api/instances/${id}/logs?tail=${tail}`);
    },
    getTunnels(id) {
      return request(`/api/instances/${id}/tunnels`);
    },
    saveTunnelSelection(id, selection) {
      return request(`/api/instances/${id}/tunnels/selection`, {
        method: "PUT",
        body: JSON.stringify({ selection }),
      });
    },
    saveTunnelGroupOverrides(id, groupOverrides) {
      return request(`/api/instances/${id}/tunnels/groups`, {
        method: "PUT",
        body: JSON.stringify({ groupOverrides }),
      });
    },
    startInstance(id) {
      return request(`/api/instances/${id}/start`, { method: "POST" });
    },
    stopInstance(id) {
      return request(`/api/instances/${id}/stop`, { method: "POST" });
    },
    restartInstance(id) {
      return request(`/api/instances/${id}/restart`, { method: "POST" });
    },
    syncInstance(id, restartOnChange = true) {
      return request(`/api/instances/${id}/sync`, {
        method: "POST",
        body: JSON.stringify({ restartOnChange }),
      });
    },
  };
})();
