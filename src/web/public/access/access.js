(() => {
  const savedGroups = (() => {
    try {
      const value = JSON.parse(window.localStorage.getItem("88frp.access.collapsedGroups") || "[]");
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  })();
  const state = { links: [], source: null, centerUrl: window.location.href, toastTimer: null, speedController: null, collapsedGroups: new Set(savedGroups) };
  const elements = {
    linkList: document.getElementById("linkList"),
    emptyState: document.getElementById("emptyState"),
    enabledCount: document.getElementById("enabledCount"),
    openableCount: document.getElementById("openableCount"),
    totalCount: document.getElementById("totalCount"),
    connectionStatus: document.getElementById("connectionStatus"),
    linkSearch: document.getElementById("linkSearch"),
    refreshLinks: document.getElementById("refreshLinks"),
    copyCenterUrl: document.getElementById("copyCenterUrl"),
    openSpeedTest: document.getElementById("openSpeedTest"),
    speedTestDialog: document.getElementById("speedTestDialog"),
    closeSpeedTest: document.getElementById("closeSpeedTest"),
    cancelSpeedTest: document.getElementById("cancelSpeedTest"),
    startSpeedTest: document.getElementById("startSpeedTest"),
    stopSpeedTest: document.getElementById("stopSpeedTest"),
    speedTestDuration: document.getElementById("speedTestDuration"),
    speedLatency: document.getElementById("speedLatency"),
    speedCurrent: document.getElementById("speedCurrent"),
    speedAverage: document.getElementById("speedAverage"),
    speedPeak: document.getElementById("speedPeak"),
    speedProgressBar: document.getElementById("speedProgressBar"),
    speedTestStatus: document.getElementById("speedTestStatus"),
    toast: document.getElementById("toast"),
  };

  function request(url) {
    return fetch(url, { headers: { "Content-Type": "application/json" } }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.success) throw new Error(body?.message || `请求失败：HTTP ${response.status}`);
      return body.data;
    });
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
  }

  async function copyText(value, message) {
    try {
      await navigator.clipboard.writeText(value || "");
      showToast(message);
    } catch {
      const input = document.createElement("textarea");
      input.value = value || "";
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      showToast(message);
    }
  }

  function createIconButton(iconClass, title, action, disabled = false) {
    const button = document.createElement("button");
    button.className = "icon-button";
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.disabled = disabled;
    button.innerHTML = `<span class="${iconClass}" aria-hidden="true"></span>`;
    button.addEventListener("click", action);
    return button;
  }

  function visibleLinks() {
    const search = elements.linkSearch.value.trim().toLocaleLowerCase();
    if (!search) return state.links;
    return state.links.filter((link) => [link.name, link.tunnelName, link.instanceName, link.group, link.endpoint, link.url, link.localPort, link.remotePort]
      .join(" ").toLocaleLowerCase().includes(search));
  }

  function renderStats(links) {
    elements.enabledCount.textContent = String(links.filter((link) => link.enabled).length);
    elements.openableCount.textContent = String(links.filter((link) => link.enabled && link.canOpen).length);
    elements.totalCount.textContent = String(links.length);
  }

  function toggleGroup(group) {
    if (state.collapsedGroups.has(group)) state.collapsedGroups.delete(group);
    else state.collapsedGroups.add(group);
    window.localStorage.setItem("88frp.access.collapsedGroups", JSON.stringify([...state.collapsedGroups]));
    renderLinks();
  }

  function formatMbps(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "--";
    const megabits = bytesPerSecond * 8 / 1_000_000;
    return megabits >= 100 ? `${megabits.toFixed(0)} Mbps` : `${megabits.toFixed(1)} Mbps`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function resetSpeedMetrics() {
    elements.speedLatency.textContent = "--";
    elements.speedCurrent.textContent = "--";
    elements.speedAverage.textContent = "--";
    elements.speedPeak.textContent = "--";
    elements.speedProgressBar.style.width = "0%";
    elements.speedTestStatus.textContent = "准备就绪";
  }

  function openSpeedTest() {
    resetSpeedMetrics();
    elements.speedTestDialog.showModal();
  }

  function stopSpeedTest() {
    if (state.speedController) state.speedController.abort();
  }

  function closeSpeedTest() {
    stopSpeedTest();
    elements.speedTestDialog.close();
  }

  function updateSpeedControls(running) {
    elements.startSpeedTest.hidden = running;
    elements.stopSpeedTest.hidden = !running;
    elements.speedTestDuration.disabled = running;
    elements.closeSpeedTest.disabled = running;
    elements.cancelSpeedTest.disabled = running;
  }

  async function runSpeedTest() {
    if (state.speedController) return;
    const duration = Number(elements.speedTestDuration.value) || 10;
    const startedAt = performance.now();
    const controller = new AbortController();
    let reachedDuration = false;
    const stopTimer = window.setTimeout(() => {
      reachedDuration = true;
      controller.abort();
    }, duration * 1000);
    state.speedController = controller;
    updateSpeedControls(true);
    elements.speedTestStatus.textContent = "正在建立测速通道…";
    let totalBytes = 0;
    let peakBytesPerSecond = 0;
    let sampleBytes = 0;
    let sampleAt = startedAt;
    try {
      const response = await fetch(`/access/api/speed-test?duration=${encodeURIComponent(duration)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`测速连接失败：HTTP ${response.status}`);
      const firstByteAt = performance.now();
      elements.speedLatency.textContent = `${Math.round(firstByteAt - startedAt)} ms`;
      elements.speedTestStatus.textContent = "正在测试实际下载速度…";
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const now = performance.now();
        const length = value.byteLength;
        totalBytes += length;
        sampleBytes += length;
        const sampleElapsed = (now - sampleAt) / 1000;
        const averageElapsed = (now - startedAt) / 1000;
        if (sampleElapsed >= 0.25) {
          const currentBytesPerSecond = sampleBytes / sampleElapsed;
          peakBytesPerSecond = Math.max(peakBytesPerSecond, currentBytesPerSecond);
          elements.speedCurrent.textContent = formatMbps(currentBytesPerSecond);
          elements.speedAverage.textContent = formatMbps(totalBytes / averageElapsed);
          elements.speedPeak.textContent = formatMbps(peakBytesPerSecond);
          elements.speedProgressBar.style.width = `${Math.min(100, averageElapsed / duration * 100)}%`;
          elements.speedTestStatus.textContent = `已传输 ${formatBytes(totalBytes)} · ${Math.max(0, duration - averageElapsed).toFixed(1)} 秒剩余`;
          sampleBytes = 0;
          sampleAt = now;
        }
      }
      const elapsed = Math.max(0.01, (performance.now() - startedAt) / 1000);
      const average = totalBytes / elapsed;
      elements.speedCurrent.textContent = formatMbps(average);
      elements.speedAverage.textContent = formatMbps(average);
      elements.speedPeak.textContent = formatMbps(Math.max(peakBytesPerSecond, average));
      elements.speedProgressBar.style.width = "100%";
      elements.speedTestStatus.textContent = `测速完成 · 共传输 ${formatBytes(totalBytes)}`;
    } catch (error) {
      if (error.name === "AbortError" && reachedDuration) {
        const average = totalBytes / Math.max(0.01, duration);
        elements.speedCurrent.textContent = formatMbps(average);
        elements.speedAverage.textContent = formatMbps(average);
        elements.speedPeak.textContent = formatMbps(Math.max(peakBytesPerSecond, average));
        elements.speedProgressBar.style.width = "100%";
        elements.speedTestStatus.textContent = `测速完成 · 共传输 ${formatBytes(totalBytes)}`;
      } else if (error.name === "AbortError") elements.speedTestStatus.textContent = "测速已停止";
      else elements.speedTestStatus.textContent = error.message || "测速失败，请稍后重试。";
    } finally {
      window.clearTimeout(stopTimer);
      state.speedController = null;
      updateSpeedControls(false);
    }
  }

  function createLinkCard(link) {
    const card = document.createElement("article");
    card.className = `link-card${link.enabled ? "" : " is-disabled"}${link.canOpen || link.endpoint ? "" : " is-unavailable"}`;
    const main = document.createElement("div");
    main.className = "link-card-main";
    const header = document.createElement("div");
    header.className = "link-card-header";
    const name = document.createElement("h3");
    name.className = "link-name";
    name.textContent = link.name;
    const type = document.createElement("span");
    type.className = "tunnel-type";
    type.textContent = link.type || "FRP";
    header.append(name, type);
    const meta = document.createElement("p");
    meta.className = "link-meta";
    meta.textContent = `${link.instanceName || "未命名实例"} · 本地 ${link.localPort || "-"} · 远程 ${link.remotePort || "-"}`;
    const address = document.createElement("div");
    address.className = "address-box";
    const addressLabel = document.createElement("span");
    addressLabel.className = "address-label";
    addressLabel.textContent = link.url ? "访问链接" : "连接地址";
    const addressValue = document.createElement(link.url ? "a" : "div");
    addressValue.className = `address-value${link.url ? " address-link" : " endpoint-value"}`;
    addressValue.textContent = link.url || link.endpoint || "当前没有可用地址";
    if (link.url) {
      addressValue.href = link.url;
      addressValue.target = "_blank";
      addressValue.rel = "noopener noreferrer";
      addressValue.title = "在浏览器新标签页打开";
    }
    address.append(addressLabel, addressValue);
    main.append(header, meta, address);
    if (link.hint) {
      const hint = document.createElement("p");
      hint.className = "link-hint";
      hint.textContent = link.hint;
      main.appendChild(hint);
    }
    const status = document.createElement("div");
    status.className = "status-label";
    status.innerHTML = `<span class="status-dot"></span><span>${link.enabled ? "已启用" : "未启用"}</span>`;
    main.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "link-card-actions";
    actions.appendChild(createIconButton("icon-copy", "复制地址", () => copyText(link.url || link.endpoint, "地址已复制。"), !(link.url || link.endpoint)));
    actions.appendChild(createIconButton("icon-external-link", "在新标签页打开", () => window.open(link.url, "_blank", "noopener,noreferrer"), !link.enabled || !link.canOpen));
    card.append(main, actions);
    return card;
  }

  function renderLinks() {
    const links = visibleLinks();
    renderStats(state.links);
    elements.linkList.replaceChildren();
    elements.emptyState.hidden = links.length > 0;
    if (!links.length) return;
    const groups = new Map();
    for (const link of links) {
      const group = link.group || "未分组";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(link);
    }
    for (const [group, items] of groups) {
      const section = document.createElement("section");
      section.className = "link-group";
      const heading = document.createElement("div");
      heading.className = "link-group-heading";
      const title = document.createElement("h3");
      title.textContent = group;
      const count = document.createElement("span");
      count.textContent = `${items.length} 条`;
      const toggle = document.createElement("button");
      const collapsed = state.collapsedGroups.has(group);
      toggle.className = "group-toggle icon-button";
      toggle.type = "button";
      toggle.title = collapsed ? "展开分类" : "折叠分类";
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.innerHTML = `<span class="${collapsed ? "icon-chevron-down" : "icon-chevron-up"}" aria-hidden="true"></span>`;
      toggle.addEventListener("click", () => toggleGroup(group));
      heading.append(title, toggle, count);
      const grid = document.createElement("div");
      grid.className = "link-group-grid";
      grid.hidden = collapsed;
      for (const item of items) grid.appendChild(createLinkCard(item));
      section.append(heading, grid);
      elements.linkList.appendChild(section);
    }
  }

  async function loadLinks() {
    elements.refreshLinks.disabled = true;
    elements.connectionStatus.innerHTML = "<span class=\"status-dot\"></span>正在刷新已同步的隧道";
    try {
      state.links = await request("/access/api/links");
      renderLinks();
      elements.connectionStatus.innerHTML = "<span class=\"status-dot\"></span>已连接，列表会自动更新";
    } catch (error) {
      elements.connectionStatus.textContent = `读取失败：${error.message}`;
      showToast(`刷新失败：${error.message}`);
    } finally {
      elements.refreshLinks.disabled = false;
    }
  }

  function openEventStream() {
    if (!window.EventSource) return;
    if (state.source) state.source.close();
    state.source = new EventSource("/access/api/events");
    state.source.addEventListener("links", (event) => {
      try { state.links = JSON.parse(event.data); renderLinks(); } catch { /* Ignore a malformed update and retain the current list. */ }
    });
    state.source.addEventListener("error", () => {});
  }

  elements.linkSearch.addEventListener("input", renderLinks);
  elements.refreshLinks.addEventListener("click", loadLinks);
  elements.copyCenterUrl.addEventListener("click", () => copyText(state.centerUrl, "访问中心地址已复制。"));
  elements.openSpeedTest.addEventListener("click", openSpeedTest);
  elements.closeSpeedTest.addEventListener("click", closeSpeedTest);
  elements.cancelSpeedTest.addEventListener("click", closeSpeedTest);
  elements.stopSpeedTest.addEventListener("click", stopSpeedTest);
  elements.startSpeedTest.addEventListener("click", runSpeedTest);
  elements.speedTestDialog.addEventListener("click", (event) => {
    if (event.target === elements.speedTestDialog && !state.speedController) closeSpeedTest();
  });
  loadLinks();
  openEventStream();
})();
