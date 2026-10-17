const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DomainBindingService, MANAGED_COMMENT } = require("../src/core/domain-binding-service");

function setup(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domain-binding-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "runtime-frpc.toml"), 'serverAddr = "192.0.2.10"');
  const tunnels = [{ name: "web", remotePort: 8080, localPort: 80, enabled: true },
    { name: "ssh", remotePort: 2222, localPort: 22, enabled: false }];
  const records = [];
  const requests = [];
  const service = new DomainBindingService({
    store: { getConfigPath: () => path.join(dir, "frpc.toml"), getRuntimeConfigPath: () => path.join(dir, "runtime-frpc.toml"), readConfig: async () => '' },
    instanceService: { list: async () => [{ id: "one" }] },
    tunnelService: { list: async () => ({ tunnels }) },
    credentialStore: { protect: async x => `protected:${x}`, unprotect: async x => x },
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname.replace('/client/v4', '');
      requests.push({ method: options.method, route });
      let result;
      if (route === '/zones') result = [{ id: "zone" }];
      else if (options.method === "GET" && /dns_records$/.test(route)) {
        const page = Number(new URL(url).searchParams.get("page") || 1);
        result = records.slice((page - 1) * 100, page * 100);
      } else if (options.method === "GET") result = records.find(x => route.endsWith('/' + x.id));
      else if (options.method === "DELETE") { const i = records.findIndex(x => route.endsWith('/' + x.id)); result = records.splice(i, 1)[0]; }
      else {
        const body = JSON.parse(options.body);
        result = { id: "new", name: body.name, ...body };
        if (options.method === "PATCH") Object.assign(records.find(x => route.endsWith('/' + x.id)), result);
        else records.push(result);
      }
      return { ok: true, status: 200, json: async () => ({ success: true, result }) };
    },
  });
  service.write("one", { enabled: true, canWrite: true, autoFollow: true, encryptedToken: "secret", zone: "example.com", ...config });
  return { service, records, requests, tunnels, dir, writes: () => requests.filter(x => x.method !== "GET") };
}

test("只读、停用和试运行不会发送任何 DNS 写请求；只读不访问 Cloudflare", async t => {
  const s = setup(t, { canWrite: false });
  assert.equal((await s.service.plan("one")).action, "readonly");
  assert.equal((await s.service.sync("one")).applied, false);
  assert.equal(s.requests.length, 0);
  s.service.write("one", { canWrite: true, enabled: false });
  assert.equal((await s.service.sync("one")).action, "disabled");
  s.service.write("one", { enabled: true });
  assert.equal((await s.service.sync("one", { dryRun: true })).action, "create");
  assert.equal(s.writes().length, 0);
});

test("所有服务包含未启用隧道，共用一条灰云记录；重复同步无需写入", async t => {
  const s = setup(t);
  const result = await s.service.sync("one");
  assert.equal(result.links.length, 2);
  assert.equal(result.links[1].enabled, false);
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].proxied, false);
  assert.equal((await s.service.sync("one")).applied, false);
  assert.equal(s.writes().length, 1);
  fs.writeFileSync(path.join(s.dir, "runtime-frpc.toml"), 'serverAddr = "192.0.2.11"');
  assert.equal((await s.service.sync("one")).summary.update, 1);
  assert.equal(s.records[0].content, "192.0.2.11");
});

test("手工 A 和 CNAME 均阻止写入，TXT 可与托管 A 共存", async t => {
  const s = setup(t);
  s.records.push({ id: "manual", name: "example.com", type: "CNAME", content: "other.example.com" });
  assert.equal((await s.service.sync("one")).action, "conflict");
  assert.equal(s.writes().length, 0);
  s.records[0].type = "TXT";
  await s.service.sync("one");
  assert.equal(s.records[0].content, "other.example.com");
});

