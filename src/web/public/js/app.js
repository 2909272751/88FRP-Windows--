document.addEventListener("DOMContentLoaded", () => {
  const state = {
    instances: [],
    currentInstanceId: readLocal("88frp.currentInstanceId"),
    activeView: readLocal("88frp.activeView") || "tunnels",
    originalConfigText: "",
    originalSecretKey: "",
    originalAutoSyncEnabled: false,
    tunnels: [],
    tunnelSelection: {},
    instancesExpanded: false,
    syncSettingsExpanded: false,
    pollingTimer: null,
    toastTimer: null,
    busy: false,
    frpAccount: { connected: false },
  };

  const els = {
    instanceList: document.getElementById("instanceList"),
    sidebar: document.getElementById("sidebar"),
    sidebarScrim: document.getElementById("sidebarScrim"),
    emptyState: document.getElementById("emptyState"),
    workbench: document.getElementById("workbench"),
    topInstanceName: document.getElementById("topInstanceName"),
    currentInstanceName: document.getElementById("currentInstanceName"),
    runtimeStatusChip: document.getElementById("runtimeStatusChip"),
    runtimeStatusText: document.getElementById("runtimeStatusText"),
    inputSecret: document.getElementById("inputSecret"),
    inputAutoSync: document.getElementById("inputAutoSync"),
    instStatusInfo: document.getElementById("instStatusInfo"),
    configEditor: document.getElementById("configEditor"),
    logContent: document.getElementById("logContent"),
    tunnelsList: document.getElementById("tunnelsList"),
    selectionSummary: document.getElementById("selectionSummary"),
    createModal: document.getElementById("createModal"),
    toast: document.getElementById("toast"),
    busyIndicator: document.getElementById("busyIndicator"),
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
    btnFrpAccountTop: document.getElementById("btnFrpAccountTop"),
    frpAccountStatus: document.getElementById("frpAccountStatus"),
    accountAvatarDot: document.getElementById("accountAvatarDot"),
    frpAccountModal: document.getElementById("frpAccountModal"),
    frpAccountUsername: document.getElementById("frpAccountUsername"),
    frpAccountPassword: document.getElementById("frpAccountPassword"),
    frpAccountAutoLogin: document.getElementById("frpAccountAutoLogin"),
    btnCancelFrpAccount: document.getElementById("btnCancelFrpAccount"),
    btnConnectFrpAccount: document.getElementById("btnConnectFrpAccount"),
    btnToggleSyncSettings: document.getElementById("btnToggleSyncSettings"),
    syncCard: document.getElementById("syncCard"),
    syncSettingsSummary: document.getElementById("syncSettingsSummary"),
    btnTheme: document.getElementById("btnTheme"),
    newInstName: document.getElementById("newInstName"),
    newInstSecret: document.getElementById("newInstSecret"),
    newInstAutoSync: document.getElementById("newInstAutoSync"),
  };

  bindEvents();
  applyTheme(readLocal("88frp.theme") || preferredTheme());
  init().catch((error) => showToast(error.message));

  function bindEvents() {
    document.getElementById("btnShowCreate").addEventListener("click", openCreateModal);
    document.getElementById("btnCreateFromEmpty").addEventListener("click", openCreateModal);
    document.getElementById("btnCloseCreate").addEventListener("click", closeCreateModal);
    document.getElementById("btnCancelCreate").addEventListener("click", closeCreateModal);
    document.getElementById("btnConfirmCreate").addEventListener("click", handleCreate);
    document.getElementById("btnCloseFrpAccount").addEventListener("click", closeFrpAccountModal);

    els.btnShowInstances.addEventListener("click", () => setInstancesExpanded(true));
    els.btnShowInstancesEmpty.addEventListener("click", () => setInstancesExpanded(true));
    els.btnHideInstances.addEventListener("click", () => setInstancesExpanded(false));
    els.sidebarScrim.addEventListener("click", () => setInstancesExpanded(false));
    els.btnFrpAccount.addEventListener("click", manageFrpAccount);
    els.btnFrpAccountTop.addEventListener("click", manageFrpAccount);
    els.btnCancelFrpAccount.addEventListener("click", closeFrpAccountModal);
    els.btnConnectFrpAccount.addEventListener("click", connectFrpAccount);
    els.btnToggleSyncSettings.addEventListener("click", toggleSyncSettings);
    els.btnTheme.addEventListener("click", toggleTheme);

    els.btnRefreshLog.addEventListener("click", () => withBusy(loadLogs));
    els.btnSaveConfig.addEventListener("click", saveConfig);
    els.btnDelete.addEventListener("click", deleteCurrentInstance);
    els.btnSync.addEventListener("click", syncCurrentInstance);
    els.btnStart.addEventListener("click", () => handleRuntimeAction("start"));
    els.btnStop.addEventListener("click", () => handleRuntimeAction("stop"));
    els.btnRestart.addEventListener("click", () => handleRuntimeAction("restart"));
    els.btnReloadTunnels.addEventListener("click", () => withBusy(loadTunnels));
    els.btnSelectNoTunnels.addEventListener("click", clearTunnelSelection);
    els.btnSaveTunnels.addEventListener("click", saveTunnelSelection);
    els.configEditor.addEventListener("input", updateDirtyState);
    els.inputSecret.addEventListener("input", updateDirtyState);
    els.inputAutoSync.addEventListener("change", () => {
      updateDirtyState();
      renderSyncSummary();
    });

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", async () => {
        state.activeView = tab.dataset.view;
        writeLocal("88frp.activeView", state.activeView);
        renderTabs();
        if (state.activeView === "log") await withBusy(loadLogs);
        if (state.activeView === "tunnels") await withBusy(loadTunnels);
      });
    });

    [els.createModal, els.frpAccountModal].forEach((overlay) => {
      overlay.addEventListener("click", (event) => {
        if (event.target !== overlay) return;
        if (overlay === els.createModal) closeCreateModal();
        if (overlay === els.frpAccountModal) closeFrpAccountModal();
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      setInstancesExpanded(false);
      closeCreateModal();
      closeFrpAccountModal();
    });
  }

  async function init() {
    await Promise.all([loadInstances(), loadFrpAccount()]);
    if (state.currentInstanceId) await refreshCurrentInstance();
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
    els.accountAvatarDot.classList.toggle("is-connected", connected);
    els.btnFrpAccount.querySelector(".account-control-label").textContent = connected ? "管理 88FRP" : "连接 88FRP";
    els.frpAccountStatus.textContent = connected
      ? `${account.username || "已连接"} · ${account.autoLoginEnabled ? "自动登录" : "需手动登录"}`
      : "未连接";
    renderSyncSummary();
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
    requestAnimationFrame(() => els.frpAccountUsername.focus());
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
      state.frpAccount = result.data?.account || {
        connected: true,
        username,
        autoLoginEnabled: els.frpAccountAutoLogin.checked,
      };
      renderFrpAccount();
      if (state.activeView === "tunnels") await loadTunnels();
      showToast(result.data?.refreshed ? "88FRP 已连接，隧道备注已更新" : "88FRP 已连接");
    });
  }

  async function loadInstances() {
    const res = await API.getInstances();
    state.instances = res.data || [];

    if (state.currentInstanceId && !state.instances.some((item) => item.id === state.currentInstanceId)) {
      state.currentInstanceId = null;
    }
    if (!state.currentInstanceId && state.instances.length === 1) {
      state.currentInstanceId = state.instances[0].id;
    }

    persistCurrentInstance();
    renderInstanceList();
    renderWorkbench();
  }

  function renderInstanceList() {
    if (!state.instances.length) {
      els.instanceList.innerHTML = '<div class="tunnels-empty">还没有实例</div>';
      return;
    }

    els.instanceList.innerHTML = "";
    for (const instance of state.instances) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `instance-item${instance.id === state.currentInstanceId ? " active" : ""}`;
      item.innerHTML = `
        <span class="instance-info">
          <span class="instance-name">${escapeHtml(instance.name)}</span>
          <span class="instance-status">
            <span class="status-dot ${getStatusClass(instance.runtime?.status)}"></span>
            ${translateStatus(instance.runtime?.status)}
          </span>
        </span>
        <i class="icon-chevron-right" aria-hidden="true"></i>
      `;
      item.addEventListener("click", () => selectInstance(instance.id));
      els.instanceList.appendChild(item);
    }
  }

  async function selectInstance(instanceId) {
    state.currentInstanceId = instanceId;
    state.tunnels = [];
    state.tunnelSelection = {};
    persistCurrentInstance();
    renderInstanceList();
    setInstancesExpanded(false);
    await withBusy(refreshCurrentInstance);
  }

  async function refreshCurrentInstance() {
    if (!state.currentInstanceId) {
      renderWorkbench();
      return;
    }

    const detail = await API.getInstance(state.currentInstanceId);
    state.instances = state.instances.map((item) => (item.id === detail.data.id ? detail.data : item));

    const current = getCurrentInstance();
    if (!current) {
      state.currentInstanceId = null;
      persistCurrentInstance();
      renderWorkbench();
      return;
    }

    els.inputSecret.value = current.secretKey || "";
    els.inputAutoSync.checked = Boolean(current.autoSyncEnabled);
    state.originalSecretKey = String(current.secretKey || "").trim();
    state.originalAutoSyncEnabled = Boolean(current.autoSyncEnabled);

    const configRes = await API.getConfig(current.id);
    els.configEditor.value = configRes.data.configText || "";
    state.originalConfigText = normalizeText(configRes.data.configText || "");

    renderInstanceList();
    renderWorkbench();
    if (state.activeView === "log") await loadLogs();
    if (state.activeView === "tunnels") await loadTunnels();
  }

  function renderWorkbench() {
    const current = getCurrentInstance();
    const hasInstance = Boolean(current);
    els.emptyState.style.display = hasInstance ? "none" : "flex";
    els.workbench.style.display = hasInstance ? "flex" : "none";
    els.topInstanceName.textContent = hasInstance ? current.name : "选择实例";

    if (!hasInstance) {
      els.instStatusInfo.textContent = "";
      return;
    }

    const runtime = current.runtime || {};
    const statusText = translateStatus(runtime.status);
    els.currentInstanceName.textContent = current.name;
    els.runtimeStatusText.textContent = statusText;
    els.runtimeStatusChip.className = `status-chip ${getStatusClass(runtime.status)}`;

    if (runtime.status === "running") {
      els.instStatusInfo.innerHTML = `
        <span>PID <strong>${runtime.pid ?? "-"}</strong></span>
        <span class="started-at">启动于 <strong>${escapeHtml(formatDateTime(runtime.lastStartedAt))}</strong></span>
      `;
    } else if (runtime.lastError) {
      els.instStatusInfo.innerHTML = `<span>错误 <strong>${escapeHtml(runtime.lastError)}</strong></span>`;
    } else {
      els.instStatusInfo.innerHTML = "<span>实例当前未运行</span>";
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
      els.btnConnectFrpAccount,
    ].forEach((button) => {
      button.disabled = disabled;
    });

    renderSyncSummary();
    updateDirtyState();
    renderTabs();
  }

  function renderSyncSummary() {
    const current = getCurrentInstance();
    const parts = [];
    if (state.frpAccount?.connected) parts.push(state.frpAccount.username || "88FRP 已连接");
    parts.push(current?.autoSyncEnabled || els.inputAutoSync.checked ? "自动同步已开启" : "自动同步已关闭");
    els.syncSettingsSummary.textContent = parts.join(" · ");
  }

  function renderTabs() {
    document.querySelectorAll(".tab").forEach((tab) => {
      const active = tab.dataset.view === state.activeView;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    document.getElementById("editorView").classList.toggle("active", state.activeView === "editor");
    document.getElementById("tunnelsView").classList.toggle("active", state.activeView === "tunnels");
    document.getElementById("logView").classList.toggle("active", state.activeView === "log");
  }

  async function loadLogs() {
    const current = getCurrentInstance();
    if (!current) return;
    const res = await API.getLogs(current.id, 200);
    els.logContent.textContent = res.data.content || "暂无日志内容";
    els.logContent.scrollTop = els.logContent.scrollHeight;
  }

  async function loadTunnels() {
    const current = getCurrentInstance();
    if (!current) return;
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
      els.tunnelsList.innerHTML = `
        <div class="tunnels-empty">
          <span>当前配置里没有检测到隧道。</span>
        </div>
      `;
      renderSelectionSummary();
      return;
    }

    els.tunnelsList.innerHTML = "";
    for (const tunnel of state.tunnels) {
      const enabled = Boolean(state.tunnelSelection[tunnel.name]);
      const row = document.createElement("label");
      row.className = `tunnel-row${enabled ? " is-enabled" : ""}`;
      row.innerHTML = `
        <input type="checkbox" ${enabled ? "checked" : ""} aria-label="${escapeHtml(tunnel.displayName || tunnel.name)}">
        <span class="tunnel-leading"><i class="icon-waypoints" aria-hidden="true"></i></span>
        <span class="tunnel-body">
          <span class="tunnel-name">${escapeHtml(tunnel.displayName || tunnel.name)}</span>
          ${tunnel.displayName ? `<span class="tunnel-id">${escapeHtml(tunnel.name)}</span>` : ""}
          <span class="tunnel-meta">${escapeHtml(formatTunnelMeta(tunnel))}</span>
        </span>
        <span class="material-switch tunnel-switch" aria-hidden="true">
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </span>
      `;
      const checkbox = row.querySelector("input");
      checkbox.addEventListener("change", (event) => {
        state.tunnelSelection[tunnel.name] = event.target.checked;
        row.classList.toggle("is-enabled", event.target.checked);
        const track = row.querySelector(".switch-track");
        track.classList.toggle("is-checked", event.target.checked);
        renderSelectionSummary();
      });
      const track = row.querySelector(".switch-track");
      track.classList.toggle("is-checked", enabled);
      els.tunnelsList.appendChild(row);
    }
    renderSelectionSummary();
  }

  function renderSelectionSummary() {
    const enabled = Object.values(state.tunnelSelection).filter(Boolean).length;
    els.selectionSummary.textContent = `已开启 ${enabled} / ${state.tunnels.length} 条隧道`;
  }

  function clearTunnelSelection() {
    for (const tunnel of state.tunnels) {
      state.tunnelSelection[tunnel.name] = false;
    }
    renderTunnels();
    showToast("已将所有隧道设为关闭，保存后生效");
  }

  async function saveTunnelSelection() {
    const current = getCurrentInstance();
    if (!current) return;

    await withBusy(async () => {
      const res = await API.saveTunnelSelection(current.id, state.tunnelSelection);
      state.tunnels = res.data.tunnels || [];
      state.tunnelSelection = {};
      for (const tunnel of state.tunnels) {
        state.tunnelSelection[tunnel.name] = Boolean(tunnel.enabled);
      }
      renderTunnels();
      showToast("隧道选择已保存，重启实例后生效");
    });
  }

  async function handleRuntimeAction(action) {
    const current = getCurrentInstance();
    if (!current) return;

    await withBusy(async () => {
      if (action === "start") await API.startInstance(current.id);
      else if (action === "stop") await API.stopInstance(current.id);
      else await API.restartInstance(current.id);
      showToast(`实例${action === "start" ? "启动" : action === "stop" ? "停止" : "重启"}指令已发送`);
      await loadInstances();
      await refreshCurrentInstance();
    });
  }

  async function saveConfig() {
    const current = getCurrentInstance();
    if (!current) return;

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
    if (!current) return;

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
    if (!current) return;
    if (!window.confirm(`确定删除实例「${current.name}」吗？`)) return;

    await withBusy(async () => {
      await API.deleteInstance(current.id);
      state.currentInstanceId = null;
      persistCurrentInstance();
      showToast("实例已删除");
      await loadInstances();
      if (state.currentInstanceId) await refreshCurrentInstance();
    });
  }

  async function handleCreate() {
    const name = els.newInstName.value.trim();
    if (!name) {
      showToast("请输入实例名称");
      els.newInstName.focus();
      return;
    }

    await withBusy(async () => {
      const res = await API.createInstance({
        name,
        secretKey: els.newInstSecret.value.trim(),
        autoSyncEnabled: els.newInstAutoSync.checked,
      });
      state.currentInstanceId = res.data.id;
      persistCurrentInstance();
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
    requestAnimationFrame(() => els.newInstName.focus());
  }

  function closeCreateModal() {
    els.createModal.style.display = "none";
  }

  function toggleSyncSettings() {
    state.syncSettingsExpanded = !state.syncSettingsExpanded;
    els.syncCard.classList.toggle("is-expanded", state.syncSettingsExpanded);
    els.btnToggleSyncSettings.setAttribute("aria-expanded", String(state.syncSettingsExpanded));
  }

  function setInstancesExpanded(expanded) {
    state.instancesExpanded = expanded;
    els.sidebar.classList.toggle("is-expanded", expanded);
    els.sidebarScrim.classList.toggle("is-visible", expanded);
    els.btnShowInstances.setAttribute("aria-expanded", String(expanded));
  }

  function startPolling() {
    if (state.pollingTimer) clearInterval(state.pollingTimer);
    state.pollingTimer = setInterval(async () => {
      try {
        await loadInstances();
        if (state.currentInstanceId && state.activeView === "log") await loadLogs();
      } catch {
        // Polling recovers on the next interval.
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
    if (state.busy) return;
    state.busy = true;
    els.busyIndicator.classList.add("is-active");
    els.busyIndicator.setAttribute("aria-hidden", "false");
    renderWorkbench();
    try {
      await task();
    } catch (error) {
      showToast(error.message);
    } finally {
      state.busy = false;
      els.busyIndicator.classList.remove("is-active");
      els.busyIndicator.setAttribute("aria-hidden", "true");
      renderWorkbench();
    }
  }

  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    writeLocal("88frp.theme", theme);
    const icon = els.btnTheme.querySelector("i");
    const dark = theme === "dark";
    icon.className = dark ? "icon-sun" : "icon-moon";
    els.btnTheme.setAttribute("aria-label", dark ? "切换浅色模式" : "切换深色模式");
    document.querySelector('meta[name="theme-color"]').setAttribute("content", dark ? "#11161d" : "#f5f7fa");
  }

  function preferredTheme() {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function getCurrentInstance() {
    return state.instances.find((item) => item.id === state.currentInstanceId) || null;
  }

  function persistCurrentInstance() {
    if (state.currentInstanceId) writeLocal("88frp.currentInstanceId", state.currentInstanceId);
    else removeLocal("88frp.currentInstanceId");
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.style.display = "block";
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      els.toast.style.display = "none";
    }, 3000);
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
    if (status === "running") return "running";
    if (status === "error") return "error";
    return "";
  }

  function formatTunnelMeta(tunnel) {
    const parts = [String(tunnel.type || "tcp").toUpperCase()];
    if (tunnel.localPort) parts.push(`本地 ${tunnel.localPort}`);
    if (tunnel.remotePort) parts.push(`远程 ${tunnel.remotePort}`);
    return parts.join(" · ");
  }

  function formatDateTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  }

  function normalizeText(text) {
    return String(text || "").replace(/\r\n/g, "\n").trimEnd();
  }

  function readLocal(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeLocal(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Private browsing may deny storage.
    }
  }

  function removeLocal(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Private browsing may deny storage.
    }
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
