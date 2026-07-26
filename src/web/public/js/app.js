document.addEventListener("DOMContentLoaded", () => {
  const state = {
    instances: [],
    currentInstanceId: null,
    activeView: "editor",
    originalConfigText: "",
    originalSecretKey: "",
    originalAutoSyncEnabled: false,
    tunnels: [],
    tunnelSelection: {},
    instancesExpanded: false,
    pollingTimer: null,
    toastTimer: null,
    busy: false,
    frpAccount: { connected: false },
  };

  const els = {
    instanceList: document.getElementById("instanceList"),
    sidebar: document.getElementById("sidebar"),
    emptyState: document.getElementById("emptyState"),
    workbench: document.getElementById("workbench"),
    inputSecret: document.getElementById("inputSecret"),
    inputAutoSync: document.getElementById("inputAutoSync"),
    instStatusInfo: document.getElementById("instStatusInfo"),
    configEditor: document.getElementById("configEditor"),
    logContent: document.getElementById("logContent"),
    tunnelsList: document.getElementById("tunnelsList"),
    createModal: document.getElementById("createModal"),
    toast: document.getElementById("toast"),
    btnStart: document.getElementById("btnStart"),
    btnRestart: document.getElementById("btnRestart"),
    btnStop: document.getElementById("btnStop"),
    btnDelete: document.getElementById("btnDelete"),
    btnSaveConfig: document.getElementById("btnSaveConfig"),
    btnRefreshLog: document.getElementById("btnRefreshLog"),
    btnSync: document.getElementById("btnSync"),
    btnReloadTunnels: document.getElementById("btnReloadTunnels"),
    btnSelectNoTunnels: document.getElementById("btnSelectNoTunnels"),
    btnSaveTunnels: document.getElementById("btnSaveTunnels"),
    btnShowInstances: document.getElementById("btnShowInstances"),
    btnShowInstancesEmpty: document.getElementById("btnShowInstancesEmpty"),
    btnHideInstances: document.getElementById("btnHideInstances"),
    btnFrpAccount: document.getElementById("btnFrpAccount"),
    frpAccountStatus: document.getElementById("frpAccountStatus"),
    frpAccountModal: document.getElementById("frpAccountModal"),
    frpAccountUsername: document.getElementById("frpAccountUsername"),
    frpAccountPassword: document.getElementById("frpAccountPassword"),
    frpAccountAutoLogin: document.getElementById("frpAccountAutoLogin"),
    btnCancelFrpAccount: document.getElementById("btnCancelFrpAccount"),
    btnConnectFrpAccount: document.getElementById("btnConnectFrpAccount"),
    newInstName: document.getElementById("newInstName"),
    newInstSecret: document.getElementById("newInstSecret"),
    newInstAutoSync: document.getElementById("newInstAutoSync"),
  };

  document.getElementById("btnShowCreate").addEventListener("click", openCreateModal);
  els.btnShowInstances.addEventListener("click", () => setInstancesExpanded(true));
  els.btnShowInstancesEmpty.addEventListener("click", () => setInstancesExpanded(true));
  els.btnFrpAccount.addEventListener("click", manageFrpAccount);
  els.btnCancelFrpAccount.addEventListener("click", closeFrpAccountModal);
  els.btnConnectFrpAccount.addEventListener("click", connectFrpAccount);
  els.btnHideInstances.addEventListener("click", () => setInstancesExpanded(false));
  document.getElementById("btnCancelCreate").addEventListener("click", closeCreateModal);
  document.getElementById("btnConfirmCreate").addEventListener("click", handleCreate);
  els.btnRefreshLog.addEventListener("click", loadLogs);
  els.btnSaveConfig.addEventListener("click", saveConfig);
  els.btnDelete.addEventListener("click", deleteCurrentInstance);
  els.btnSync.addEventListener("click", syncCurrentInstance);
  els.btnStart.addEventListener("click", () => handleRuntimeAction("start"));
  els.btnStop.addEventListener("click", () => handleRuntimeAction("stop"));
  els.btnRestart.addEventListener("click", () => handleRuntimeAction("restart"));
  els.btnReloadTunnels.addEventListener("click", loadTunnels);
  els.btnSelectNoTunnels.addEventListener("click", clearTunnelSelection);
  els.btnSaveTunnels.addEventListener("click", saveTunnelSelection);
  els.configEditor.addEventListener("input", updateDirtyState);
  els.inputSecret.addEventListener("input", updateDirtyState);
  els.inputAutoSync.addEventListener("change", updateDirtyState);

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", async () => {
      state.activeView = tab.dataset.view;
      renderTabs();
      if (state.activeView === "log") {
        await loadLogs();
      }
      if (state.activeView === "tunnels") {
        await loadTunnels();
      }
    });
  });

  init().catch((error) => showToast(error.message));

  async function init() {
    await Promise.all([loadInstances(), loadFrpAccount()]);
    startPolling();
  }

  async function loadFrpAccount() {
    const res = await API.getFrpAccount();
    state.frpAccount = res.data || { connected: false };
    renderFrpAccount();
  }

  function renderFrpAccount() {
    const account = state.frpAccount || {};
    const connected = Boolean(account.connected);
    els.btnFrpAccount.classList.toggle("is-connected", connected);
    els.btnFrpAccount.querySelector(".account-control-label").textContent = connected ? "管理 88FRP" : "连接 88FRP";
    els.frpAccountStatus.textContent = connected
      ? `${account.username || "已连接"} · ${account.autoLoginEnabled ? "自动登录" : "需手动登录"}`
      : "未连接";
  }

  async function manageFrpAccount() {
    if (state.frpAccount?.connected) {
      if (!window.confirm("断开后会清除本机保存的 88FRP 登录令牌和密码，已缓存的隧道名称会保留。是否断开？")) return;
      await withBusy(async () => {
        await API.disconnectFrpAccount();
        await loadFrpAccount();
        showToast("88FRP 账号已断开");
      });
      return;
    }
    els.frpAccountUsername.value = "";
    els.frpAccountPassword.value = "";
    els.frpAccountAutoLogin.checked = true;
    els.frpAccountModal.style.display = "flex";
    els.frpAccountUsername.focus();
  }

  function closeFrpAccountModal() {
    els.frpAccountModal.style.display = "none";
    els.frpAccountPassword.value = "";
  }

  async function connectFrpAccount() {
    const username = els.frpAccountUsername.value.trim();
    const password = els.frpAccountPassword.value;
    if (!username || !password) {
      showToast("请输入 88FRP 账号和密码");
      return;
    }
    await withBusy(async () => {
      const result = await API.connectFrpAccount({
        username,
        password,
        autoLoginEnabled: els.frpAccountAutoLogin.checked,
      });
      closeFrpAccountModal();
      state.frpAccount = result.data?.account || { connected: true, username, autoLoginEnabled: els.frpAccountAutoLogin.checked };
      renderFrpAccount();
      if (state.activeView === "tunnels") await loadTunnels();
      showToast(result.data?.refreshed ? "88FRP 已连接，隧道备注已更新" : "88FRP 已连接");
    });
  }

  async function loadInstances() {
    const res = await API.getInstances();
    state.instances = res.data;
    if (state.currentInstanceId && !state.instances.find((item) => item.id === state.currentInstanceId)) {
      state.currentInstanceId = null;
    }
    renderInstanceList();
    renderWorkbench();
  }

  function renderInstanceList() {
    els.instanceList.innerHTML = "";
    for (const instance of state.instances) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `instance-item${instance.id === state.currentInstanceId ? " active" : ""}`;
      item.innerHTML = `
        <div class="instance-info">
          <span class="instance-name">${escapeHtml(instance.name)}</span>
          <span class="instance-status">
            <span class="status-dot ${getStatusClass(instance.runtime?.status)}"></span>
            ${translateStatus(instance.runtime?.status)}
          </span>
        </div>
      `;
      item.addEventListener("click", () => selectInstance(instance.id));
      els.instanceList.appendChild(item);
    }
  }

  async function selectInstance(instanceId) {
    state.currentInstanceId = instanceId;
    state.tunnels = [];
    state.tunnelSelection = {};
    renderInstanceList();
    setInstancesExpanded(false);
    await refreshCurrentInstance();
  }

  async function refreshCurrentInstance() {
    if (!state.currentInstanceId) {
      renderWorkbench();
      return;
    }

    const detail = await API.getInstance(state.currentInstanceId);
    state.instances = state.instances.map((item) => (item.id === detail.data.id ? detail.data : item));

    const current = getCurrentInstance();
    els.inputSecret.value = current.secretKey || "";
    els.inputAutoSync.checked = Boolean(current.autoSyncEnabled);
    state.originalSecretKey = String(current.secretKey || "").trim();
    state.originalAutoSyncEnabled = Boolean(current.autoSyncEnabled);

    const configRes = await API.getConfig(current.id);
    els.configEditor.value = configRes.data.configText || "";
    state.originalConfigText = normalizeText(configRes.data.configText || "");

    renderInstanceList();
    renderWorkbench();

    if (state.activeView === "log") {
      await loadLogs();
    }
    if (state.activeView === "tunnels") {
      await loadTunnels();
    }
  }

  function renderWorkbench() {
    const current = getCurrentInstance();
    const hasInstance = Boolean(current);
    els.emptyState.style.display = hasInstance ? "none" : "flex";
    els.workbench.style.display = hasInstance ? "flex" : "none";

    if (!hasInstance) {
      els.instStatusInfo.textContent = "";
      return;
    }

    const runtime = current.runtime || {};
    const statusText = translateStatus(runtime.status);
    if (runtime.status === "running") {
      els.instStatusInfo.innerHTML = `
        <span>状态：<strong>${statusText}</strong></span>
        <span>PID：<strong>${runtime.pid ?? "-"}</strong></span>
        <span>启动时间：<strong>${runtime.lastStartedAt || "-"}</strong></span>
      `;
    } else if (runtime.lastError) {
      els.instStatusInfo.innerHTML = `
        <span>状态：<strong>${statusText}</strong></span>
        <span>错误：<strong>${escapeHtml(runtime.lastError)}</strong></span>
      `;
    } else {
      els.instStatusInfo.innerHTML = `<span>状态：<strong>${statusText}</strong></span>`;
    }

    const canStart = !runtime.status || runtime.status === "stopped" || runtime.status === "error";
    const canStop = runtime.status === "running";
    const canRestart = runtime.status === "running";
    els.btnStart.style.display = canStart ? "inline-flex" : "none";
    els.btnStop.style.display = canStop ? "inline-flex" : "none";
    els.btnRestart.style.display = canRestart ? "inline-flex" : "none";

    const disabled = state.busy;
    [
      els.btnStart,
      els.btnStop,
      els.btnRestart,
      els.btnDelete,
      els.btnSaveConfig,
      els.btnSync,
      els.btnRefreshLog,
      els.btnReloadTunnels,
      els.btnSelectNoTunnels,
      els.btnSaveTunnels,
    ].forEach((button) => {
      button.disabled = disabled;
    });

    updateDirtyState();
    renderTabs();
  }

  function renderTabs() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.view === state.activeView);
    });
    document.getElementById("editorView").classList.toggle("active", state.activeView === "editor");
    document.getElementById("tunnelsView").classList.toggle("active", state.activeView === "tunnels");
    document.getElementById("logView").classList.toggle("active", state.activeView === "log");
  }

  async function loadLogs() {
    const current = getCurrentInstance();
    if (!current) {
      return;
    }
    const res = await API.getLogs(current.id, 200);
    els.logContent.textContent = res.data.content || "暂无日志内容";
    els.logContent.scrollTop = els.logContent.scrollHeight;
  }

  async function loadTunnels() {
    const current = getCurrentInstance();
    if (!current) {
      return;
    }
    const res = await API.getTunnels(current.id);
    state.tunnels = res.data.tunnels || [];
    state.tunnelSelection = {};
    for (const tunnel of state.tunnels) {
      state.tunnelSelection[tunnel.name] = Boolean(tunnel.enabled);
    }
    renderTunnels();
  }

  function renderTunnels() {
    if (!state.tunnels.length) {
      els.tunnelsList.innerHTML = `<div class="tunnels-empty">当前配置里没有检测到 [[proxies]] 隧道。</div>`;
      return;
    }

    els.tunnelsList.innerHTML = "";
    for (const tunnel of state.tunnels) {
      const row = document.createElement("label");
      row.className = "tunnel-row";
      row.innerHTML = `
        <input type="checkbox" ${state.tunnelSelection[tunnel.name] ? "checked" : ""}>
        <span class="tunnel-body">
          <span class="tunnel-name">${escapeHtml(tunnel.displayName || tunnel.name)}</span>
          ${tunnel.displayName ? `<span class="tunnel-id">FRPC 标识：${escapeHtml(tunnel.name)}</span>` : ""}
          <span class="tunnel-meta">${escapeHtml(formatTunnelMeta(tunnel))}</span>
        </span>
      `;
      row.querySelector("input").addEventListener("change", (event) => {
        state.tunnelSelection[tunnel.name] = event.target.checked;
      });
      els.tunnelsList.appendChild(row);
    }
  }

  function clearTunnelSelection() {
    for (const tunnel of state.tunnels) {
      state.tunnelSelection[tunnel.name] = false;
    }
    renderTunnels();
  }

  async function saveTunnelSelection() {
    const current = getCurrentInstance();
    if (!current) {
      return;
    }

    await withBusy(async () => {
      const res = await API.saveTunnelSelection(current.id, state.tunnelSelection);
      state.tunnels = res.data.tunnels || [];
      state.tunnelSelection = {};
      for (const tunnel of state.tunnels) {
        state.tunnelSelection[tunnel.name] = Boolean(tunnel.enabled);
      }
      renderTunnels();
      showToast("隧道选择已保存，重启实例后生效。");
    });
  }

  async function handleRuntimeAction(action) {
    const current = getCurrentInstance();
    if (!current) {
      return;
    }

    await withBusy(async () => {
      if (action === "start") {
        await API.startInstance(current.id);
      } else if (action === "stop") {
        await API.stopInstance(current.id);
      } else {
        await API.restartInstance(current.id);
      }
      showToast(`实例${action === "start" ? "启动" : action === "stop" ? "停止" : "重启"}指令已发送`);
      await loadInstances();
      await refreshCurrentInstance();
    });
  }

  async function saveConfig() {
    const current = getCurrentInstance();
    if (!current) {
      return;
    }

    await withBusy(async () => {
      await API.updateInstance(current.id, {
        secretKey: els.inputSecret.value.trim(),
        autoSyncEnabled: els.inputAutoSync.checked,
      });

      const res = await API.saveConfig(current.id, els.configEditor.value);
      state.originalConfigText = normalizeText(els.configEditor.value);
      state.originalSecretKey = els.inputSecret.value.trim();
      state.originalAutoSyncEnabled = els.inputAutoSync.checked;
      showToast(res.message || "配置已保存");
      await loadInstances();
      await refreshCurrentInstance();
    });
  }

  async function syncCurrentInstance() {
    const current = getCurrentInstance();
    if (!current) {
      return;
    }

    await withBusy(async () => {
      await API.updateInstance(current.id, {
        secretKey: els.inputSecret.value.trim(),
        autoSyncEnabled: els.inputAutoSync.checked,
      });
      const res = await API.syncInstance(current.id, true);
      if (res.data.changed) {
        const labelMessage = res.data.labelRefresh?.reason === "updated" ? "，备注名称已更新" : "";
        showToast(`同步成功，动作：${res.data.runtimeAction}${labelMessage}`);
      } else {
        showToast("远程配置没有变化");
      }
      await loadInstances();
      await refreshCurrentInstance();
    });
  }

  async function deleteCurrentInstance() {
    const current = getCurrentInstance();
    if (!current) {
      return;
    }
    if (!window.confirm(`确定删除实例「${current.name}」吗？`)) {
      return;
    }

    await withBusy(async () => {
      await API.deleteInstance(current.id);
      state.currentInstanceId = null;
      showToast("实例已删除");
      await loadInstances();
    });
  }

  async function handleCreate() {
    const name = els.newInstName.value.trim();
    if (!name) {
      showToast("请输入实例名称");
      return;
    }

    await withBusy(async () => {
      const res = await API.createInstance({
        name,
        secretKey: els.newInstSecret.value.trim(),
        autoSyncEnabled: els.newInstAutoSync.checked,
      });
      state.currentInstanceId = res.data.id;
      closeCreateModal();
      showToast("实例创建成功");
      await loadInstances();
      await refreshCurrentInstance();
    });
  }

  function openCreateModal() {
    els.newInstName.value = "";
    els.newInstSecret.value = "";
    els.newInstAutoSync.checked = false;
    els.createModal.style.display = "flex";
  }

  function closeCreateModal() {
    els.createModal.style.display = "none";
  }

  function setInstancesExpanded(expanded) {
    state.instancesExpanded = expanded;
    els.sidebar.classList.toggle("is-expanded", expanded);
    els.btnShowInstances.setAttribute("aria-expanded", String(expanded));
  }

  function startPolling() {
    if (state.pollingTimer) {
      clearInterval(state.pollingTimer);
    }
    state.pollingTimer = setInterval(async () => {
      try {
        await loadInstances();
        if (state.currentInstanceId && state.activeView === "log") {
          await loadLogs();
        }
      } catch {
        // Keep polling silent.
      }
    }, 3000);
  }

  function updateDirtyState() {
    const isDirty = (
      normalizeText(els.configEditor.value) !== state.originalConfigText ||
      els.inputSecret.value.trim() !== state.originalSecretKey ||
      els.inputAutoSync.checked !== state.originalAutoSyncEnabled
    );
    els.btnSaveConfig.classList.toggle("is-dirty", isDirty);
  }

  async function withBusy(task) {
    state.busy = true;
    renderWorkbench();
    try {
      await task();
    } catch (error) {
      showToast(error.message);
    } finally {
      state.busy = false;
      renderWorkbench();
    }
  }

  function getCurrentInstance() {
    return state.instances.find((item) => item.id === state.currentInstanceId) || null;
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.style.display = "block";
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      els.toast.style.display = "none";
    }, 2600);
  }

  function translateStatus(status) {
    return {
      running: "运行中",
      stopped: "已停止",
      starting: "启动中",
      stopping: "停止中",
      error: "异常",
    }[status] || "未知";
  }

  function getStatusClass(status) {
    if (status === "running") {
      return "running";
    }
    if (status === "error") {
      return "error";
    }
    return "";
  }

  function formatTunnelMeta(tunnel) {
    const parts = [tunnel.type || "tcp"];
    if (tunnel.localPort) {
      parts.push(`本地端口 ${tunnel.localPort}`);
    }
    if (tunnel.remotePort) {
      parts.push(`远程端口 ${tunnel.remotePort}`);
    }
    return parts.join(" · ");
  }

  function normalizeText(text) {
    return String(text || "").replace(/\r\n/g, "\n").trimEnd();
  }

  function escapeHtml(text) {
    return String(text || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
});