test("删除必须同时匹配账本和精确备注，全部隧道删除后才清理共享记录", async t => {
  const s = setup(t, { recordIds: ["old", "manual"] });
  s.records.push(
    { id: "old", name: "old.example.com", type: "A", comment: MANAGED_COMMENT },
    { id: "manual", name: "manual.example.com", type: "A", comment: "user" },
    { id: "untracked", name: "untracked.example.com", type: "A", comment: MANAGED_COMMENT });
  assert.equal((await s.service.sync("one")).summary.delete, 1);
  s.tunnels.pop(); // 一个隧道删掉，其他服务还依赖共享 A。
  assert.equal((await s.service.sync("one")).applied, false);
  s.tunnels.length = 0;
  assert.equal((await s.service.sync("one")).summary.delete, 1);
  assert.deepEqual(s.records.map(x => x.id), ["manual", "untracked"]);
});

test("预览期间改为只读会阻止实际写入，并发同步只产生一条记录", async t => {
  const s = setup(t);
  const original = s.service.plan.bind(s.service);
  s.service.plan = async id => { const p = await original(id); s.service.write(id, { canWrite: false }); return p; };
  assert.equal((await s.service.sync("one")).action, "paused");
  assert.equal(s.writes().length, 0);
  s.service.plan = original;
  s.service.write("one", { canWrite: true });
  await Promise.all([s.service.sync("one"), s.service.sync("one"), s.service.sync("one")]);
  assert.equal(s.writes().length, 1);
});

test("分页后的旧记录会清理，节点解析失败和损坏配置不会误删记录", async t => {
  const s = setup(t, { recordIds: ["old"] });
  for (let i = 0; i < 100; i++) s.records.push({ id: `manual-${i}`, name: `manual-${i}.example.com`, type: "TXT" });
  s.records.push({ id: "old", name: "old.example.com", type: "A", comment: MANAGED_COMMENT });
  await s.service.sync("one");
  assert.equal(s.records.some(x => x.id === "old"), false);
  fs.writeFileSync(path.join(s.dir, "runtime-frpc.toml"), 'serverAddr = "bad.invalid"');
  s.service.resolveIPv4 = async () => { throw new Error("DNS unavailable"); };
  const count = s.writes().length;
  await assert.rejects(s.service.sync("one"), /unavailable/);
  assert.equal(s.writes().length, count);
  fs.writeFileSync(s.service.configPath("one"), '{bad');
  await assert.rejects(s.service.sync("one"), /配置无法读取/);
});

test("后台每轮读取三开关，失败自动退避，停止后不再调度", async t => {
  const s = setup(t, { canWrite: false });
  const scheduler = s.service.startAutoFollow({ intervalMs: 100000 });
  t.after(() => scheduler.stop());
  scheduler.start(); await scheduler.tick();
  assert.equal(s.requests.length, 0);
  s.service.configure("one", { canWrite: true, autoFollow: false });
  await scheduler.tick(); assert.equal(s.requests.length, 0);
  s.service.configure("one", { autoFollow: true });
  const fetchImpl = s.service.fetchImpl;
  s.service.fetchImpl = async () => { throw new Error("offline"); };
  await scheduler.tick();
  assert.ok(s.service.read("one").lastError.includes("无法连接"));
  s.service.fetchImpl = fetchImpl;
  await scheduler.tick(); assert.equal(s.writes().length, 0);
  s.service.configure("one", { autoFollow: true }); // 设置修改取消退避。
  await scheduler.tick(); assert.equal(s.writes().length, 1);
  scheduler.stop(); s.service.configure("one", { canWrite: true });
  const count = s.requests.length; await scheduler.tick(); assert.equal(s.requests.length, count);
});

test("授权验证仅 GET；配置接口拒绝非法类型且不接受凭据和账本注入", async t => {
  const s = setup(t, { canWrite: false });
  assert.equal((await s.service.verifyToken("token", "example.com")).ok, true);
  assert.equal(s.writes().length, 0);
  assert.throws(() => s.service.configure("one", { canWrite: "false" }), /开关/);
  s.service.configure("one", { encryptedToken: "injected", recordIds: ["injected"] });
  assert.equal(s.service.read("one").encryptedToken, "secret");
  assert.deepEqual(s.service.read("one").recordIds, []);
});
