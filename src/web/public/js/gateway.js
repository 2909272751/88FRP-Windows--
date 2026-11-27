(() => {
  const VIEWS = new Set(["overview", "services", "settings", "remote"]);
  const OVERVIEW_CACHE_KEY = "88frp.gateway.overview.v5";
  const SERVICE_META = {
    "xps": { title: "香港楼市终端", tag: "行情终端", description: "香港与广州楼市行情、租售比与买房判断", icon: "icon-building-2", tone: "amber" },
    "xps-cd2": { title: "CloudDrive2", tag: "云盘", description: "挂载云盘与统一文件管理", icon: "icon-cloud", tone: "sky" },
    "xps-codex": { title: "Codex", tag: "开发", description: "本机 Codex 工作区与任务入口", icon: "icon-code-2", tone: "violet" },
    "xps-deepseek": { title: "DeepSeek Harness", tag: "AI", description: "DeepSeek 调试与运行面板", icon: "icon-sparkles", tone: "teal" },
    "xps-alist": { title: "AList 文件", tag: "文件", description: "统一浏览与挂载网盘文件", icon: "icon-hard-drive", tone: "blue" },
  };
  const state = {
    overview: null,
    view: viewFromUrl(),
    logView: "audit",
    busy: false,
    formsHydrated: false,
    signatures: {},
    pollTimer: null,
    toastTimer: null,
    logsLoaded: false,
  };

  const el = {};

  document.addEventListener("DOMContentLoaded", () => {
    for (const node of document.querySelectorAll("[id]")) el[node.id] = node;
    bindEvents();
    applyTheme(readLocal("88frp.theme") || preferredTheme());
    switchView(state.view, false);
    const cached = readOverviewCache();
    if (cached) {
      state.overview = cached;
      render(true);
    }
    refresh(cached ? {} : { fast: true });
    state.pollTimer = setInterval(() => {
      if (document.hidden || state.busy || el.serviceDialog?.open) return;
      refresh({ hydrateForms: false, quiet: true }).catch(() => undefined);
    }, 8000);
  });

  function bindEvents() {
    document.querySelectorAll(".rail-nav-item").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.view));
    });
    el.btnRefresh.addEventListener("click", () => withBusy(() => refresh({ hydrateForms: false })));
    el.btnRetryGatewayLoad.addEventListener("click", () => refresh().catch(showLoadError));
    el.btnTheme.addEventListener("click", toggleTheme);
    el.btnLogout.addEventListener("click", logout);
    el.btnCopyHeroUrl.addEventListener("click", () => copyText(el.heroUrl.textContent));
    el.btnCopyWebV6.addEventListener("click", () => copyText(el.webV6Url.textContent));
    el.btnCopyWebV4.addEventListener("click", () => copyText(el.webV4Url.textContent));
    el.btnManageServices.addEventListener("click", () => switchView("services"));
    el.btnAddService.addEventListener("click", () => openServiceDialog());
    el.btnAddServiceEmpty.addEventListener("click", () => openServiceDialog());
    el.btnCloseServiceDialog.addEventListener("click", closeServiceDialog);
    el.btnCancelService.addEventListener("click", closeServiceDialog);
    el.serviceKind.addEventListener("change", syncServiceKindFields);
    el.serviceForm.addEventListener("submit", saveService);
    el.serviceList.addEventListener("click", handleServiceAction);
    el.deviceForm.addEventListener("submit", saveDevice);
    el.tokenForm.addEventListener("submit", saveToken);
    el.btnSyncDns.addEventListener("click", syncDns);
    el.sshForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveSsh();
    });
    el.btnOpenFirewall.addEventListener("click", openFirewall);
    el.btnRestartGateway.addEventListener("click", restartGateway);
    el.btnSyncSource.addEventListener("click", syncSource);
    el.btnCopyRdpProxy.addEventListener("click", () => copyText(el.rdpProxyCommand.textContent));
    el.btnCopyRdpCommand.addEventListener("click", () => copyText(el.rdpCommand.textContent));
    el.btnCopyRdpCommandV4.addEventListener("click", () => copyText(el.rdpCommandV4.textContent));
    el.btnCopySshAuto?.addEventListener("click", () => copyText(el.sshEndpoint.textContent));
    el.btnCopySshV6?.addEventListener("click", () => copyText(el.sshEndpointV6.textContent));
    el.btnCopySshV4?.addEventListener("click", () => copyText(el.sshEndpointV4.textContent));
    el.btnToggleSshSettings?.addEventListener("click", () => {
      if (!el.sshSettings) return;
      el.sshSettings.hidden = !el.sshSettings.hidden;
      el.btnToggleSshSettings.classList.toggle("is-active", !el.sshSettings.hidden);
    });
    el.logTabs.addEventListener("click", (event) => {
      const button = event.target.closest("[data-log]");
      if (!button) return;
      state.logView = button.dataset.log;
      renderLogTabs();
      loadLogs().catch((error) => showToast(error.message));
    });
    const logDetails = el.gatewayLog?.closest("details");
    if (logDetails) {
      logDetails.addEventListener("toggle", () => {
        if (!logDetails.open || state.logsLoaded) return;
        state.logsLoaded = true;
        loadLogs().catch((error) => {
          state.logsLoaded = false;
          showToast(error.message);
        });
      });
    }
    el.migrateInstance.addEventListener("change", hydrateMigrateName);
    el.migrateForm.addEventListener("submit", migrate);
    el.bootstrapForm.addEventListener("submit", bootstrap);
    el.serviceDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeServiceDialog();
    });
    window.addEventListener("hashchange", () => switchView(viewFromUrl(), false));
  }

  async function refresh({ hydrateForms = true, quiet = false, fast = false } = {}) {
    if (!quiet) {
      showBusy(true);
      if (!state.overview) showLoadPending();
    }
    try {
      const response = await API.getGateway({ includeHealth: !fast });
      state.overview = response.data;
      writeOverviewCache(response.data);
      render(hydrateForms);
      if (fast) setTimeout(() => refresh({ hydrateForms: false, quiet: true }), 40);
    } catch (error) {
      if (!state.overview) {
        if (!quiet) showLoadError(error);
      } else if (!quiet) {
        showToast("刷新较慢，正在显示上次结果。");
      }
    } finally {
      if (!quiet) showBusy(false);
    }
  }

  function render(hydrateForms) {
    const overview = state.overview;
    if (!overview) return;
    el.gatewayLoading.hidden = true;
    el.onboardingView.hidden = Boolean(overview.initialized);
    el.gatewayWorkspace.hidden = !overview.initialized;

    if (!overview.initialized) {
      renderOnboarding(overview);
      return;
    }

    const device = overview.device || {};
    const summary = device.summary || {};
    const runtime = overview.runtime || {};
    const caddy = runtime.caddy || {};
    const frpc = runtime.frpc || {};
    const httpServices = (overview.services || []).filter((item) => item.kind === "http" && item.enabled);
    const ipv6 = device.ipv6Detected || {};
    const gatewayPort = device.gatewayPort || 7777;
    const baseUrl = device.publicRootUrl || summary.baseUrl || "";
    const webEndpoints = device.publicEndpoints || summary.endpoints || {};
    const displayName = friendlyDeviceName(device.name || summary.title);

    setText(el.topDeviceName, pageLabel(state.view));
    el.railPortalLink.href = "/portal";
    el.btnOpenPortal.href = "/portal";
    setText(el.overviewTitle, displayName);
    setText(el.overviewSubtitle, device.domain
      ? `所有服务都从这里打开；地址 ${formatUrlHost(device.domain, gatewayPort)} 会自动切换到最快的连接方式。`
      : "先设置域名并授权 Cloudflare，才能启用公网 HTTPS 入口。");
    setText(el.heroUrl, baseUrl || "尚未设置域名");
    el.heroUrl.title = baseUrl || "";
    el.btnVisitHeroUrl.href = baseUrl || "/portal";
    el.btnVisitHeroUrlSecondary.href = baseUrl || "/portal";
    el.btnVisitHeroUrl.classList.toggle("is-disabled", !baseUrl);
    el.btnVisitHeroUrlSecondary.classList.toggle("is-disabled", !baseUrl);
    setEndpointRow(el.webV6Url, el.btnOpenWebV6, webEndpoints.ipv6, "等待域名");
    setEndpointRow(el.webV4Url, el.btnOpenWebV4, webEndpoints.ipv4, "等待域名");
    setText(el.gatewayPortBadge.lastElementChild, `端口 ${gatewayPort}`);
    setText(el.routePort, String(gatewayPort));

    const runtimeState = combinedRuntimeState(caddy.status, frpc.status);
    el.railStatusChip.className = `rail-live ${runtimeState === "running" ? "is-ready" : runtimeState === "error" ? "is-error" : "is-loading"}`;
    setText(el.railStatusText, statusLabel(runtimeState));
    el.railStatusChip.title = runtimeState === "running" ? "入口运行正常" : runtimeState === "error" ? "入口需要检查" : "入口正在启动";
    setConnection(overview.connection);
    el.healthDot.className = `health-dot ${runtimeState === "running" ? "is-ready" : runtimeState === "error" ? "is-error" : ""}`;
    setText(el.healthTitle, runtimeState === "running" ? "一切正常" : runtimeState === "error" ? "有项目需要检查" : "正在启动");
    setText(el.healthDetail, runtimeState === "running"
      ? "自动、IPv6 专用和 IPv4 专用入口都已就绪。"
      : runtimeState === "error"
        ? "打开“设置 → 高级与诊断”查看原因，或点刷新重试。"
        : "服务正在启动，通常几秒内即可使用。");
    setText(el.healthConnection, overview.connection?.label || "未知");
    const fallbackReady = Boolean(overview.cloudflare?.lastTarget?.ipv4);
    setText(el.healthFallback, fallbackReady ? "已就绪" : "等待同步");
    setText(el.healthIpv6, ipv6.address ? shortIpv6(ipv6.address) : "未检测到");
    el.healthIpv6.title = ipv6.address || "";
    el.healthIpv6.classList.toggle("is-muted", !ipv6.address);
    setText(el.healthSyncAt, overview.cloudflare?.lastSyncAt ? formatRelativeTime(overview.cloudflare.lastSyncAt) : "尚未同步");
    el.healthSyncAt.title = overview.cloudflare?.lastSyncAt ? formatDate(overview.cloudflare.lastSyncAt) : "";
    el.overviewStatusBadge.className = `g36-presence ${runtimeState === "running" ? "is-ready" : runtimeState === "error" ? "is-error" : "is-loading"}`;
    setText(el.overviewStatusBadge.lastElementChild, runtimeState === "running" ? "运行中" : runtimeState === "error" ? "需要检查" : "启动中");

    setText(el.statHttpServices, String(httpServices.length));
    setText(el.statServiceHint, httpServices.length ? `${httpServices.length} 个网页服务` : "还没有网页服务");
    setText(el.statIpv6, ipv6.address || "未检测到");
    el.statIpv6.title = ipv6.interfaceName ? `网卡：${ipv6.interfaceName}` : "";
    setText(el.statIpv6Hint, ipv6.address ? "支持 IPv6 时优先直连" : (ipv6.warning || "等待网络下发公网地址"));
    setText(el.statCaddy, caddy.status === "running" ? "运行中" : statusLabel(caddy.status));
    setText(el.statCaddyHint, caddy.binary?.exists ? "HTTPS 与证书状态正常" : "网页访问组件需要检查");
    setText(el.statFrpc, frpc.status === "running" ? "运行中" : statusLabel(frpc.status));
    setText(el.statFrpcHint, frpc.binary?.exists ? "没有 IPv6 时自动接管" : "备用通道需要检查");
    el.ipv6Badge.classList.toggle("is-ready", Boolean(ipv6.address));
    setText(el.ipv6Badge.lastElementChild, ipv6.address ? "IPv6 已就绪" : "等待 IPv6");
    el.fallbackBadge.classList.toggle("is-ready", fallbackReady);
    setText(el.fallbackBadge.lastElementChild, fallbackReady ? "IPv4 备用就绪" : "IPv4 待同步");

    const forceForms = hydrateForms || !state.formsHydrated;
    renderSection("setup", overview.nextSteps || [], false, () => renderSetup(overview.nextSteps || []));
    renderWarnings(overview);
    renderSection("overviewServices", httpServices.map((item) => ({
      id: item.id,
      title: item.title,
      name: item.name,
      url: item.url,
      enabled: item.enabled,
      online: item.online,
    })), false, () => renderOverviewServices(httpServices));
    renderSection("services", overview.services || [], forceForms, () => renderServices(overview));
    renderSection("domain", {
      device: {
        name: overview.device?.name,
        domain: overview.device?.domain,
        gatewayPort: overview.device?.gatewayPort,
        ipv6Mode: overview.device?.ipv6Mode,
        manualIpv6: overview.device?.manualIpv6,
        autoStart: overview.device?.autoStart,
        ipv6: overview.device?.ipv6Detected?.address,
      },
      cloudflare: {
        configured: overview.cloudflare?.configured,
        zoneName: overview.cloudflare?.zoneName,
        lastError: overview.cloudflare?.lastError,
        lastTarget: overview.cloudflare?.lastTarget,
        lastSummary: overview.cloudflare?.lastSummary,
      },
    }, forceForms, () => renderDomain(overview, forceForms));
    renderSection("remote", {
      ssh: overview.ssh,
      firewall: overview.firewall,
      device: overview.device,
      remoteAccess: overview.remoteAccess,
    }, forceForms, () => renderRemote(overview, forceForms));
    renderRuntime(overview);
    state.formsHydrated = true;
  }

  function showLoadPending() {
    el.gatewayLoading.hidden = false;
    el.gatewayLoading.classList.remove("is-error");
    el.gatewayLoadingIcon.innerHTML = '<i class="icon-route" aria-hidden="true"></i>';
    setText(el.gatewayLoadingTitle, "正在读取设备配置");
    setText(el.gatewayLoadingDetail, "正在整理服务入口与网络状态，请稍候。");
    el.gatewayLoadingActions.hidden = true;
  }

  function showLoadError(error) {
    el.gatewayLoading.hidden = false;
    el.gatewayLoading.classList.add("is-error");
    el.gatewayLoadingIcon.innerHTML = '<i class="icon-circle-alert" aria-hidden="true"></i>';
    setText(el.gatewayLoadingTitle, "设备配置读取失败");
    setText(el.gatewayLoadingDetail, error?.message || "无法连接本机后台，请确认 88FRP 正在运行。");
    el.gatewayLoadingActions.hidden = false;
    el.onboardingView.hidden = true;
    el.gatewayWorkspace.hidden = true;
  }

  function renderOnboarding(overview) {
    setText(el.topDeviceName, "初始化统一入口");
    setText(el.railDeviceName, "尚未初始化");
    setText(el.railDomain, "先连接这台电脑");
    setText(el.railStatusText, "待配置");
    el.railStatusChip.className = "rail-live is-loading";
    el.railStatusChip.title = "等待初始化";
    setText(el.connectionText, "本机配置");
    el.connectionPill.className = "connection-pill mode-local";
    const caddy = overview.runtime?.caddy;
    const hasCaddy = Boolean(caddy?.binary?.exists);
    el.binaryNotice.hidden = hasCaddy;
    const instances = overview.legacyInstances || [];
    const currentValue = el.migrateInstance.value;
    el.migrateInstance.innerHTML = instances.length
      ? instances.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.hasConfig ? "" : "（缺少配置）"}</option>`).join("")
      : '<option value="">没有可迁移的旧实例</option>';
    if (currentValue && instances.some((item) => item.id === currentValue)) el.migrateInstance.value = currentValue;
    el.btnMigrate.disabled = !instances.length;
    hydrateMigrateName();
  }

  function renderSetup(steps) {
    const done = steps.filter((item) => item.done).length;
    el.setupCard.hidden = !steps.length || steps.every((item) => item.done);
    setText(el.setupProgress, `${done} / ${steps.length || 0}`);
    el.setupList.innerHTML = steps.map((item) => `
      <div class="setup-item${item.done ? " is-done" : ""}">
        <span class="setup-check"><i class="${item.done ? "icon-check" : "icon-circle"}" aria-hidden="true"></i></span>
        <div><strong>${escapeHtml(friendlyStepTitle(item.title))}</strong><span>${item.done ? "已完成" : "还需要处理"}</span></div>
      </div>
    `).join("");
  }

  function renderWarnings(overview) {
    const warnings = [];
    const caddy = overview.runtime?.caddy || {};
    const frpc = overview.runtime?.frpc || {};
    if (!caddy.binary?.exists) warnings.push("网页访问组件尚未就绪，HTTPS 入口暂时无法启动。");
    if (caddy.status === "error" && caddy.lastError) warnings.push(`网页访问：${caddy.lastError}`);
    if (frpc.status === "error" && frpc.lastError) warnings.push(`IPv4 备用通道：${frpc.lastError}`);
    if (!overview.source?.lastBaseConfigAvailable) warnings.push("后台连接需要刷新，IPv4 备用通道暂时不可用。");
    if (overview.cloudflare?.lastError) warnings.push(`域名地址同步：${overview.cloudflare.lastError}`);
    if (overview.device?.domain && !overview.cloudflare?.configured) warnings.push("尚未完成域名授权，HTTPS 证书暂时无法签发。");
    if (overview.device?.ipv6Detected?.warning) warnings.push(`IPv6：${overview.device.ipv6Detected.warning}`);
    if (overview.ssh?.enabled && overview.ssh?.relay?.status === "error") {
      warnings.push(`SSH 安全入口：${overview.ssh.relay.lastError || "启动失败"}`);
    }
    for (const service of overview.services || []) {
      if (service.kind === "udp" && service.enabled && service.relay?.status === "error") {
        warnings.push(`UDP「${service.title}」中继：${service.relay.lastError || "启动失败"}`);
      }
    }
    if (overview.firewall?.supported && !overview.firewall?.pending && overview.firewall?.firewallEnabled) {
      const missing = overview.firewall?.missingTcpPorts || [];
      if (missing.length) warnings.push(`Windows 防火墙还缺少端口 ${missing.join("、")} 的放行规则，公网可能无法连接。`);
      const missingUdp = overview.firewall?.missingUdpPorts || [];
      if (missingUdp.length) warnings.push(`Windows 防火墙还缺少 UDP 端口 ${missingUdp.join("、")} 的放行规则。`);
    }
    for (let index = 0; index < warnings.length; index += 1) warnings[index] = friendlyWarning(warnings[index]);
    el.warningStack.hidden = warnings.length === 0;
    renderSection("warnings", warnings, false, () => {
      el.gatewayWarnings.innerHTML = warnings.map((message) => `
        <div class="warning-item"><i class="icon-circle-alert" aria-hidden="true"></i><span>${escapeHtml(message)}</span></div>
      `).join("");
    });
  }

  function renderServices(overview) {
    const services = overview.services || [];
    const domain = overview.device?.domain || "example.com";
    const port = overview.device?.gatewayPort || 7777;
    const firstHttp = services.find((item) => item.kind === "http" && item.enabled)
      || services.find((item) => item.kind === "http");
    setText(el.serviceUrlExample, `${firstHttp?.name || "alist"}.${formatUrlHost(domain, port)}`);
    const webCount = services.filter((item) => item.kind === "http" && item.enabled).length;
    const directCount = services.filter((item) => item.kind !== "http" && item.enabled).length;
    const unpublishedCount = services.filter((item) => !item.enabled).length;
    setText(el.serviceCountChip, [
      webCount ? `${webCount} 个网页` : "",
      directCount ? `${directCount} 个直连` : "",
      unpublishedCount ? `${unpublishedCount} 个未发布` : "",
    ].filter(Boolean).join(" · ") || "0 个服务");
    el.serviceEmpty.hidden = services.length > 0;
    el.serviceList.hidden = services.length === 0;
    const renderCard = (service) => {
      const http = service.kind === "http";
      const endpoint = service.kind === "tcp"
        ? service.tcpEndpoint || `${domain}:${service.remotePort}`
        : service.endpoint || (http ? "" : `${domain}:${service.remotePort}`);
      const url = service.url || endpoint;
      const canOpen = http && service.enabled && isHttpUrl(url) && service.online !== false;
      const relayStatus = service.relay?.status || "";
      const meta = serviceMeta(service);
      const onlineLabel = !service.enabled ? "已停用" : http || service.kind === "tcp"
        ? (service.online === true ? "本地可达" : service.online === false ? "本地未响应" : "检测中")
        : relayStatus === "running" ? "通道就绪"
          : relayStatus === "direct" ? "直接连接"
            : relayStatus === "error" ? "通道异常" : "等待连接";
      const stateClass = !service.enabled ? "is-off"
        : service.online === false || relayStatus === "error" ? "is-warning" : "is-on";
      return `
        <article class="service-card g37-service-row${service.enabled ? "" : " is-disabled"}">
          <span class="service-row-icon tone-${meta.tone}"><i class="${meta.icon}" aria-hidden="true"></i></span>
          <div class="service-row-main">
            <div class="service-row-title">
              <h2>${escapeHtml(meta.title)}</h2>
              <span class="service-tag">${escapeHtml(meta.tag)}</span>
              <span class="service-state ${stateClass}"><i></i>${onlineLabel}</span>
            </div>
            <code class="service-row-url">${escapeHtml(http ? `${service.name}.${formatUrlHost(domain, port)}` : endpoint)}</code>
            ${meta.description ? `<p class="service-description">${escapeHtml(meta.description)}</p>` : ""}
          </div>
          <div class="service-row-actions">
            ${canOpen
              ? `<a class="service-open-button" href="${escapeHtml(url)}" target="_blank" rel="noopener"><i class="icon-external-link" aria-hidden="true"></i><span>打开</span></a>`
              : http && service.enabled ? `<span class="service-open-button is-disabled" title="本机服务未响应或链接尚未就绪"><i class="icon-external-link" aria-hidden="true"></i><span>打开</span></span>` : ""}
            ${service.enabled ? `<button class="service-icon-button" data-action="copy" data-id="${escapeHtml(service.id)}" type="button" title="复制地址" aria-label="复制地址"><i class="icon-copy" aria-hidden="true"></i></button>` : ""}
            <details class="service-menu">
              <summary class="service-icon-button" title="更多操作" aria-label="更多操作"><i class="icon-more-horizontal" aria-hidden="true"></i></summary>
              <div class="service-menu-panel">
                <button class="service-menu-item" data-action="edit" data-id="${escapeHtml(service.id)}" type="button"><i class="icon-pencil" aria-hidden="true"></i><span>${service.enabled ? "编辑服务" : "编辑并启用"}</span></button>
                <button class="service-menu-item danger-text" data-action="delete" data-id="${escapeHtml(service.id)}" type="button"><i class="icon-trash-2" aria-hidden="true"></i><span>删除服务</span></button>
              </div>
            </details>
          </div>
        </article>
      `;
    };
    const group = (label, items) => items.length ? `
      <section class="service-group">
        <div class="service-group-head"><h2>${label}</h2><span>${items.length} 个</span></div>
        <div class="service-grid">${items.map(renderCard).join("")}</div>
      </section>
    ` : "";
    el.serviceList.innerHTML = [
      group("网页服务", services.filter((item) => item.kind === "http" && item.enabled)),
      group("直连服务", services.filter((item) => item.kind !== "http" && item.enabled)),
      group("未发布", services.filter((item) => !item.enabled)),
    ].join("");
  }

  function renderOverviewServices(services) {
    if (!services.length) {
      el.overviewServices.innerHTML = `
        <div class="home-service-empty">
          <i class="icon-server" aria-hidden="true"></i>
          <strong>还没有服务</strong>
          <span>添加网页服务后，这里会出现一键入口。</span>
        </div>
      `;
      return;
    }
    el.overviewServices.innerHTML = services.slice(0, 6).map((service) => {
      const meta = serviceMeta(service);
      const href = isHttpUrl(service.url) ? service.url : "#services";
      return `
        <a class="home-service-card" href="${escapeHtml(href)}" ${href === "#services" ? "" : 'target="_blank" rel="noopener"'}>
          <span class="home-service-icon tone-${meta.tone}"><i class="${meta.icon}" aria-hidden="true"></i></span>
          <span class="home-service-copy">
            <strong>${escapeHtml(meta.title)}</strong>
            <span>${escapeHtml(meta.description || "已通过统一入口发布")}</span>
          </span>
          <span class="home-service-state ${service.online === false ? "is-warning" : ""}"><i></i>${service.online === false ? "未响应" : "在线"}</span>
        </a>
      `;
    }).join("");
  }

  function renderDomain(overview, hydrateForms) {
    const device = overview.device || {};
    const cloudflare = overview.cloudflare || {};
    const gatewayPort = device.gatewayPort || 7777;
    if (hydrateForms) {
      el.deviceName.value = friendlyDeviceName(device.name);
      el.deviceGatewayPort.value = String(gatewayPort);
      el.deviceDomain.value = device.domain || "";
      el.deviceIpv6Mode.value = device.ipv6Mode || "auto";
      el.deviceManualIpv6.value = device.manualIpv6 || "";
      el.deviceAutoStart.checked = device.autoStart !== false;
    }
    el.cloudflareChip.className = `status-chip ${cloudflare.configured ? (cloudflare.lastError ? "error" : "running") : ""}`;
    setText(el.cloudflareChip, cloudflare.configured ? (cloudflare.lastError ? "需处理" : "已授权") : "未授权");
    setText(el.cloudflareZone, cloudflare.zoneName || "未配置");
    setText(el.cloudflareState, cloudflare.configured ? (cloudflare.lastError ? "需要处理" : "自动同步中") : "等待授权");
    el.cloudflareState.classList.toggle("is-warning", Boolean(cloudflare.configured && cloudflare.lastError));
    setText(el.cloudflareChecked, cloudflare.lastSyncAt ? formatRelativeTime(cloudflare.lastSyncAt) : "-");
    el.cloudflareChecked.title = cloudflare.lastSyncAt ? formatDate(cloudflare.lastSyncAt) : "";
    const summary = cloudflare.lastSummary;
    const summaryParts = [];
    if (summary) {
      if (summary.changed) summaryParts.push(`更新 ${summary.changed} 条`);
      if (summary.conflicts) summaryParts.push(`${summary.conflicts} 条待检查`);
    }
    setText(el.cloudflareRecords, summary?.desired ? `${summary.desired} 条` : "-");
    setText(el.cloudflareSummary, summaryParts.join(" · ") || (summary ? "无变化" : "-"));
    el.cloudflareError.hidden = !cloudflare.lastError;
    setText(el.cloudflareError, cloudflare.lastError || "");

    const target = cloudflare.lastTarget || {};
    const domain = device.domain || "example.com";
    const ipv6Address = device.ipv6Detected?.address || target.ipv6 || "";
    const ipv4Address = target.ipv4 || "";
    setText(el.dnsIpv6, ipv6Address || "等待检测");
    setText(el.dnsIpv4, ipv4Address || "等待同步");
    const readyCount = (ipv6Address ? 1 : 0) + (ipv4Address ? 1 : 0);
    el.dnsReadyChip.className = `status-chip ${readyCount === 2 ? "running" : ""}`;
    setText(el.dnsReadyChip, readyCount === 2
      ? "双通道就绪"
      : readyCount === 1
        ? (ipv6Address ? "IPv6 已就绪" : "仅 IPv4 可用")
        : "等待同步");
    const rows = [
      ["A", domain, target.ipv4, "自动入口 · IPv4 备用"],
      ["A", `*.${domain}`, target.ipv4, "网页自动入口 · IPv4 备用"],
      ["A", `v4.${domain}`, target.ipv4, "IPv4 专用入口"],
      ["A", `ssh-v4.${domain}`, target.ipv4, "SSH IPv4 专用入口"],
      ["AAAA", domain, target.ipv6, "自动入口 · IPv6 直连"],
      ["AAAA", `*.${domain}`, target.ipv6, "网页自动入口 · IPv6 直连"],
      ["AAAA", `v6.${domain}`, target.ipv6, "IPv6 专用入口"],
      ["AAAA", `ssh-v6.${domain}`, target.ipv6, "SSH IPv6 专用入口"],
    ];
    el.dnsTable.innerHTML = rows.map(([type, name, content, purpose]) => `
      <div class="dns-row">
        <span class="dns-type ${type === "A" ? "is-v4" : "is-v6"}">${type}</span>
        <code>${escapeHtml(name)}</code>
        <span class="dns-purpose">${escapeHtml(purpose)}</span>
        <span class="dns-content${content ? "" : " is-pending"}">${escapeHtml(content || "等待同步")}</span>
      </div>
    `).join("");
  }

  function renderRemote(overview, hydrateForms) {
    const ssh = overview.ssh || {};
    const sshEndpoints = ssh.endpoints || {};
    const remoteAccess = overview.remoteAccess || {};
    if (hydrateForms) {
      el.sshEnabled.checked = Boolean(ssh.enabled);
      el.sshLocalHost.value = ssh.localHost || "127.0.0.1";
      el.sshLocalPort.value = String(ssh.localPort || 22);
      el.sshRemotePort.value = ssh.remotePort ? String(ssh.remotePort) : "";
    }
    el.sshChip.className = `status-chip ${ssh.enabled ? "running" : ""}`;
    setText(el.sshChip, ssh.enabled ? "已启用" : "未启用");
    setText(el.sshEndpoint, sshEndpoints.auto || ssh.endpoint || "未启用");
    setText(el.sshEndpointV6, sshEndpoints.ipv6 || "未启用");
    setText(el.sshEndpointV4, sshEndpoints.ipv4 || "未启用");
    const sshRelay = ssh.relay?.status === "running"
      ? "远程通道"
      : ssh.relay?.status === "direct" ? "直接连接" : ssh.relay?.status === "error" ? "通道异常" : "等待连接";
    setText(el.sshOnline, ssh.enabled
      ? `${ssh.online ? "本地可达" : "本地未响应"} · ${ssh.localPort} · ${sshRelay}`
      : "-");
    const rdpTargets = remoteAccess?.rdp?.targets || [];
    const rdpAuto = rdpTargets.find((item) => item.family === "auto")?.endpoint || "";
    const rdpV6 = rdpTargets.find((item) => item.family === "ipv6")?.endpoint || "";
    const rdpV4 = rdpTargets.find((item) => item.family === "ipv4")?.endpoint || "";
    if (el.rdpChip) {
      el.rdpChip.className = `status-chip ${rdpAuto ? "running" : ""}`;
      setText(el.rdpChip, rdpAuto ? "已启用" : "未配置");
    }
    setText(el.rdpProxyCommand, rdpAuto || "暂未添加远程桌面服务。");
    setText(el.rdpCommand, rdpV6 || "等待检测远程桌面专用地址。");
    setText(el.rdpCommandV4, rdpV4 || "等待同步远程桌面备用地址。");
    const firewall = overview.firewall || {};
    const firewallEnabled = firewall.firewallEnabled;
    const missingTcp = firewall.missingTcpPorts || [];
    const missingUdp = firewall.missingUdpPorts || [];
    const expectedTcp = firewall.expectedTcpPorts || [];
    const firewallBlocked = firewallEnabled === true && (missingTcp.length > 0 || missingUdp.length > 0);
    el.firewallChip.className = `status-chip ${
      firewall.pending ? "" :
        !firewall.supported ? "" :
          firewallEnabled === false ? "running" :
            firewallBlocked ? "error" : "running"
    }`;
    setText(el.firewallChip, firewall.pending
      ? "检查中"
      : !firewall.supported
        ? "不支持"
        : firewallEnabled === false
          ? "防火墙已关闭"
          : firewallBlocked ? "端口未覆盖" : "端口已覆盖");
    setText(el.firewallTcp, firewall.pending
      ? "检查中"
      : !firewall.supported
        ? "仅 Windows"
        : firewallEnabled === false
          ? "已关闭，无需放行"
          : missingTcp.length
            ? `缺少 ${missingTcp.join("、")}`
            : expectedTcp.length ? `已放行 ${expectedTcp.join("、")}` : "当前没有 TCP 端口");
    setText(el.firewallUdp, firewall.pending
      ? "检查中"
      : firewallEnabled === false
        ? "已关闭，无需放行"
        : missingUdp.length ? `缺少 ${missingUdp.join("、")}` : "已覆盖");
    setText(el.firewallDetail, firewall.pending
      ? "正在读取 Windows 防火墙状态。"
      : firewallEnabled === false
        ? "系统防火墙当前关闭，公网访问不受入站规则影响。"
        : firewallBlocked
          ? "重新点击“开放所需端口”即可补齐，不会关闭防火墙。"
          : "统一入口、远程桌面、SSH 和 UDP 服务所需端口均已覆盖。");
  }

  function renderRuntime(overview) {
    const runtime = overview.runtime || {};
    const caddy = runtime.caddy || {};
    const frpc = runtime.frpc || {};
    const source = overview.source || {};
    setText(el.caddyRuntimeState, caddy.status === "running" ? "运行正常" : statusLabel(caddy.status));
    setText(el.caddyPid, "网页访问与证书");
    setText(el.caddyBinary, caddy.lastError ? "需要检查" : "工作正常");
    setText(el.caddyError, caddy.lastError ? friendlyWarning(caddy.lastError) : "网页访问、证书和子域名转发工作正常。");
    el.caddyRuntimeCard.classList.toggle("is-error", !caddy.binary?.exists || caddy.status === "error");
    setText(el.frpcRuntimeState, frpc.status === "running" ? "运行正常" : statusLabel(frpc.status));
    setText(el.frpcPid, "IPv4 备用通道");
    setText(el.frpcBinary, frpc.lastError ? "需要检查" : "工作正常");
    const relays = runtime.relays || [];
    const readyRelays = relays.filter((item) => ["running", "direct"].includes(item.status)).length;
    const relaySummary = relays.length
      ? `远程与直连服务通道 ${readyRelays}/${relays.length} 就绪。`
      : "当前没有需要额外通道的服务。";
    setText(el.frpcError, frpc.lastError ? friendlyWarning(frpc.lastError) : `IPv4 网络会自动经 88FRP 节点访问；${relaySummary}`);
    el.frpcRuntimeCard.classList.toggle("is-error", !frpc.binary?.exists || frpc.status === "error");
    setText(el.sourceState, source.lastBaseConfigAvailable ? "配置可用" : "需要同步");
    setText(el.sourceName, source.migratedInstanceName ? friendlyDeviceName(source.migratedInstanceName) : (source.legacyInstanceId || "-"));
    setText(el.sourceConfig, source.lastBaseConfigAvailable ? "存在" : "不存在");
    const autoSync = source.autoSync || {};
    const autoSyncError = autoSync.lastError ? friendlyWarning(autoSync.lastError) : "";
    let sourceDetail = "请点击“重新连接来源”重新拉取。";
    if (!source.lastBaseConfigAvailable) {
      sourceDetail = "请点击“重新连接来源”重新拉取。";
    } else if (autoSyncError) {
      sourceDetail = `自动同步失败，将自动重试：${autoSyncError}`;
    } else if (autoSync.lastCheckAt) {
      sourceDetail = `后台每 5 秒自动检查 · ${formatRelativeTime(autoSync.lastCheckAt)} · 密钥不会在本机界面回显。`;
    } else {
      sourceDetail = "连接信息正常，后台启动后会每 5 秒检查 88FRP 地址变化。";
    }
    setText(el.sourceError, sourceDetail);
    el.sourceRuntimeCard.classList.toggle("is-error", !source.lastBaseConfigAvailable || Boolean(autoSyncError));
  }

  function switchView(view, persist = true) {
    const target = VIEWS.has(view) ? view : "overview";
    state.view = target;
    setText(el.topDeviceName, pageLabel(target));
    document.querySelectorAll(".rail-nav-item").forEach((button) => {
      const active = button.dataset.view === target;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.panel === target);
    });
    if (persist) history.replaceState(null, "", `#${target}`);

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function pageLabel(view) {
    return {
      overview: "概览",
      services: "服务",
      remote: "远程访问",
      settings: "设置",
    }[view] || "管理控制台";
  }

  function renderLogTabs() {
    document.querySelectorAll("#logTabs [data-log]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.log === state.logView);
    });
  }

  async function loadLogs() {
    const response = await API.getGatewayLogs(200);
    const raw = response.data?.[state.logView] || "";
    const content = state.logView === "audit" ? formatAuditLog(raw) : raw;
    el.gatewayLog.textContent = content.trim() || "暂无日志。";
    el.gatewayLog.scrollTop = el.gatewayLog.scrollHeight;
    renderLogTabs();
  }

  async function saveDevice(event) {
    event.preventDefault();
    await withBusy(async () => {
      await API.updateGatewayDevice({
        name: el.deviceName.value.trim(),
        domain: el.deviceDomain.value.trim(),
        gatewayPort: Number(el.deviceGatewayPort.value),
        ipv6Mode: el.deviceIpv6Mode.value,
        manualIpv6: el.deviceManualIpv6.value.trim(),
        autoStart: el.deviceAutoStart.checked,
      });
      showToast("设备设置已保存。");
      await refresh({ hydrateForms: true });
    });
  }

  async function saveToken(event) {
    event.preventDefault();
    const token = el.cloudflareToken.value.trim();
    if (!token) {
      showToast("请先粘贴 Cloudflare Token。");
      el.cloudflareToken.focus();
      return;
    }
    await withBusy(async () => {
      await API.saveGatewayToken(token, el.deviceDomain.value.trim());
      el.cloudflareToken.value = "";
      showToast("Cloudflare 授权已验证，证书申请已启动。");
      await refresh({ hydrateForms: false });
    });
  }

  async function syncDns() {
    await withBusy(async () => {
      const response = await API.syncGatewayDns();
      showToast(response.message || "DNS 已同步。");
      await refresh({ hydrateForms: false });
    });
  }

  async function saveSsh() {
    await withBusy(async () => {
      await API.updateGatewaySsh({
        enabled: el.sshEnabled.checked,
        localHost: el.sshLocalHost.value.trim(),
        localPort: Number(el.sshLocalPort.value),
        remotePort: el.sshRemotePort.value ? Number(el.sshRemotePort.value) : 0,
      });
      showToast("SSH 设置已保存。");
      await refresh({ hydrateForms: true });
    });
  }

  async function openFirewall() {
    if (!window.confirm("将为统一入口、SSH 和 UDP 服务添加 Windows 防火墙入站规则，不会关闭防火墙。继续吗？")) return;
    await withBusy(async () => {
      const response = await API.openGatewayFirewall();
      const ports = (response.data?.tcpPorts || []).join(", ");
      showToast(`防火墙规则已更新${ports ? `：TCP ${ports}` : ""}`);
      await refresh({ hydrateForms: false });
    });
  }

  async function restartGateway() {
    if (!window.confirm("重启期间统一入口会短暂断开。继续吗？")) return;
    await withBusy(async () => {
      await API.restartGateway();
      showToast("统一入口已重启。");
      await refresh({ hydrateForms: false });
    });
  }

  async function syncSource() {
    await withBusy(async () => {
      const response = await API.syncGatewaySource();
      showToast(response.data?.changed ? "连接来源已同步并重新加载。" : "连接来源没有变化。");
      await refresh({ hydrateForms: false });
    });
  }

  function openServiceDialog(service = null) {
    el.serviceForm.reset();
    el.serviceMessage.textContent = "";
    el.serviceId.value = service?.id || "";
    el.serviceDialogTitle.textContent = service ? "编辑服务" : "添加服务";
    el.serviceKind.value = service?.kind || "http";
    el.serviceKind.disabled = Boolean(service);
    el.serviceName.value = service?.name || "";
    el.serviceTitle.value = service?.title || "";
    el.serviceLocalHost.value = service?.localHost || "127.0.0.1";
    el.serviceLocalPort.value = service ? String(service.localPort) : "";
    el.serviceRemotePort.value = service?.remotePort ? String(service.remotePort) : "";
    el.serviceTag.value = service?.tag || (service?.kind === "udp" ? "UDP" : service?.kind === "tcp" ? "TCP" : "服务");
    el.serviceDescription.value = service?.description || "";
    el.serviceEnabled.checked = service ? service.enabled !== false : true;
    syncServiceKindFields();
    el.serviceDialog.showModal();
    requestAnimationFrame(() => el.serviceName.focus());
  }

  function closeServiceDialog() {
    el.serviceDialog.close();
    el.serviceKind.disabled = false;
  }

  function syncServiceKindFields() {
    const kind = el.serviceKind.value;
    const direct = kind === "tcp" || kind === "udp";
    el.serviceRemotePortField.hidden = !direct;
    el.serviceRemotePort.required = direct;
    el.serviceRemoteHint.hidden = !direct;
    setText(el.serviceRemotePortLabel, kind === "tcp"
      ? "公网 TCP 端口（IPv6 直连 / IPv4 备用通道共用）"
      : "公网 UDP 端口（IPv6 直连 / IPv4 备用通道共用）");
    if (direct && !el.serviceTag.value) el.serviceTag.value = kind === "tcp" ? "TCP" : "UDP";
  }

  async function saveService(event) {
    event.preventDefault();
    const id = el.serviceId.value;
    const payload = {
      kind: el.serviceKind.value,
      name: el.serviceName.value.trim(),
      title: el.serviceTitle.value.trim(),
      localHost: el.serviceLocalHost.value.trim(),
      localPort: Number(el.serviceLocalPort.value),
      remotePort: el.serviceKind.value === "http" ? 0 : Number(el.serviceRemotePort.value),
      tag: el.serviceTag.value.trim(),
      description: el.serviceDescription.value.trim(),
      enabled: el.serviceEnabled.checked,
    };
    el.serviceMessage.textContent = "正在发布服务…";
    await withBusy(async () => {
      if (id) await API.updateGatewayService(id, payload);
      else await API.addGatewayService(payload);
      closeServiceDialog();
      showToast(id ? "服务已更新。" : "服务已添加。");
      await refresh({ hydrateForms: false });
    }, el.serviceMessage);
  }

  async function handleServiceAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    button.closest("details")?.removeAttribute("open");
    const service = (state.overview?.services || []).find((item) => item.id === button.dataset.id);
    if (!service) return;
    if (button.dataset.action === "edit") {
      openServiceDialog(service);
      return;
    }
    if (button.dataset.action === "copy") {
      const endpoint = service.kind === "tcp"
        ? service.tcpEndpoint
        : service.kind === "udp" ? service.endpoint : "";
      await copyText(service.url || endpoint || `${state.overview.device.domain}:${service.remotePort}`);
      return;
    }
    if (button.dataset.action === "delete") {
      if (!window.confirm(`确定删除服务「${service.title}」吗？删除后会重新发布入口。`)) return;
      await withBusy(async () => {
        await API.deleteGatewayService(service.id);
        showToast("服务已删除。");
        await refresh({ hydrateForms: false });
      });
    }
  }

  function hydrateMigrateName() {
    const option = el.migrateInstance.selectedOptions?.[0];
    if (!option || !option.value) return;
    if (!el.migrateDeviceName.value.trim()) el.migrateDeviceName.value = option.textContent.replace(/（.*?）/g, "").trim();
  }

  async function migrate(event) {
    event.preventDefault();
    el.migrateMessage.textContent = "正在切换这台电脑的连接方式…";
    await withBusy(async () => {
      const response = await API.migrateGateway({
        instanceId: el.migrateInstance.value,
        name: el.migrateDeviceName.value.trim(),
        domain: el.migrateDomain.value.trim(),
        gatewayPort: Number(el.migrateGatewayPort.value),
        importServices: el.migrateImportServices.checked,
      });
      showToast("统一入口已初始化。");
      state.formsHydrated = false;
      await refresh({ hydrateForms: true });
      const warnings = response.data?.warnings || [];
      if (warnings.length) showToast(warnings.join("；"));
    }, el.migrateMessage);
  }

  async function bootstrap(event) {
    event.preventDefault();
    el.bootstrapMessage.textContent = "正在创建连接来源并初始化…";
    await withBusy(async () => {
      const response = await API.bootstrapGateway({
        name: el.bootstrapDeviceName.value.trim(),
        secretKey: el.bootstrapSecret.value.trim(),
        remoteUrl: el.bootstrapRemoteUrl.value.trim() || undefined,
        domain: el.bootstrapDomain.value.trim(),
        gatewayPort: Number(el.bootstrapGatewayPort.value),
      });
      el.bootstrapSecret.value = "";
      showToast("新的统一入口已创建。");
      state.formsHydrated = false;
      await refresh({ hydrateForms: true });
      const warnings = response.data?.warnings || [];
      if (warnings.length) showToast(warnings.join("；"));
    }, el.bootstrapMessage);
  }

  function setConnection(connection = {}) {
    const mode = connection.mode || "unknown";
    el.connectionPill.className = `connection-pill mode-${mode}`;
    setText(el.connectionText, connection.label || "连接方式未知");
    el.connectionPill.title = connection.detail || "";
  }

  async function logout() {
    try { await API.logoutConsole(); } finally { window.location.replace("/login"); }
  }

  async function withBusy(task, messageElement = null) {
    if (state.busy) return false;
    state.busy = true;
    showBusy(true);
    if (messageElement) {
      messageElement.textContent = "";
      messageElement.classList.remove("is-error");
    }
    try {
      await task();
      return true;
    } catch (error) {
      showToast(error.message);
      if (messageElement) {
        messageElement.textContent = error.message;
        messageElement.classList.add("is-error");
      }
      return false;
    } finally {
      state.busy = false;
      showBusy(false);
    }
  }

  function showBusy(active) {
    el.busyIndicator.classList.toggle("is-active", active);
    el.busyIndicator.setAttribute("aria-hidden", String(!active));
  }

  async function copyText(text) {
    const value = String(text || "").trim();
    if (!value) {
      showToast("没有可复制的内容。");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    showToast("已复制。");
  }

  function showToast(message) {
    el.toast.textContent = String(message || "");
    el.toast.style.display = "block";
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.toast.style.display = "none"; }, 3400);
  }

  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    writeLocal("88frp.theme", theme);
    const dark = theme === "dark";
    const icon = el.btnTheme?.querySelector("i");
    if (icon) icon.className = dark ? "icon-sun" : "icon-moon";
    if (el.btnTheme) {
      el.btnTheme.setAttribute("aria-label", dark ? "切换浅色模式" : "切换深色模式");
      el.btnTheme.title = dark ? "切换浅色模式" : "切换深色模式";
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111827" : "#f6f8fb");
  }

  function preferredTheme() {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function viewFromUrl() {
    const value = String(window.location.hash || "").replace(/^#/, "");
    const target = value === "domain" || value === "runtime" ? "settings" : value;
    return VIEWS.has(target) ? target : "overview";
  }

  function statusLabel(status) {
    return {
      running: "运行中",
      stopped: "已停止",
      starting: "启动中",
      stopping: "停止中",
      reconnecting: "重连中",
      error: "异常",
    }[status] || "未启动";
  }

  function statusClass(status) {
    if (status === "running") return "running";
    if (status === "error") return "error";
    return "";
  }

  function combinedRuntimeState(caddy, frpc) {
    if (caddy === "running" && frpc === "running") return "running";
    if (caddy === "error" || frpc === "error") return "error";
    return "stopped";
  }

  function formatUrlHost(domain, port) {
    return Number(port) === 443 ? domain : `${domain}:${port}`;
  }

  function setEndpointRow(codeNode, linkNode, value, fallback) {
    const endpoint = String(value || "").trim();
    setText(codeNode, endpoint || fallback);
    if (linkNode) {
      linkNode.href = endpoint || "#";
      linkNode.classList.toggle("is-disabled", !endpoint);
      linkNode.setAttribute("aria-disabled", endpoint ? "false" : "true");
    }
  }

  function formatDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(date);
  }

  function formatRelativeTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return "刚刚";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    return formatDate(value);
  }

  function shortIpv6(value) {
    const text = String(value || "");
    const parts = text.split(":");
    if (parts.length < 6) return text;
    return `${parts[0]}:${parts[1]}:…:${parts[parts.length - 2]}:${parts[parts.length - 1]}`;
  }

  function setText(node, value) {
    if (node) node.textContent = String(value ?? "");
  }

  function renderSection(key, value, force, render) {
    const signature = JSON.stringify(value);
    if (!force && state.signatures[key] === signature) return false;
    state.signatures[key] = signature;
    render();
    return true;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function serviceTag(value, fallback) {
    const tag = String(value || "").trim();
    return !tag || tag === "旧服务" ? fallback : tag;
  }

  function serviceDescription(value) {
    const description = String(value || "").trim();
    return description.startsWith("从旧版隧道导入") ? "" : description;
  }

  function isHttpUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }

  function formatAuditLog(content) {
    const labels = {
      "cloudflare.dns.sync": "DNS 记录已自动同步",
      "caddy.apply": "网页访问配置已更新",
      "caddy.start": "网页访问已启动",
      "caddy.stop": "网页访问已停止",
      "caddy.restart": "网页访问已重启",
      "frpc.apply": "IPv4 备用通道配置已更新",
      "frpc.start": "IPv4 备用通道已启动",
      "frpc.stop": "IPv4 备用通道已停止",
      "relay.start": "远程连接通道已启动",
      "relay.stop": "远程连接通道已停止",
      "gateway.runtime.restart": "统一入口已重启",
      "gateway.migrate": "配置导入完成",
      "gateway.service.add": "已添加服务",
      "gateway.service.update": "已更新服务",
      "gateway.service.delete": "已删除服务",
    };
    return String(content || "").split("\n").map((line) => {
      try {
        const item = JSON.parse(line);
        const time = item.ts ? new Date(item.ts).toLocaleTimeString("zh-CN", { hour12: false }) : "";
        const friendly = labels[item.action] || "配置已更新";
        return `${time}  ${friendly}${item.outcome === "failed" ? "（失败）" : ""}`;
      } catch {
        return line;
      }
    }).filter(Boolean).join("\n");
  }

  function readLocal(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }

  function writeLocal(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* Storage can be unavailable. */ }
  }

  function readOverviewCache() {
    try {
      const raw = window.localStorage.getItem(OVERVIEW_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.data ? parsed.data : null;
    } catch {
      return null;
    }
  }

  function writeOverviewCache(data) {
    try {
      window.localStorage.setItem(OVERVIEW_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
    } catch { /* Storage can be unavailable. */ }
  }

  function friendlyDeviceName(value) {
    const name = String(value || "").trim();
    if (!name) return "这台设备";
    return /^\d+$/.test(name) ? "XPS 主机" : name;
  }

  function serviceMeta(service) {
    const meta = SERVICE_META[String(service?.name || "").toLowerCase()] || {};
    const visual = serviceVisual(service, meta);
    const http = service?.kind === "http";
    const fallbackTag = http ? "网页服务" : service?.kind === "tcp" ? "直连" : "直连服务";
    const rawTag = meta.tag || serviceTag(service?.tag, fallbackTag);
    const title = meta.title || service?.title || "未命名服务";
    return {
      title,
      tag: rawTag === title ? fallbackTag : rawTag,
      description: meta.description || serviceDescription(service?.description),
      icon: visual.icon,
      tone: visual.tone,
    };
  }

  function serviceVisual(service, meta = {}) {
    if (meta.icon) return { icon: meta.icon, tone: meta.tone || "blue" };
    if (service?.kind === "tcp") return { icon: "icon-monitor", tone: "teal" };
    if (service?.kind === "udp") return { icon: "icon-radio", tone: "amber" };
    const text = `${service?.name || ""} ${service?.title || ""} ${service?.tag || ""} ${service?.description || ""}`.toLowerCase();
    if (/(cloud|drive|盘|nas|alist|file|文件)/.test(text)) return { icon: "icon-cloud", tone: "sky" };
    if (/(code|dev|开发|terminal|终端)/.test(text)) return { icon: "icon-code-2", tone: "violet" };
    if (/(ai|deepseek|模型|智能)/.test(text)) return { icon: "icon-sparkles", tone: "teal" };
    if (/(房|楼|estate|house|property)/.test(text)) return { icon: "icon-building-2", tone: "amber" };
    return { icon: "icon-globe", tone: "blue" };
  }

  function friendlyStepTitle(value) {
    return String(value || "")
      .replaceAll("Caddy", "统一入口")
      .replaceAll("frpc", "备用通道");
  }

  function friendlyWarning(value) {
    const text = String(value || "");
    if (/发现旧\s*(Caddy|frpc)\s*进程\s*PID=\d+/.test(text)) {
      return "检测到一个旧的后台进程，但无法确认归属；为避免影响其他程序，已停止自动启动。";
    }
    return text
      .replaceAll("Caddy", "网页访问")
      .replaceAll("frpc", "IPv4 备用通道")
      .replace(/PID=\d+/g, "")
      .replaceAll("中继", "连接通道")
      .replaceAll("兜底", "备用");
  }
})();
