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
    tunnelGroupOverrides: {},
    collapsedTunnelGroups: new Set(readJsonArray("88frp.console.collapsedTunnelGroups")),
    tunnelLoadState: "idle",
    tunnelLoadError: "",
    tunnelRequestId: 0,
    openInstanceMenuId: null,
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
    frpAccountTitle: document.getElementById("frpAccountTitle"),
    frpAccountDescription: document.getElementById("frpAccountDescription"),
    frpAccountCredentials: document.getElementById("frpAccountCredentials"),
    frpAccountManagement: document.getElementById("frpAccountManagement"),
    frpAccountUsername: document.getElementById("frpAccountUsername"),
    frpAccountPassword: document.getElementById("frpAccountPassword"),
    frpAccountAutoLogin: document.getElementById("frpAccountAutoLogin"),
    btnCancelFrpAccount: document.getElementById("btnCancelFrpAccount"),
    btnDisconnectFrpAccount: document.getElementById("btnDisconnectFrpAccount"),
    btnRefreshFrpNames: document.getElementById("btnRefreshFrpNames"),
    btnConnectFrpAccount: document.getElementById("btnConnectFrpAccount"),
    btnToggleSyncSettings: document.getElementById("btnToggleSyncSettings"),
    syncCard: document.getElementById("syncCard"),
    syncSettingsSummary: document.getElementById("syncSettingsSummary"),
    btnConsoleLogout: document.getElementById("btnConsoleLogout"),
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
    els.btnDisconnectFrpAccount.addEventListener("click", disconnectFrpAccount);
    els.btnRefreshFrpNames.addEventListener("click", refreshFrpTunnelNames);
    els.btnToggleSyncSettings.addEventListener("click", toggleSyncSettings);
    els.btnConsoleLogout.addEventListener("click", logoutConsole);
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
      closeInstanceMenu();
      setInstancesExpanded(false);
      closeCreateModal();
      closeFrpAccountModal();
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".instance-actions")) closeInstanceMenu();
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
      els.frpAccountTitle.textContent = "管理 88FRP";
      els.frpAccountDescription.textContent = `${state.frpAccount.username || "已连接账号"} · 可随时手动拉取最新隧道备注。`;
      els.frpAccountCredentials.hidden = true;
      els.frpAccountManagement.hidden = false;
      els.btnConnectFrpAccount.hidden = true;
      els.btnDisconnectFrpAccount.hidden = false;
      els.btnRefreshFrpNames.hidden = false;
      els.frpAccountModal.style.display = "flex";
      return;
    }

    els.frpAccountTitle.textContent = "连接 88FRP";
    els.frpAccountDescription.textContent = "连接后，同步配置发生变化时会自动更新隧道备注名称。";
    els.frpAccountCredentials.hidden = false;
    els.frpAccountManagement.hidden = true;
    els.btnConnectFrpAccount.hidden = false;
    els.btnDisconnectFrpAccount.hidden = true;
    els.btnRefreshFrpNames.hidden = true;
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

  async function disconnectFrpAccount() {
    if (!window.confirm("断开后会清除本机保存的 88FRP 登录令牌和密码，已缓存的隧道名称会保留。是否断开？")) return;
    await withBusy(async () => {
      await API.disconnectFrpAccount();
      await loadFrpAccount();
      closeFrpAccountModal();
      showToast("88FRP 账号已断开");
    });
  }

  async function logoutConsole() {
    try {
      await API.logoutConsole();
    } finally {
      window.location.replace("/login");
    }
  }

  async function refreshFrpTunnelNames() {
    await withBusy(async () => {
      const result = await API.refreshFrpTunnelLabels();
      await loadFrpAccount();
      if (state.currentInstanceId) await refreshCurrentInstance();
      showToast(`已同步 ${result.data?.labelCount || 0} 个隧道名称`);
    });
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
    state.instances.forEach((instance, index) => {
      const row = document.createElement("div");
      row.className = `instance-item${instance.id === state.currentInstanceId ? " active" : ""}`;
      const menuOpen = state.openInstanceMenuId === instance.id;
      const menuOpensUp = state.instances.length > 4 && index >= state.instances.length - 2;
      row.innerHTML = `
        <button class="instance-select" type="button" aria-label="打开实例 ${escapeHtml(instance.name)}">
          <span class="instance-info">
            <span class="instance-name">${escapeHtml(instance.name)}</span>
            <span class="instance-status">
              <span class="status-dot ${getStatusClass(instance.runtime?.status)}"></span>
              ${translateStatus(instance.runtime?.status)}
            </span>
          </span>
        </button>
        <span class="instance-actions">
          <button class="instance-menu-button" type="button" aria-label="管理实例 ${escapeHtml(instance.name)}" aria-haspopup="menu" aria-expanded="${menuOpen}" title="更多操作">
            <i class="icon-ellipsis-vertical" aria-hidden="true"></i>
          </button>
          <span class="instance-menu${menuOpen ? " is-open" : ""}${menuOpensUp ? " opens-up" : ""}" role="menu">
            <button class="instance-menu-delete" type="button" role="menuitem">
              <i class="icon-trash-2" aria-hidden="true"></i>
              <span>删除实例</span>
            </button>
          </span>
        </span>
      `;
      row.querySelector(".instance-select").addEventListener("click", () => selectInstance(instance.id));
      row.querySelector(".instance-menu-button").addEventListener("click", (event) => {
        event.stopPropagation();
        toggleInstanceMenu(instance.id);
      });
      row.querySelector(".instance-menu-delete").addEventListener("click", (event) => {
        event.stopPropagation();
        deleteInstance(instance);
      });
      els.instanceList.appendChild(row);
    });
  }

  function toggleInstanceMenu(instanceId) {
    state.openInstanceMenuId = state.openInstanceMenuId === instanceId ? null : instanceId;
    renderInstanceList();
  }

  function closeInstanceMenu() {
    if (!state.openInstanceMenuId) return;
    state.openInstanceMenuId = null;
    renderInstanceList();
  }

  async function selectInstance(instanceId) {
    state.openInstanceMenuId = null;
    state.currentInstanceId = instanceId;
    state.tunnels = [];
    state.tunnelSelection = {};
    state.tunnelGroupOverrides = {};
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
      els.btnConnectFrpAccount,
    ].forEach((button) => {
      button.disabled = disabled;
    });
    updateTunnelSelectionActions();

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
    const views = {
      editor: document.getElementById("editorView"),
      tunnels: document.getElementById("tunnelsView"),
      log: document.getElementById("logView"),
    };
    Object.entries(views).forEach(([name, panel]) => {
      const active = name === state.activeView;
      panel.classList.toggle("active", active);
      panel.setAttribute("aria-hidden", String(!active));
    });
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
    const requestId = ++state.tunnelRequestId;
    if (!current) {
      state.tunnelLoadState = "idle";
      state.tunnelLoadError = "";
      renderTunnels();
      return;
    }

    state.tunnelLoadState = "loading";
    state.tunnelLoadError = "";
    renderTunnels();

    try {
      const res = await API.getTunnels(current.id);
      if (requestId !== state.tunnelRequestId) return;
      state.tunnels = res.data.tunnels || [];
      state.tunnelSelection = {};
      state.tunnelGroupOverrides = {};
      for (const tunnel of state.tunnels) {
        state.tunnelSelection[tunnel.name] = Boolean(tunnel.enabled);
        state.tunnelGroupOverrides[tunnel.name] = tunnel.groupOverride || "";
      }
      state.tunnelLoadState = "ready";
      renderTunnels();
    } catch (error) {
      if (requestId !== state.tunnelRequestId) return;
      state.tunnelLoadState = "error";
      state.tunnelLoadError = error.message || "隧道加载失败";
      renderTunnels();
      throw error;
    }
  }

  function renderTunnels() {
    updateTunnelSelectionActions();
    if (state.tunnelLoadState === "loading") {
      els.tunnelsList.innerHTML = `
        <div class="panel-status" role="status">
          <div class="panel-status-card">
            <i class="icon-loader-circle panel-status-icon is-spinning" aria-hidden="true"></i>
            <strong>正在加载隧道</strong>
            <span>正在读取当前实例的隧道和保存的选择。</span>
          </div>
        </div>
      `;
      els.selectionSummary.textContent = "正在加载隧道";
      return;
    }

    if (state.tunnelLoadState === "error") {
      els.tunnelsList.innerHTML = `
        <div class="panel-status panel-status-error" role="alert">
          <div class="panel-status-card">
            <i class="icon-triangle-alert panel-status-icon" aria-hidden="true"></i>
            <strong>隧道没有加载成功</strong>
            <span>${escapeHtml(state.tunnelLoadError)}</span>
            <button class="tonal-button panel-status-retry" type="button" data-action="retry-tunnels">
              <i class="icon-refresh-cw" aria-hidden="true"></i><span>重新加载</span>
            </button>
          </div>
        </div>
      `;
      els.selectionSummary.textContent = "隧道加载失败";
      const retryButton = els.tunnelsList.querySelector('[data-action="retry-tunnels"]');
      retryButton.addEventListener("click", () => withBusy(loadTunnels));
      return;
    }

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
    const groups = new Map();
    for (const tunnel of state.tunnels) {
      const group = tunnel.group || "未分组";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(tunnel);
    }
    const sortedGroups = [...groups.entries()].sort(([left], [right]) => {
      if (left === "未分组") return 1;
      if (right === "未分组") return -1;
      return left.localeCompare(right, "zh-CN");
    });
    for (const [group, groupTunnels] of sortedGroups) {
      const section = document.createElement("section");
      section.className = "tunnel-group";
      const groupKey = `${state.currentInstanceId || ""}\n${group}`;
      const collapsed = state.collapsedTunnelGroups.has(groupKey);
      const enabledCount = groupTunnels.filter((tunnel) => state.tunnelSelection[tunnel.name]).length;
      const header = document.createElement("div");
      header.className = "tunnel-group-header";
      header.innerHTML = `
        <span class="tunnel-group-copy">
          <strong>${escapeHtml(group)}</strong>
          <span class="tunnel-group-summary">已开启 ${enabledCount} / ${groupTunnels.length} 条</span>
        </span>
        <span class="tunnel-group-actions">
          <button type="button" class="group-collapse-button icon-button" title="${collapsed ? "展开分组" : "收起分组"}" aria-label="${collapsed ? "展开" : "收起"} ${escapeHtml(group)} 分组" aria-expanded="${String(!collapsed)}"><i class="${collapsed ? "icon-chevron-down" : "icon-chevron-up"}" aria-hidden="true"></i></button>
          <label class="material-switch">
          <input type="checkbox" aria-label="切换 ${escapeHtml(group)} 分组全部隧道">
          <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
        </span>
      `;
      const groupToggle = header.querySelector("input");
      const groupTrack = header.querySelector(".switch-track");
      const collapseButton = header.querySelector(".group-collapse-button");
      const updateGroupToggle = () => {
        const enabled = groupTunnels.filter((tunnel) => state.tunnelSelection[tunnel.name]).length;
        groupToggle.indeterminate = enabled > 0 && enabled < groupTunnels.length;
        groupToggle.checked = enabled === groupTunnels.length;
        groupTrack.classList.toggle("is-checked", groupToggle.checked);
        header.querySelector(".tunnel-group-summary").textContent = `已开启 ${enabled} / ${groupTunnels.length} 条`;
      };
      updateGroupToggle();
      groupToggle.addEventListener("change", (event) => {
        for (const tunnel of groupTunnels) state.tunnelSelection[tunnel.name] = event.target.checked;
        renderTunnels();
      });
      collapseButton.addEventListener("click", () => {
        if (state.collapsedTunnelGroups.has(groupKey)) state.collapsedTunnelGroups.delete(groupKey);
        else state.collapsedTunnelGroups.add(groupKey);
        writeLocal("88frp.console.collapsedTunnelGroups", JSON.stringify([...state.collapsedTunnelGroups]));
        renderTunnels();
      });
      section.appendChild(header);

      const rows = document.createElement("div");
      rows.className = "tunnel-group-rows";
      rows.hidden = collapsed;
      for (const tunnel of groupTunnels) {
        const enabled = Boolean(state.tunnelSelection[tunnel.name]);
        const row = document.createElement("article");
        row.className = `tunnel-row${enabled ? " is-enabled" : ""}`;
        const selector = document.createElement("label");
        selector.className = "tunnel-row-select";
        selector.innerHTML = `
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
        const checkbox = selector.querySelector("input");
        checkbox.addEventListener("change", (event) => {
          state.tunnelSelection[tunnel.name] = event.target.checked;
          row.classList.toggle("is-enabled", event.target.checked);
          selector.querySelector(".switch-track").classList.toggle("is-checked", event.target.checked);
          updateGroupToggle();
          renderSelectionSummary();
        });
        selector.querySelector(".switch-track").classList.toggle("is-checked", enabled);

        const groupField = document.createElement("label");
        groupField.className = "tunnel-group-field";
        groupField.innerHTML = `<span>分组</span><input type="text" maxlength="40" value="${escapeHtml(state.tunnelGroupOverrides[tunnel.name] || "")}" placeholder="自动：${escapeHtml(tunnel.group || "未分组")}" aria-label="${escapeHtml(tunnel.displayName || tunnel.name)} 的手动分组">`;
        const groupInput = groupField.querySelector("input");
        groupInput.addEventListener("input", () => {
          state.tunnelGroupOverrides[tunnel.name] = groupInput.value;
        });
        row.append(selector, groupField);
        rows.appendChild(row);
      }
      section.appendChild(rows);
      els.tunnelsList.appendChild(section);
    }
    renderSelectionSummary();
  }

  function renderSelectionSummary() {
    const enabled = Object.values(state.tunnelSelection).filter(Boolean).length;
    const groupCount = new Set(state.tunnels.map((tunnel) => tunnel.group || "未分组")).size;
    els.selectionSummary.textContent = `已开启 ${enabled} / ${state.tunnels.length} 条隧道 · ${groupCount} 个分组`;
  }

  function updateTunnelSelectionActions() {
    const disabled = state.busy || state.tunnelLoadState !== "ready";
    els.btnSelectNoTunnels.disabled = disabled;
    els.btnSaveTunnels.disabled = disabled;
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
      await API.saveTunnelGroupOverrides(current.id, state.tunnelGroupOverrides);
      const res = await API.saveTunnelSelection(current.id, state.tunnelSelection);
      state.tunnels = res.data.tunnels || [];
      state.tunnelSelection = {};
      state.tunnelGroupOverrides = {};
      for (const tunnel of state.tunnels) {
        state.tunnelSelection[tunnel.name] = Boolean(tunnel.enabled);
        state.tunnelGroupOverrides[tunnel.name] = tunnel.groupOverride || "";
      }
      renderTunnels();
      showToast("隧道选择和分组已保存，重启实例后生效");
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
    await deleteInstance(current);
  }

  async function deleteInstance(instance) {
    if (!instance || state.busy) return;
    const isRunning = instance.runtime?.status === "running";
    const runningNotice = isRunning ? "\n\n该实例正在运行，删除时会先停止后台隧道。" : "";
    if (!window.confirm(`确定删除实例「${instance.name}」吗？${runningNotice}\n\n此操作无法撤销。`)) {
      closeInstanceMenu();
      return;
    }

    const deletedIndex = state.instances.findIndex((item) => item.id === instance.id);
    const deletingCurrent = state.currentInstanceId === instance.id;
    const remaining = state.instances.filter((item) => item.id !== instance.id);
    const fallback = remaining[Math.min(deletedIndex, remaining.length - 1)] || null;
    state.openInstanceMenuId = null;

    await withBusy(async () => {
      await API.deleteInstance(instance.id);
      if (deletingCurrent) state.currentInstanceId = fallback?.id || null;
      persistCurrentInstance();
      await loadInstances();
      if (state.currentInstanceId) await refreshCurrentInstance();
      showToast(`实例「${instance.name}」已删除`);
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

  function readJsonArray(key) {
    try {
      const value = JSON.parse(readLocal(key) || "[]");
      return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
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
