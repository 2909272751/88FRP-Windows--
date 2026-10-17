"use strict";

/**
 * 域名绑定面板。
 *
 * 挂到 88FRP 控制台的「域名绑定」tab 下。整体风格跟 app.js 一致：
 * 用 API 客户端、withBusy/toast 之类的工具由外部注入，避免重复造轮子。
 *
 * 设计取舍：
 * - 只在切到这个 tab 时才拉数据，不打扰主流程
 * - 三个开关（总开关 / 本机是否可写 / 单条服务）都是即时生效，不用点保存
 * - 删除永远不会静默发生：链接列表只读，不提供删除按钮
 */
(function () {
  const state = {
    instanceId: "",
    status: null,
    loaded: false,
    loading: null,
    authAutoToggled: false,
    bound: false,
  };

  const $ = (id) => document.getElementById(id);

  function toast(message, isError = false) {
    if (typeof window.toast === "function") {
      window.toast(message, isError);
      return;
    }
    // 外部没注入时的兜底，至少让用户看到反馈
    console.log(isError ? `[错误] ${message}` : message);
  }

  const esc = (s) => String(s == null ? "" : s)
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function setMsg(text, isError) {
    const el = $("domainAuthMsg");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = isError ? "var(--danger, #d93025)" : "";
  }

  /* ------------------------------------------------------------ 渲染 */

  function renderRoleChip() {
    const chip = $("domainRoleChip");
    const text = $("domainRoleText");
    if (!chip || !text) return;

    const s = state.status;
    const cfg = (s && s.config) || {};
    if (!s || !cfg.zone) {
      text.textContent = "未配置";
      chip.classList.remove("is-active");
      return;
    }
    if (!cfg.enabled) { text.textContent = "已停用"; chip.classList.remove("is-active"); return; }
    text.textContent = cfg.canWrite ? "本机写入" : "只读";
    chip.classList.toggle("is-active", Boolean(cfg.canWrite));
  }

  function renderRecord() {
    const s = state.status;
    const text = $("domainRecordText");
    const sub = $("domainRecordSub");
    if (!text || !sub) return;

    // 还没拉到数据时要说「加载中」，不能说「没有」。
    // 首次渲染总是先于 load() 完成，把它当成「没有可发布的隧道」
    // 会让人以为配置坏了 —— 这是实打实的误导。
    if (!s) {
      text.textContent = state.loaded ? "—" : "加载中…";
      sub.textContent = "";
      return;
    }

    if ($("domainAutoStatus")) {
      $("domainAutoStatus").textContent = `${s.autoStatus || ""}${s.lastError ? " · " + s.lastError : ""}`;
      $("domainAutoStatus").classList.toggle("is-bad", Boolean(s.lastError));
    }
    if (s.error) { text.textContent = "读取失败"; sub.textContent = s.error; return; }
    if (!s.record) {
      text.textContent = "没有可发布的隧道";
      sub.textContent = s.nodeAddr
        ? "同步配置后会显示全部隧道（含未启用）"
        : "实例未运行，读不到节点地址";
      return;
    }

    text.textContent = `${s.record.fqdn} → ${s.record.content}`;
    const when = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString("zh-CN") : "还没同步过";
    const links = (s.links || []).length;
    sub.textContent = `${links} 个服务 · TTL ${s.record.ttl}s · 上次同步 ${when}`;
  }

  function renderAuthSummary() {
    const el = $("domainAuthSummary");
    if (!el || !state.status) return;
    el.textContent = state.status.hasToken
      ? `已授权 · ${state.status.config.zone || "未设置域名"}`
      : "需要一次授权才能自动管理解析";
  }

  function renderChecks(checks) {
    const el = $("domainChecks");
    if (!el) return;
    if (!checks || !checks.length) { el.innerHTML = ""; return; }
    el.innerHTML = checks.map((c) => `
      <li class="${c.ok ? "is-ok" : "is-bad"}">
        <i class="icon-${c.ok ? "check" : "x"}" aria-hidden="true"></i>
        <span><strong>${esc(c.name)}</strong> ${esc(c.detail || "")}</span>
      </li>`).join("");
  }

  function renderLinks() {
    const list = $("domainLinksList");
    const sub = $("domainLinksSub");
    if (!list) return;

    const s = state.status;
    const links = (s && s.links) || [];
    if (sub && s && s.record) sub.textContent = `所有服务共用 ${s.record.fqdn}，靠端口区分`;

    if (!s) {
      // 别在加载完成前说「还没有」——那是误导
      list.innerHTML = '<p class="domain-empty">加载中…</p>';
      return;
    }

    if (!links.length) {
      list.innerHTML = '<p class="domain-empty">还没有可发布的地址。请先同步隧道配置。</p>';
      return;
    }

    list.innerHTML = links.map((x) => {
      const web = x.kind === "web";
      // 未启用的隧道也发布了域名（用户要求全发），但访问会 502，
      // 所以要标出来，否则用户会以为域名绑定坏了
      const dormant = x.enabled === false;
      const action = dormant
        ? '<span class="domain-kind domain-kind-off">未启用</span>'
        : (web
          ? `<a class="text-button" href="${esc(x.url)}" target="_blank" rel="noopener">打开</a>`
          : `<span class="domain-kind">${esc(x.kind)}</span>`);
      return `
        <div class="domain-link-row${dormant ? " is-dormant" : ""}">
          <div class="domain-link-main">
            <strong>${esc(x.name)}</strong>
            <span class="domain-link-meta">本地 ${x.localPort} → 端口 ${x.remotePort}</span>
          </div>
          <div class="domain-link-url"><code>${esc(x.url)}</code></div>
          <div class="domain-link-actions">
            ${action}
            <button class="icon-button" type="button" data-copy="${esc(x.url)}" title="复制" aria-label="复制">
              <i class="icon-copy" aria-hidden="true"></i>
            </button>
          </div>
        </div>`;
    }).join("");

    list.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.getAttribute("data-copy");
        navigator.clipboard.writeText(v).then(
          () => toast("已复制"),
          () => toast("复制失败，请手动选中", true),
        );
      });
    });
  }

  function renderAll() {
    const s = state.status;
    const cfg = (s && s.config) || {};

    if ($("domainEnabled")) $("domainEnabled").checked = cfg.enabled === true;
    if ($("domainCanWrite")) $("domainCanWrite").checked = cfg.canWrite === true;
    if ($("domainZone") && document.activeElement !== $("domainZone")) {
      $("domainZone").value = cfg.zone || "";
    }

    if ($("domainAutoFollow")) $("domainAutoFollow").checked = cfg.autoFollow !== false;
    // 没授权时自动展开授权卡片（引导用户去授权）；
    // 已授权则收起，避免每次都把 Token 输入框摊在眼前。
    // 只在「状态首次到达」时决定一次，不覆盖用户的展开/收起操作。
    const card = $("domainAuthCard");
    if (card && s && !state.authAutoToggled) {
      let saved = null;
      try { saved = window.localStorage.getItem(`88frp.domain.authExpanded.${state.instanceId}`); } catch { }
      const expanded = saved === null ? !s.hasToken : saved === "true";
      card.classList.toggle("is-expanded", expanded);
      $("btnToggleDomainAuth").setAttribute("aria-expanded", String(expanded));
      state.authAutoToggled = true;
    }

    renderRoleChip();
    renderAuthSummary();
    renderRecord();
    renderLinks();
  }

  /* ------------------------------------------------------------ 加载 */

  async function load() {
    if (!state.instanceId) return;
    // 并发去重：切 tab 和切实例可能几乎同时触发，重复请求没意义
    const instanceId = state.instanceId;
    if (state.loading && state.loadingId === instanceId) return state.loading;
    state.loadingId = instanceId;
    state.loading = (async () => {
      try {
        // 注意：API.request 返回的是 { success, message, data } 信封，
        // 真正的内容在 .data 里。直接收信封会让 s.config 永远是 undefined，
        // 面板一直停在空状态 —— 而且不报错，很难查。
        const res = await window.API.getDomainBinding(instanceId);
        if (state.instanceId !== instanceId) return;
        state.status = res && res.data ? res.data : res;
        state.loaded = true;
        renderAll();
      } catch (e) {
        toast(e.message, true);
      } finally {
        if (state.loadingId === instanceId) state.loading = null;
      }
    })();
    return state.loading;
  }

  async function save(patch, successMessage) {
    try {
      await window.API.saveDomainBinding(state.instanceId, patch);
      await load();
      if (successMessage) toast(successMessage);
    } catch (e) {
      toast(e.message, true);
      await load();
    }
  }

  /* ------------------------------------------------------------ 事件 */

  function bind() {
    if (state.bound) return;
    state.bound = true;
    setInterval(() => {
      if (state.instanceId && $("domainView").classList.contains("active") && !document.hidden) void load();
    }, 5000);
    const authToggle = $("btnToggleDomainAuth");
    if (authToggle) {
      authToggle.addEventListener("click", () => {
        // 沿用 .sync-card 现成的展开约定（is-expanded），
        // 不自造一套，否则 CSS 里两条规则会互相打架。
        const card = $("domainAuthCard");
        const open = card.classList.toggle("is-expanded");
        authToggle.setAttribute("aria-expanded", String(open));
        try { window.localStorage.setItem(`88frp.domain.authExpanded.${state.instanceId}`, String(open)); } catch { }
      });
    }

    const saveToken = $("btnSaveDomainToken");
    if (saveToken) {
      saveToken.addEventListener("click", async () => {
        const token = ($("domainToken").value || "").trim();
        const zone = ($("domainZone").value || "").trim();
        if (!token || !zone) { setMsg("域名和 Token 都要填", true); return; }

        saveToken.disabled = true;
        setMsg("验证中…", false);
        renderChecks([]);
        try {
          const r = await window.API.saveDomainToken(state.instanceId, token, zone);
          renderChecks(r.data.verify && r.data.verify.checks);
          if (!r.data.saved) {
            setMsg("验证未通过，看下面的明细", true);
          } else {
            setMsg("授权已保存", false);
            $("domainToken").value = "";
            state.status = r.data.status;
            renderAll();
            toast("授权已保存");
          }
        } catch (e) {
          setMsg(e.message, true);
        }
        saveToken.disabled = false;
      });
    }

    if ($("domainEnabled")) {
      $("domainEnabled").addEventListener("change", (e) => {
        save({ enabled: e.target.checked }, e.target.checked ? "已启用" : "已停用（不改动已有解析）");
      });
    }

    if ($("domainAutoFollow")) {
      $("domainAutoFollow").addEventListener("change", e => save({ autoFollow: e.target.checked }, e.target.checked ? "自动跟随已开启" : "自动跟随已暂停"));
    }
    if ($("domainCanWrite")) {
      $("domainCanWrite").addEventListener("change", (e) => {
        save({ canWrite: e.target.checked },
          e.target.checked ? "本机将修改解析" : "本机已设为只读");
      });
    }

    if ($("btnDomainPlan")) {
      $("btnDomainPlan").addEventListener("click", async () => {
        const box = $("domainPlanResult");
        box.textContent = "检查中…";
        try {
          const r = await window.API.getDomainPlan(state.instanceId);
          const p = r.data;
          const action = { create: "新建", update: "更新", delete: "清理" }[p.action];
          box.textContent = action ? `${action}：${p.reason}（${p.total} 项）` : p.reason;
          box.classList.toggle("is-bad", p.action === "conflict");
        } catch (e) {
          box.textContent = e.message;
          box.classList.add("is-bad");
        }
      });
    }

    if ($("btnDomainSync")) {
      $("btnDomainSync").addEventListener("click", async () => {
        const btn = $("btnDomainSync");
        btn.disabled = true;
        try {
          const r = await window.API.syncDomain(state.instanceId, false);
          const d = r.data;
          $("domainPlanResult").textContent = d.applied
            ? `同步完成：新增 ${d.summary.create} · 更新 ${d.summary.update} · 清理 ${d.summary.delete}`
            : (d.reason || "无需变更");
          await load();
          toast(r.message || "完成");
        } catch (e) {
          toast(e.message, true);
          $("domainPlanResult").textContent = e.message;
        }
        btn.disabled = false;
      });
    }

    if ($("btnCopyDomainLinks")) {
      $("btnCopyDomainLinks").addEventListener("click", async () => {
        try {
          const r = await window.API.getDomainLinks(state.instanceId);
          await navigator.clipboard.writeText(r.data.text);
          toast("已复制链接清单");
        } catch (e) {
          toast(e.message || "复制失败", true);
        }
      });
    }
  }

  /**
   * 由 app.js 在切换实例或切到本 tab 时调用。
   * 同一个实例重复调用不会重复拉取，除非 force。
   */
  window.DomainBinding = {
    async activate(instanceId, { force = false } = {}) {
      const changed = state.instanceId !== instanceId;
      state.instanceId = instanceId;
      if (changed) {
        state.loaded = false;
        state.status = null;
        state.authAutoToggled = false;   // 换实例后重新按授权状态决定展开
        if ($("domainPlanResult")) $("domainPlanResult").textContent = "";
        renderAll();
      }
      if (changed || force || !state.loaded) await load();
      else renderAll();
    },
    refresh() { return load(); },
    bind,
  };
})();
