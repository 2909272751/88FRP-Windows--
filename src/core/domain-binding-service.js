"use strict";

/**
 * 域名绑定服务
 *
 * 把当前实例里已启用的隧道，映射成 Cloudflare 上的一条 A 记录，
 * 指向 88FRP 节点 IP。节点 IP 变了就自动更新，所以对外地址始终可用。
 *
 * 设计要点：
 *
 * 1. **一条记录而不是多条**。所有服务共用 `<域名>:<端口>` 的形式，
 *    靠端口区分。既然每条链接都要带端口，按服务分子域名没有意义，
 *    反而会让 DNS 记录数随隧道数增长。
 *
 * 2. **本机角色开关（canWrite）**。多台设备各自跑 88FRP、各自连不同节点时，
 *    如果都去写 DNS 会互相覆盖。所以把「谁来写」交给用户指定，
 *    而不是靠竞争或自动选主 —— 出问题时行为可预期，你知道该看哪台。
 *
 * 3. **删除有严格前提**。只删「备注精确等于本工具标记」且「id 在本地账本里」
 *    的记录。用户手工建的记录永远不碰。第一次运行时账本为空，不删任何东西。
 */

const fs = require("node:fs");
const path = require("node:path");
const { isIP } = require("node:net");
const { resolve4 } = require("node:dns/promises");
const { WindowsCredentialStore } = require("./windows-credential-store");

const MANAGED_COMMENT = "由 88FRP 域名绑定自动创建，请勿手工删除";
const CF_API = "https://api.cloudflare.com/client/v4";

/** 界面开关和配置存在实例目录下的 domain-binding.json */
const FILE_NAME = "domain-binding.json";

const DEFAULT_CONFIG = {
  enabled: false,
  zone: "",
  // 加密后的 Cloudflare API Token（DPAPI）。空表示未授权。
  encryptedToken: "",
  canWrite: false,
  autoFollow: true,
  ttl: 60,
  // 记录指向的「根」域名。@ 表示域名本身。
  hostname: "@",
  // 只发布这些隧道；留空表示「当前启用的全部」
  onlyTunnels: [],
  skipTunnels: [],
  // 上次同步结果（账本）
  lastSyncAt: "",
  lastSummary: null,
  recordIds: [],
};

class DomainBindingService {
  constructor({ store, instanceService, tunnelService, credentialStore = new WindowsCredentialStore(), logger, fetchImpl = fetch, resolveIPv4 = resolve4 }) {
    this.store = store;
    this.instanceService = instanceService;
    this.tunnelService = tunnelService;
    this.credentialStore = credentialStore;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.resolveIPv4 = resolveIPv4;
    this.inflight = new Map();
    this.automatic = new Map();
  }

  /* ------------------------------------------------------------ 配置文件 */

  /**
   * 开关和配置存在实例目录下。
   * 用 store 自己的路径解析，不自己拼 —— 目录布局由 store 决定，
   * 单文件版和源码版的 runtime 根目录不一样。
   */
  configPath(instanceId) {
    return this.store.getConfigPath(instanceId).replace(/frpc\.toml$/, FILE_NAME);
  }

