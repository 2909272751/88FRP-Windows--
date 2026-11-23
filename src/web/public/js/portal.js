(() => {
  "use strict";

  const SERVICE_META = {
    "xps": {
      title: "香港楼市终端",
      tag: "行情终端",
      description: "香港与广州楼市行情、租售比与买房判断",
      tone: "amber",
    },
    "xps-cd2": {
      title: "CloudDrive2",
      tag: "云盘",
      description: "挂载云盘与统一文件管理",
      tone: "sky",
    },
    "xps-codex": {
      title: "Codex",
      tag: "开发",
      description: "本机 Codex 工作区与任务入口",
      tone: "violet",
    },
    "xps-deepseek": {
      title: "DeepSeek Harness",
      tag: "AI",
      description: "DeepSeek 调试与运行面板",
      tone: "teal",
    },
  };

  const ICONS = {
    "xps": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 9h1M14 9h1M9 13h1M14 13h1M9 17h6"/></svg>',
    "xps-cd2": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.4 4.5 4.5 0 0 0 7 18Z"/><path d="M9 14h6"/></svg>',
    "xps-codex": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
    "xps-deepseek": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z"/><path d="m18.5 14 .9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z"/></svg>',
    "terminal": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
    "monitor": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    "default": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
    "arrow": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  };

  const connection = document.getElementById("connection");
  const connectionDetail = document.getElementById("connection-detail");
  const connectionDot = document.getElementById("connection-dot");
  const portalGrid = document.getElementById("portalGrid");
  const adminLink = document.getElementById("portalAdminLink");
  const portLabel = document.getElementById("portalPort");
  const remoteSection = document.getElementById("remoteAccess");
  const remoteGrid = document.getElementById("remoteGrid");
  const deviceName = document.getElementById("deviceName");
  const heroDevice = document.getElementById("heroDevice");
  const pageSubtitle = document.getElementById("pageSubtitle");
  const serviceCount = document.getElementById("serviceCount");
  const statServiceTotal = document.getElementById("statServiceTotal");
  const webRoutes = document.getElementById("webRoutes");

  let lastData = null;
  load();

  async function load() {
    showLoading();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch("/api/gateway/public", {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.success) {
        throw new Error(body?.message || `请求失败：HTTP ${response.status}`);
      }
      lastData = body.data || {};
      render(lastData);
    } catch (error) {
      showError(error?.name === "AbortError" ? "读取超时，请稍后重试。" : (error?.message || "无法读取服务入口。"));
    } finally {
      window.clearTimeout(timer);
    }
  }

  function showLoading() {
    portalGrid.setAttribute("aria-busy", "true");
    portalGrid.replaceChildren(...Array.from({ length: 4 }, createSkeleton));
    connection.textContent = "正在连接";
    connectionDetail.textContent = "正在读取当前地址…";
    connectionDetail.title = "";
    connectionDot.className = "live-dot";
    serviceCount.textContent = "正在读取";
    pageSubtitle.textContent = "正在读取这台设备的服务。";
    adminLink.hidden = true;
    remoteSection.hidden = true;
    remoteGrid.replaceChildren();
    webRoutes.hidden = true;
  }

  function createSkeleton() {
    const card = document.createElement("div");
    card.className = "card skeleton";
    card.setAttribute("aria-hidden", "true");
    const icon = document.createElement("div");
    icon.className = "icon";
    const body = document.createElement("div");
    body.className = "card-body";
    for (const className of ["tag", "title", "desc"]) {
      const line = document.createElement("span");
      line.className = `skeleton-line ${className}`;
      body.appendChild(line);
    }
    card.append(icon, body);
    return card;
  }

  function render(data) {
    const services = Array.isArray(data.services) ? data.services : [];
    const label = friendlyDeviceName(data.deviceName, data.domain);
    deviceName.textContent = label;
    heroDevice.textContent = label;
    portalGrid.replaceChildren();
    portalGrid.setAttribute("aria-busy", "false");

    if (services.length === 0) {
      portalGrid.appendChild(createEmptyState(
        "还没有可打开的服务",
        "在管理后台添加网页服务后，这里会自动出现入口。",
        true,
      ));
    } else {
      for (const service of services) {
        const card = createServiceCard(service);
        if (card) portalGrid.appendChild(card);
      }
    }

    serviceCount.textContent = `${services.length} 个入口`;
    if (statServiceTotal) statServiceTotal.textContent = `${services.length} 个`;
    pageSubtitle.textContent = services.length
      ? `${services.length} 个服务可直接访问。`
      : "这台设备还没有公开服务。";
    renderConnection(data.connection || {});
    renderWebRoutes(data.publicEndpoints);
    renderRemoteAccess(data.remoteAccess);
    if (portLabel && Number.isInteger(Number(data.gatewayPort)) && Number(data.gatewayPort) > 0) {
      portLabel.textContent = String(data.gatewayPort);
    }

    const adminUrl = safeUrl(data.adminUrl);
    adminLink.hidden = !adminUrl;
    if (adminUrl) adminLink.href = adminUrl;
  }

  function renderConnection(info) {
    const mode = String(info.mode || "unknown");
    const dots = {
      ipv6: "live-dot v6",
      ipv4: "live-dot v4",
      local: "live-dot local",
      unknown: "live-dot",
    };
    connection.textContent = mode === "unknown" ? "连接检测中" : "在线";
    connectionDetail.textContent = mode === "local"
      ? "本机访问，所有服务已就绪"
      : mode === "ipv6"
        ? "当前使用 IPv6 直连，速度更快"
        : mode === "ipv4"
          ? "当前使用 IPv4 备用线路"
          : "正在确认网络环境";
    connectionDetail.title = info.address || info.detail || "";
    connectionDot.className = dots[mode] || "live-dot";
  }

  function renderWebRoutes(endpoints) {
    const values = {
      auto: safeUrl(endpoints?.auto),
      ipv6: safeUrl(endpoints?.ipv6),
      ipv4: safeUrl(endpoints?.ipv4),
    };
    let visible = 0;
    for (const link of webRoutes.querySelectorAll(".web-route")) {
      const href = values[link.dataset.line] || "";
      link.hidden = !href;
      if (href) {
        link.href = href;
        link.title = href;
        visible += 1;
      }
    }
    webRoutes.hidden = visible < 2;
  }

  function renderRemoteAccess(remoteAccess) {
    const ssh = remoteAccess?.ssh;
    const cards = [];
    if (ssh?.enabled) {
      cards.push(createRemoteCard({
        title: "SSH",
        tag: `端口 ${ssh.port}`,
        icon: ICONS.terminal,
        description: "命令行登录这台电脑。把 <用户名> 换成这台电脑的 Windows 登录名。",
        domainCommand: ssh.domainCommand,
        targets: ssh.targets,
      }));
    }

    const rdp = remoteAccess?.rdp;
    if (rdp?.enabled) {
      const rdpCard = createRemoteCard({
        title: "远程桌面",
        tag: "三条线路",
        icon: ICONS.monitor,
        description: "优先使用自动双栈域名；需要强制走某条线路时，切换到 IPv6 或 IPv4 专用地址。登录使用 Microsoft 账户邮箱和账户密码，不能使用 PIN。",
        targets: rdp.targets,
        copyLabel: "复制地址",
      });
      if (rdpCard) cards.push(rdpCard);
    }

    if (!cards.length) {
      remoteSection.hidden = true;
      remoteGrid.replaceChildren();
      return;
    }
    remoteGrid.replaceChildren(...cards);
    remoteSection.hidden = false;
  }

  function createRemoteCard({ title, tag, icon, description, domainCommand, targets, copyLabel = "复制命令" }) {
    const card = document.createElement("article");
    card.className = "remote-card";

    const heading = document.createElement("div");
    heading.className = "remote-title";
    const iconNode = document.createElement("div");
    iconNode.className = "icon";
    iconNode.innerHTML = icon;
    const titleWrap = document.createElement("div");
    titleWrap.className = "remote-title-text";
    const name = document.createElement("h3");
    name.textContent = title;
    const badge = document.createElement("span");
    badge.className = "remote-tag";
    badge.textContent = tag;
    titleWrap.append(name, badge);
    heading.append(iconNode, titleWrap);
    card.appendChild(heading);

    const note = document.createElement("p");
    note.className = "remote-note";
    note.textContent = description;
    card.appendChild(note);

    const routes = [];
    if (domainCommand) {
      routes.push({
        key: "auto",
        family: "auto",
        tab: "自动选路",
        label: "推荐 · 自动选择线路",
        meta: "域名会按当前网络自动选择 IPv6 或 IPv4",
        command: domainCommand,
      });
    }
    for (const target of Array.isArray(targets) ? targets : []) {
      routes.push({
        key: target.family,
        family: target.family,
        tab: target.family === "ipv6" ? "IPv6 专用" : target.family === "ipv4" ? "IPv4 专用" : target.family === "auto" ? "自动双栈" : String(target.label || "线路"),
        label: target.label || "连接方式",
        meta: target.family === "ipv6"
          ? "只解析到设备公网 IPv6"
          : target.family === "ipv4"
            ? "只解析到 88FRP 节点 IPv4"
            : target.family === "auto"
              ? "按当前网络自动选择线路"
              : "",
        command: target.command || target.endpoint,
        copyLabel,
      });
    }

    if (routes.length) {
      const tabs = document.createElement("div");
      tabs.className = "endpoint-tabs";
      tabs.setAttribute("role", "tablist");
      const panel = document.createElement("div");
      panel.className = "endpoint-panel";
      let active = 0;

      const showRoute = (index) => {
        active = index;
        tabs.querySelectorAll(".endpoint-tab").forEach((button, buttonIndex) => {
          button.classList.toggle("is-active", buttonIndex === index);
          button.setAttribute("aria-selected", buttonIndex === index ? "true" : "false");
        });
        panel.replaceChildren(createEndpoint(routes[index], routes[index].copyLabel));
      };

      routes.forEach((route, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "endpoint-tab";
        button.dataset.family = route.family;
        button.setAttribute("role", "tab");
        button.textContent = route.tab;
        button.addEventListener("click", () => showRoute(index));
        tabs.appendChild(button);
      });
      card.append(tabs, panel);
      showRoute(active);
    }

    return card;
  }

  function createEndpoint(route, copyLabel = "复制命令") {
    const endpoint = document.createElement("div");
    endpoint.className = "endpoint";
    if (route.family === "ipv6" || route.family === "ipv4") endpoint.dataset.family = route.family;

    const head = document.createElement("div");
    head.className = "endpoint-head";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy";
    copy.textContent = copyLabel;
    copy.addEventListener("click", () => copyText(route.command, copy));
    const labels = document.createElement("div");
    const labelNode = document.createElement("div");
    labelNode.className = "endpoint-label";
    labelNode.textContent = route.label;
    labels.appendChild(labelNode);
    if (route.meta) {
      const metaNode = document.createElement("div");
      metaNode.className = "endpoint-meta";
      metaNode.textContent = route.meta;
      labels.appendChild(metaNode);
    }
    head.append(labels, copy);
    endpoint.appendChild(head);

    const code = document.createElement("code");
    code.textContent = route.command;
    endpoint.appendChild(code);
    return endpoint;
  }

  function createDirectRdpCard(targets) {
    const list = (Array.isArray(targets) ? targets : []).filter((target) => target.endpoint);
    if (!list.length) return null;
    const hasDomain = list.some((target) => target.family !== "ipv6");
    const hasIpv6 = list.some((target) => target.family === "ipv6");
    const card = document.createElement("article");
    card.className = "remote-card";

    const heading = document.createElement("div");
    heading.className = "remote-title";
    const iconNode = document.createElement("div");
    iconNode.className = "icon";
    iconNode.innerHTML = ICONS.monitor;
    const titleWrap = document.createElement("div");
    titleWrap.className = "remote-title-text";
    const name = document.createElement("h3");
    name.textContent = "远程桌面";
    const badge = document.createElement("span");
    badge.className = "remote-tag";
    badge.textContent = hasDomain && hasIpv6 ? "域名 + IPv6" : hasDomain ? "域名反代" : "IPv6 直连";
    titleWrap.append(name, badge);
    heading.append(iconNode, titleWrap);
    card.appendChild(heading);

    const note = document.createElement("p");
    note.className = "remote-note";
    note.textContent = "优先使用域名端口，任何网络都能连接；有 IPv6 时也可以直连。登录使用这台电脑的 Microsoft 账户邮箱和账户密码，不能使用 PIN。";
    card.appendChild(note);

    for (const target of list) {
      const endpoint = document.createElement("div");
      endpoint.className = "endpoint";
      endpoint.dataset.family = target.family === "ipv6" ? "ipv6" : "ipv4";
      const head = document.createElement("div");
      head.className = "endpoint-head";
      const labels = document.createElement("div");
      const label = document.createElement("div");
      label.className = "endpoint-label";
      label.textContent = target.family === "ipv6" ? "IPv6 直连" : "域名 · 88FRP 反代";
      const meta = document.createElement("div");
      meta.className = "endpoint-meta";
      meta.textContent = target.family === "ipv6" ? "电脑和手机都需要支持 IPv6 网络" : "IPv4 / IPv6 网络都可用";
      labels.append(label, meta);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "copy";
      copy.textContent = "复制地址";
      copy.addEventListener("click", () => copyText(target.endpoint, copy));
      head.append(labels, copy);
      const code = document.createElement("code");
      code.textContent = target.endpoint;
      endpoint.append(head, code);
      card.appendChild(endpoint);
    }

    const account = document.createElement("div");
    account.className = "rdp-account-note";
    account.textContent = "登录名不是本地用户名；Windows 登录界面显示的是 Microsoft 账户邮箱。";
    card.appendChild(account);
    return card;
  }

  async function copyText(value, button) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    const previous = button.textContent;
    button.textContent = "已复制";
    button.classList.add("copied");
    window.setTimeout(() => {
      button.textContent = previous;
      button.classList.remove("copied");
    }, 1400);
  }

  function createServiceCard(service) {
    const href = safeUrl(service?.url);
    if (!href) return null;

    const meta = SERVICE_META[service.name] || {};
    const title = meta.title || cleanTitle(service.title) || service.name || "网页服务";
    const tag = meta.tag || normalizeTag(service.tag);
    const description = meta.description || cleanDescription(service.description);

    const card = document.createElement("a");
    card.className = "card";
    card.href = href;
    card.setAttribute("aria-label", `${title}，${tag}`);

    const icon = document.createElement("div");
    icon.className = `icon tone-${meta.tone || "blue"}`;
    icon.innerHTML = ICONS[service.name] || ICONS.default;

    const body = document.createElement("div");
    body.className = "card-body";
    const top = document.createElement("div");
    top.className = "card-top";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const tagNode = document.createElement("span");
    tagNode.className = "tag";
    tagNode.textContent = tag;
    top.append(heading, tagNode);
    body.appendChild(top);
    if (description) {
      const paragraph = document.createElement("p");
      paragraph.textContent = description;
      body.appendChild(paragraph);
    }

    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.innerHTML = ICONS.arrow;
    card.append(icon, body, arrow);
    return card;
  }

  function createEmptyState(title, description, retry = false) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = description;
    empty.append(heading, paragraph);
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "重新加载";
      button.addEventListener("click", load);
      empty.appendChild(button);
    }
    return empty;
  }

  function showError(message) {
    portalGrid.setAttribute("aria-busy", "false");
    portalGrid.replaceChildren(createEmptyState("暂时无法打开设备入口", message, true));
    connection.textContent = "连接失败";
    connectionDetail.textContent = "请稍后重新加载";
    connectionDetail.title = "";
    connectionDot.className = "live-dot";
    serviceCount.textContent = "0 个入口";
    pageSubtitle.textContent = "没有读取到这台设备的服务。";
    adminLink.hidden = true;
    remoteSection.hidden = true;
    remoteGrid.replaceChildren();
    webRoutes.hidden = true;
    if (lastData) {
      deviceName.textContent = friendlyDeviceName(lastData.deviceName, lastData.domain);
      heroDevice.textContent = deviceName.textContent;
    }
  }

  function friendlyDeviceName(name, domain) {
    const raw = String(name || "").trim();
    if (raw && !/^\d+$/.test(raw)) return raw;
    const prefix = String(domain || "").split(".")[0] || "";
    if (!prefix) return "我的设备";
    if (/^[a-z0-9-]+$/i.test(prefix)) {
      const pretty = prefix.length <= 4
        ? prefix.toUpperCase()
        : prefix.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
      return `${pretty} 主机`;
    }
    return prefix;
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ""), window.location.origin);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function cleanTitle(value) {
    return String(value || "").trim();
  }

  function normalizeTag(value) {
    const tag = String(value || "").trim();
    return !tag || tag === "旧服务" || tag === "网页服务" ? "服务" : tag;
  }

  function cleanDescription(value) {
    const description = String(value || "").trim();
    if (!description || description.startsWith("从旧版隧道导入")) return "已通过统一入口发布";
    return description;
  }
})();
