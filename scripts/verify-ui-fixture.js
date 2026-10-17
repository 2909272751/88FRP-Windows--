// Isolated visual fixture. No real account, DNS token, or FRPC process is used.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-ui-"));
  process.env.APP_BASE_DIR = root;
  process.env.DATA_DIR = path.join(root, "data");
  process.env.INSTANCE_AUTO_START_ON_BOOT = "0";
  const { createWebApp } = require("../src/web/server");
  const bundle = await createWebApp({ initializeRuntime: false });
  const instance = await bundle.context.instanceService.create({ name: "界面验证 · 20 条隧道", autoStartEnabled: false });
  const names = ["主机 deepseek", "主机 cd2", "主机 alist", "主机 codex", "主机 SSH", "主机 远程桌面", "公司面板",
    "公司 文件服务", "公司 内网开发与资料归档服务（长名称验证）", ...Array.from({ length: 11 }, (_, i) => `备用 服务 ${i + 1}`)];
  const config = 'serverAddr = "192.0.2.10"\nserverPort = 7000\n' + names.map((name, i) =>
    `\n[[proxies]]\nname = "${name}"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = ${i === 4 ? 22 : i === 5 ? 3389 : 8000 + i}\nremotePort = ${20000 + i}\n`).join("");
  await bundle.context.store.saveConfig(instance.id, config);
  await bundle.context.store.saveTunnelSelection(instance.id, Object.fromEntries(names.map((name, i) => [name, i < 7])));
  bundle.context.domainBindingService.write(instance.id, { enabled: true, canWrite: false, autoFollow: true,
    zone: "example.com", encryptedToken: "fixture-only", lastSyncAt: new Date().toISOString() });
  await bundle.context.consoleAuthService.configure({ username: "88frp-test", password: "LocalFixtureOnly!" });
  await fs.writeFile(path.join(root, "native-client-first-run.flag"), "declined");
  const { createAccessCenterApp } = require("../src/core/access-center-service");
  const server = bundle.app.listen(0, "127.0.0.1");
  const accessServer = createAccessCenterApp(bundle.context.accessCenterService).listen(0, "127.0.0.1");
  await Promise.all([server, accessServer].map(server => new Promise(resolve => server.on("listening", resolve))));
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/`, accessUrl: `http://127.0.0.1:${accessServer.address().port}/access`, root }));
  const stop = async () => {
    bundle.scheduler.stop();
    for (const current of [server, accessServer]) { current.closeAllConnections(); current.close(); }
    await fs.rm(root, { recursive: true, force: true }); process.exit(0);
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
})().catch(error => { console.error(error.message); process.exit(1); });