  read(instanceId) {
    const file = this.configPath(instanceId);
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || Array.isArray(raw) || typeof raw !== "object"
        || ["enabled", "canWrite", "autoFollow"].some(key => key in raw && typeof raw[key] !== "boolean")
        || ["recordIds", "recordLedger", "onlyTunnels", "skipTunnels"].some(key => key in raw && !Array.isArray(raw[key]))) throw new Error("Invalid configuration");
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("域名配置无法读取，已停止写入。请检查配置文件或从备份恢复。");
    }
    return { ...DEFAULT_CONFIG, ...raw };
  }

  write(instanceId, patch) {
    const file = this.configPath(instanceId);
    const next = { ...this.read(instanceId), ...patch };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
    return next;
  }

  configure(instanceId, patch) {
    const next = {};
    for (const key of ["enabled", "canWrite", "autoFollow"]) {
      if (!(key in patch)) continue;
      if (typeof patch[key] !== "boolean") throw new Error("开关必须为开启或关闭。");
      next[key] = patch[key];
    }
    if ("zone" in patch) next.zone = normalizeZone(patch.zone);
    if ("hostname" in patch) {
      next.hostname = String(patch.hostname).trim().toLowerCase();
      if (next.hostname !== "@" && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(next.hostname)) throw new Error("主机名格式不正确。");
    }
    if ("ttl" in patch) {
      next.ttl = Number(patch.ttl);
      if (!Number.isInteger(next.ttl) || next.ttl < 60 || next.ttl > 86400) throw new Error("TTL 应为 60–86400 秒。");
    }
    for (const key of ["onlyTunnels", "skipTunnels"]) {
      if (!(key in patch)) continue;
      if (!Array.isArray(patch[key]) || patch[key].some(x => typeof x !== "string")) throw new Error("隧道筛选必须是名称列表。");
      next[key] = patch[key];
    }
    const cfg = this.read(instanceId);
    if (next.zone && next.zone !== cfg.zone && cfg.recordIds.length && !cfg.recordZone) next.recordZone = cfg.zone;
    this.write(instanceId, next);
    this.automatic.delete(instanceId); // 设置修改后取消失败退避，下一轮按最新设置检查。
  }

  /**
   * 取实例的「节点地址 + 全部隧道」。
   *
   * 复用 tunnelService.list()，它已经处理了 selection（哪些启用）、
   * labels（显示名）、分组推导。自己再解析一遍 frpc.toml 只会发散。
   * 节点地址从 runtime-frpc.toml 读 —— 那是真正在跑的那份，
   * 换节点时它最先更新。
   *
   * 注意：这里**不过滤 enabled**。
   * 用户的要求是「所有隧道都发布」，包括面板里没启动的。
   * 未启用的隧道域名记录照样建，等哪天在面板里启用就能直接用，
   * 不用回来重新同步一次 DNS。代价是启用前访问会 502，
   * 界面上给这类链接标「未启用」，用户能一眼看出来。
   */
  async snapshot(instanceId) {
    const { tunnels } = await this.tunnelService.list(instanceId);
    const publishable = tunnels.filter((t) => Boolean(t.remotePort));

    let serverAddr = "";
    try {
      // runtime-frpc.toml 是真正在跑的那份，换节点时它最先更新。
      // store 只提供了路径方法，没有 read，所以直接读文件。
      const rtPath = this.store.getRuntimeConfigPath(instanceId);
      serverAddr = parseServerAddr(fs.readFileSync(rtPath, "utf8"));
    } catch {
      /* 没跑起来时读不到，下面回落到面板配置 */
    }
    if (!serverAddr) {
      serverAddr = parseServerAddr(await this.store.readConfig(instanceId));
    }

    return { tunnels, publishable, serverAddr };
  }

  /* -------------------------------------------------------------- Token */

  /**
   * token 用 DPAPI 加密后存盘，不落明文。
   * 绑定当前 Windows 用户，换用户或换机器都解不开。
   */
  async encrypt(plain) {
    return this.credentialStore.protect(plain);
  }

  async decrypt(value) {
    if (!value) return "";
    // Legacy domain tokens are raw DPAPI base64; account credentials use SecureString.
    try { return await this.credentialStore.unprotect(value, { rawDpapi: !value.startsWith("machine:") }); }
    catch { throw new Error("Cloudflare 凭据无法解密，请在原 Windows 用户下重新安装迁移，或重新授权 Token。"); }
  }

  /* --------------------------------------------------------- Cloudflare */

  async cf(token, method, apiPath, body) {
    let res;
    try {
      res = await this.fetchImpl(CF_API + apiPath, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(12000),
      });
    } catch (error) {
      throw new Error(error.name === "TimeoutError" || error.name === "AbortError"
        ? "连接 Cloudflare 超时，请检查网络；后台会自动重试。"
        : "无法连接 Cloudflare，请检查网络或代理；后台会自动重试。");
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.success !== true) {
      const hint = res.status === 401 || res.status === 403 ? "Token 已失效或缺少权限，请重新授权。"
        : res.status === 429 ? "请求过于频繁，后台将延后重试。" : "服务响应异常，请稍后重试。";
      throw new Error(`Cloudflare HTTP ${res.status}：${hint}`);
    }
    return json.result;
  }

  async records(token, zoneId) {
    const records = [];
    for (let page = 1; ; page++) {
      const batch = await this.cf(token, "GET", `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error("Cloudflare 解析列表格式不正确，已停止同步。");
      records.push(...batch);
      if (batch.length < 100) return records;
      if (page >= 1000) throw new Error("解析记录过多，已停止同步。");
    }
  }

  async zoneId(token, zone) {
    const r = await this.cf(token, "GET", `/zones?name=${encodeURIComponent(zone)}`);
    if (!r || !r.length) throw new Error(`Token 里看不到域名 ${zone}（Zone Resources 要包含它）`);
    return r[0].id;
  }

  /**
   * 逐项验证 token 权限，缺什么直接说清楚，而不是笼统报「失败」。
   * 这样用户知道该去改哪个权限，而不是反复试。
   */
  async verifyToken(token, zone) {
    const checks = [];
    const push = (name, ok, detail) => checks.push({ name, ok, detail });

    let zid = null;
    try {
      zid = await this.zoneId(token, zone);
      push("读取域名", true, `${zone} (${zid})`);
    } catch (e) {
      push("读取域名", false, e.message);
      return { ok: false, checks };
    }

    let records = [];
    try {
      records = await this.cf(token, "GET", `/zones/${zid}/dns_records?per_page=5`);
      push("读取解析", true, `当前 ${records.length >= 5 ? "5+" : records.length} 条记录`);
    } catch (e) {
      push("读取解析", false, `缺少 Zone/DNS/Read：${e.message}`);
      return { ok: false, checks };
    }

    push("修改解析", true, "授权验证只读取记录；写入权限会在本机允许写入后的实际同步中检查。");

    return { ok: true, checks, zoneId: zid };
  }

  /* --------------------------------------------------------------- 同步 */

  /** 算出「期望的 DNS 记录长什么样」 */
  async buildDesired(instanceId) {
    const cfg = this.read(instanceId);
    const snap = await this.snapshot(instanceId);
    const { publishable, serverAddr } = snap;

    const skip = new Set(cfg.skipTunnels || []);
    const only = new Set(cfg.onlyTunnels || []);

    // 发布全部隧道（含未启用的），只有用户显式 skip 的才排除
    const tunnels = publishable.filter((t) => {
      if (skip.has(t.name)) return false;
      if (only.size && !only.has(t.name)) return false;
      return true;
    });

    const fqdn = cfg.hostname === "@" ? cfg.zone : `${cfg.hostname}.${cfg.zone}`;
    let nodeIp = serverAddr;
    if (cfg.zone && tunnels.length && serverAddr && !isIP(serverAddr)) {
      let timeout;
      try {
        const addresses = await Promise.race([
          this.resolveIPv4(serverAddr),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("节点地址解析超时，请稍后重试。")), 10000); }),
        ]);
        nodeIp = addresses[0];
      } finally { clearTimeout(timeout); }
    }
    if (cfg.zone && tunnels.length && isIP(nodeIp) !== 4) throw new Error("无法取得节点 IPv4 地址，保留现有 DNS；请检查节点配置或网络。");
    const record = cfg.zone && tunnels.length && serverAddr
      ? {
        fqdn,
        type: "A",
        content: nodeIp,
        ttl: Number(cfg.ttl) || 60,
        proxied: false,
      }
      : null;

    // 每个服务的访问地址（端口是唯一区分手段）
    const links = tunnels.map((t) => ({
      id: t.name,
      name: t.displayName || t.name,
      localPort: t.localPort,
      remotePort: t.remotePort,
      // 未启用的隧道也发布域名，但要标出来 —— 用户在面板里没开它，
      // 访问会 502，不能让他以为是自己配置错了
      enabled: Boolean(t.enabled),
      url: cfg.zone ? `http://${fqdn}:${t.remotePort}` : "",
      kind: guessKind(t.localPort, t.displayName),
    }));

    return { cfg, record, links, tunnels, nodeAddr: serverAddr };
  }

  /** 当前状态（给界面渲染用，不联网） */
  async status(instanceId) {
    const cfg = this.read(instanceId);
    let desired = null;
    let error = null;
    try {
      desired = await this.buildDesired(instanceId);
    } catch (e) {
      error = e.message;
    }
    return {
      config: {
        enabled: cfg.enabled,
        zone: cfg.zone,
        canWrite: cfg.canWrite,
        autoFollow: cfg.autoFollow,
        ttl: cfg.ttl,
        hostname: cfg.hostname,
      },
      hasToken: Boolean(cfg.encryptedToken),
      lastSyncAt: cfg.lastSyncAt,
      lastSummary: cfg.lastSummary,
      lastCheckAt: cfg.lastCheckAt || "",
      lastError: cfg.lastError || "",
      autoStatus: !cfg.enabled ? "已停用" : !cfg.canWrite ? "本机只读，不修改解析"
        : !cfg.autoFollow ? "自动跟随已暂停，可手动同步" : !cfg.encryptedToken ? "等待 Cloudflare 授权"
        : cfg.lastError ? "同步失败，后台将自动重试" : "自动跟随中 · 每 60 秒检查",
      nextCheckAt: this.automatic.get(instanceId)?.nextAt || null,
      record: desired ? desired.record : null,
      links: desired ? desired.links : [],
      nodeAddr: desired ? desired.nodeAddr : "",
      error,
    };
  }

  blocked(cfg, automatic = false) {
    if (!cfg.canWrite) return { action: "readonly", reason: "本机已设为只读，不修改解析", total: 0 };
    if (!cfg.enabled) return { action: "disabled", reason: "域名绑定已停用，不修改解析", total: 0 };
    if (automatic && !cfg.autoFollow) return { action: "paused", reason: "自动跟随已暂停", total: 0 };
    return null;
  }

  fingerprint(cfg) {
    return require("node:crypto").createHash("sha256").update(JSON.stringify([cfg.zone, cfg.hostname, cfg.ttl, cfg.encryptedToken, cfg.onlyTunnels, cfg.skipTunnels])).digest("hex");
  }

  async plan(instanceId) {
    const stopped = this.blocked(this.read(instanceId));
    if (stopped) return stopped;
    const { cfg, record, links } = await this.buildDesired(instanceId);
    if (!cfg.zone) throw new Error("还没设置域名");
    const token = await this.decrypt(cfg.encryptedToken);
    if (!token) throw new Error("还没授权 Cloudflare Token");
    const zid = await this.zoneId(token, cfg.zone);
    const all = await this.records(token, zid);
    const ledger = [...(cfg.recordLedger || [])];
    if (cfg.recordIds.length) {
      const oldZone = cfg.recordZone || cfg.zone;
      const oldZid = oldZone === cfg.zone ? zid : await this.zoneId(token, oldZone);
      for (const id of cfg.recordIds) if (!ledger.some(x => x.id === id)) ledger.push({ id, zoneId: oldZid });
    }
    const relevant = record ? all.filter(r => r.name.toLowerCase() === record.fqdn.toLowerCase()
      && ["A", "AAAA", "CNAME"].includes(r.type)) : [];
    const ours = relevant.find(r => r.type === "A" && r.comment === MANAGED_COMMENT);
    const foreign = relevant.find(r => r.comment !== MANAGED_COMMENT || r.type !== "A");
    if (foreign) return { action: "conflict", reason: "该域名已有手工记录或其他类型解析，请在 Cloudflare 检查；本软件不会覆盖。", record, links, total: 0 };
    let action = !record ? "unchanged" : !ours ? "create" :
      ours.content !== record.content || Number(ours.ttl) !== record.ttl || ours.proxied !== false ? "update" : "unchanged";
    const stale = [];
    const zones = new Map([[zid, all]]);
    for (const item of ledger) {
      if (!zones.has(item.zoneId)) zones.set(item.zoneId, await this.records(token, item.zoneId));
      const found = zones.get(item.zoneId).find(r => r.id === item.id);
      if (found && found.comment === MANAGED_COMMENT && !(item.zoneId === zid && ours && found.id === ours.id)) stale.push(item);
    }
    if (action === "unchanged" && stale.length) action = "delete";
    const reason = action === "unchanged" ? "解析已正确" : action === "create" ? "新建解析"
      : action === "update" ? "节点地址或解析设置已变化" : "清理本机账本中的过期解析";
    return { action, reason, record, links, zoneId: zid, currentId: ours?.id || null,
      stale, ledger, fingerprint: this.fingerprint(cfg), total: (action === "create" || action === "update" ? 1 : 0) + stale.length };
  }

  sync(instanceId, options = {}) {
    if (options.dryRun) return this.plan(instanceId).then(p => ({ ...p, applied: false }));
    if (this.inflight.has(instanceId)) return this.inflight.get(instanceId);
    const run = this.performSync(instanceId, options).finally(() => this.inflight.delete(instanceId));
    this.inflight.set(instanceId, run);
    return run;
  }

  async performSync(instanceId, { dryRun = false, automatic = false, shouldContinue = () => true } = {}) {
    const stopped = this.blocked(this.read(instanceId), automatic);
    if (stopped) return { ...stopped, applied: false };
    try {
      const p = await this.plan(instanceId);
      if (dryRun || ["readonly", "disabled", "conflict"].includes(p.action)) return { ...p, applied: false };
      const assertWritable = () => {
        const latest = this.read(instanceId);
        const blocked = this.blocked(latest, automatic);
        if (blocked || !shouldContinue() || this.fingerprint(latest) !== p.fingerprint) {
          const error = new Error(blocked?.reason || "设置已变化，等待下一轮重新检查。");
          error.configurationChanged = true;
          throw error;
        }
      };
      assertWritable();
      const token = await this.decrypt(this.read(instanceId).encryptedToken);
      let ledger = [...p.ledger];
      const summary = { create: 0, update: 0, delete: 0 };
      if (p.action === "create" || p.action === "update") {
        const body = { type: p.record.type, name: p.record.fqdn, content: p.record.content,
          ttl: p.record.ttl, proxied: false, comment: MANAGED_COMMENT };
        assertWritable();
        const rec = await this.cf(token, p.action === "create" ? "POST" : "PATCH",
          `/zones/${p.zoneId}/dns_records${p.currentId ? `/${p.currentId}` : ""}`, body);
        if (!rec?.id) throw new Error("Cloudflare 未返回记录 ID，请重新检查解析。");
        if (!ledger.some(x => x.id === rec.id)) ledger.push({ id: rec.id, zoneId: p.zoneId });
        this.write(instanceId, { recordLedger: ledger, recordIds: [], recordZone: "" });
        summary[p.action]++;
      }
      for (const item of p.stale) {
        // 删除前再次确认备注。只对账本和精确标记双重命中的记录操作。
        const current = await this.cf(token, "GET", `/zones/${item.zoneId}/dns_records/${item.id}`);
        if (current.comment !== MANAGED_COMMENT) continue;
        assertWritable();
        await this.cf(token, "DELETE", `/zones/${item.zoneId}/dns_records/${item.id}`);
        ledger = ledger.filter(x => x.id !== item.id);
        this.write(instanceId, { recordLedger: ledger, recordIds: [], recordZone: "" });
        summary.delete++;
      }
      // Keep the current managed record in the ledger even when adopted unchanged.
      if (p.currentId && !ledger.some(x => x.id === p.currentId)) ledger.push({ id: p.currentId, zoneId: p.zoneId });
      this.write(instanceId, { lastSyncAt: new Date().toISOString(), lastCheckAt: new Date().toISOString(),
        lastError: "", lastSummary: summary, recordLedger: ledger, recordIds: [], recordZone: "" });
      return { ...p, applied: Object.values(summary).some(Boolean), summary };
    } catch (error) {
      if (error.configurationChanged) return { applied: false, action: "paused", reason: error.message };
      this.write(instanceId, { lastCheckAt: new Date().toISOString(), lastError: error.message });
      throw error;
    }
  }

  startAutoFollow({ intervalMs = 60000 } = {}) {
    let stopped = true, timer = null, running = null;
    const tick = () => {
      if (stopped) return Promise.resolve();
      if (running) return running;
      running = (async () => {
        for (const instance of await this.instanceService.list()) {
          if (stopped) break;
          try {
            const cfg = this.read(instance.id); // 每轮重读三个开关。
            if (this.blocked(cfg, true) || !cfg.encryptedToken || !cfg.zone) continue;
            const state = this.automatic.get(instance.id) || { failures: 0, nextAt: 0 };
            if (Date.now() < state.nextAt) continue;
            try {
              const result = await this.sync(instance.id, { automatic: true, shouldContinue: () => !stopped });
              if (result.action === "conflict") throw new Error(result.reason);
              this.automatic.set(instance.id, { failures: 0, nextAt: Date.now() + intervalMs });
            } catch (error) {
              const failures = state.failures + 1;
              this.automatic.set(instance.id, { failures, nextAt: Date.now() + Math.min(intervalMs * 2 ** Math.min(failures, 4), 900000) });
              this.write(instance.id, { lastCheckAt: new Date().toISOString(), lastError: error.message });
              await this.logger?.warn(`域名自动跟随失败 (${instance.id}): ${error.message}`);
            }
          } catch (error) { await this.logger?.warn(`域名配置检查失败 (${instance.id}): ${error.message}`); }
        }
      })().catch(async error => { await this.logger?.warn(`域名后台检查失败: ${error.message}`); }).finally(() => { running = null; });
      return running;
    };
    const schedule = () => {
      timer = setTimeout(async () => { await tick(); if (!stopped) schedule(); }, intervalMs);
      timer.unref?.();
    };
    return {
      start() { if (!stopped) return; stopped = false; void tick(); schedule(); },
      stop() { stopped = true; clearTimeout(timer); },
      tick,
    };
  }

  /** 生成纯文本链接清单，方便复制 */
  async linksText(instanceId) {
    const { cfg, links } = await this.buildDesired(instanceId);
    return [
      `88FRP 域名访问链接（${cfg.zone}）`,
      "",
      ...links.map((x) => {
        let note = "";
        if (x.enabled === false) note = "   [未启用，需在 88FRP 面板开启后才能访问]";
        else if (x.kind !== "web") note = `   [${x.kind}，需客户端打开]`;
        return `${x.name.padEnd(16)} ${x.url}${note}`;
      }),
      "",
      "说明：所有服务共用一条 A 记录，靠端口区分。",
      `      ${cfg.zone} 会自动跟随 88FRP 节点变化。`,
    ].join("\n");
  }
}

/** 从 frpc 配置文本里取 serverAddr */
function parseServerAddr(text) {
  const m = String(text || "").match(/^\s*serverAddr\s*=\s*["']([^"']+)["']/m);
  return m ? m[1] : "";
}

/** 猜服务类型，决定链接点开有没有意义（88FRP 全是 tcp，只能按端口/名字推断） */
function guessKind(localPort, name = "") {
  const n = String(name).toLowerCase();
  if (localPort === 3389 || /电脑|桌面|rdp|remote/.test(n)) return "远程桌面";
  if (localPort === 22 || /cmd|ssh|终端/.test(n)) return "SSH";
  if ([3306, 5432, 6379, 27017].includes(localPort)) return "数据库";
  return "web";
}

function normalizeZone(value) {
  const zone = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (zone.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(zone)) throw new Error("请输入正确的域名，不要包含协议或端口。");
  return zone;
}

module.exports = { DomainBindingService, DEFAULT_CONFIG, MANAGED_COMMENT };
