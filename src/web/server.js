#!/usr/bin/env node
const path = require("path");
const express = require("express");

const { preloadEnvFromArgv } = require("../shared/env-loader");

preloadEnvFromArgv();

const { createAppContext } = require("../core/bootstrap");
const { validateConfigText } = require("../core/sync-service");
const { acquireProcessLock } = require("../shared/process-lock");
const { prepareRuntimeAssets } = require("../shared/runtime-assets");
const { getPublicDir, getRuntimeRoot } = require("../shared/runtime-env");

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sendJson(res, data, message = "ok", statusCode = 200) {
  res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

function readCookie(header, name) {
  for (const item of String(header || "").split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function isDesktopRequest(req) {
  const ip = String(req.ip || req.socket.remoteAddress || "");
  return (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") && req.get("X-88FRP-Desktop") === "1";
}

async function createWebApp(options = {}) {
  await prepareRuntimeAssets();
  const context = await createAppContext();
  const app = express();
  const publicDir = getPublicDir();
  const scheduler = context.syncService.startAutoSyncScheduler();
  let runtimeInitialized = false;

  const initializeRuntime = async () => {
    if (runtimeInitialized) return;
    await context.processManager.hydrateRuntimeState();
    await context.runtimeService.restoreOnBoot();
    try {
      await context.accessCenterService.restore();
    } catch (error) {
      await context.logger.error(`访问中心自动恢复失败: ${error.message}`);
    }
    await scheduler.start();
    runtimeInitialized = true;
  };

  if (options.initializeRuntime !== false) {
    await initializeRuntime();
  }

  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    sendJson(res, {
      service: "88frp-node-web",
      nodeVersion: process.version,
      frpc: context.processManager.getBinaryStatus(),
    });
  });

  app.get("/api/console-auth/status", asyncHandler(async (_req, res) => {
    sendJson(res, await context.consoleAuthService.getStatus());
  }));
  app.get("/api/console-auth/challenge", asyncHandler(async (_req, res) => {
    sendJson(res, await context.consoleAuthService.createChallenge());
  }));
  app.post("/api/console-auth/login", asyncHandler(async (req, res) => {
    const session = await context.consoleAuthService.login(req.body || {}, req.ip || "unknown");
    res.setHeader("Set-Cookie", `88frp_console=${encodeURIComponent(session.token)}; Max-Age=${session.maxAge}; Path=/; HttpOnly; SameSite=Strict`);
    sendJson(res, { remember: session.remember }, "登录成功。");
  }));
  app.post("/api/console-auth/logout", (_req, res) => {
    res.setHeader("Set-Cookie", "88frp_console=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict");
    sendJson(res, null, "已退出登录。");
  });
  app.put("/api/console-auth", asyncHandler(async (req, res) => {
    if (!isDesktopRequest(req)) return res.status(403).json({ success: false, message: "请在 Windows 客户端中设置控制台账号。", data: null });
    sendJson(res, await context.consoleAuthService.configure(req.body || {}), "控制台账号已保存，其他浏览器登录已失效。");
  }));
  app.post("/api/console-auth/revoke-sessions", asyncHandler(async (req, res) => {
    if (!isDesktopRequest(req)) return res.status(403).json({ success: false, message: "请在 Windows 客户端中撤销已记住的设备。", data: null });
    await context.consoleAuthService.revokeSessions();
    sendJson(res, null, "已撤销所有浏览器登录。");
  }));

  const requireConsoleAuth = async (req, res, next) => {
    if (isDesktopRequest(req)) return next();
    if (await context.consoleAuthService.verify(readCookie(req.headers.cookie, "88frp_console"))) return next();
    return res.status(401).json({ success: false, message: "请先登录控制台。", data: null });
  };
  app.use("/api", asyncHandler(requireConsoleAuth));

  app.get("/api/instances", asyncHandler(async (_req, res) => {
    sendJson(res, await context.instanceService.list());
  }));

  app.get("/api/88frp/account", asyncHandler(async (_req, res) => {
    sendJson(res, await context.frpAccountService.getStatus());
  }));

  app.get("/api/access-center", asyncHandler(async (_req, res) => {
    sendJson(res, await context.accessCenterService.getStatus());
  }));

  app.put("/api/access-center", asyncHandler(async (req, res) => {
    sendJson(res, await context.accessCenterService.configure(req.body || {}), "访问中心配置已保存并已尝试连接。");
  }));

  app.post("/api/access-center/restart", asyncHandler(async (_req, res) => {
    await context.accessCenterService.restart();
    sendJson(res, await context.accessCenterService.getStatus(), "访问中心已重启。");
  }));

  app.delete("/api/access-center", asyncHandler(async (_req, res) => {
    sendJson(res, await context.accessCenterService.disable(), "访问中心已停止。已保存的连接信息仍会保留。");
  }));

  app.post("/api/88frp/account/connect", asyncHandler(async (req, res) => {
    const account = await context.frpAccountService.connect(req.body || {});
    const refresh = await context.frpAccountService.refreshTunnelLabels();
    if (refresh.reason === "updated") {
      const instances = await context.instanceService.list();
      for (const instance of instances) await context.tunnelService.applyLabels(instance.id, refresh.labels);
    }
    sendJson(res, { account, refreshed: refresh.reason === "updated" }, "88FRP 账号已连接。");
  }));

  app.post("/api/88frp/account/refresh-labels", asyncHandler(async (_req, res) => {
    const refresh = await context.frpAccountService.refreshTunnelLabels();
    if (refresh.reason === "not-connected") throw new Error("请先连接 88FRP 账号。");
    if (refresh.reason === "failed") throw new Error(refresh.error || "隧道名称同步失败。");

    const instances = await context.instanceService.list();
    for (const instance of instances) await context.tunnelService.applyLabels(instance.id, refresh.labels);
    sendJson(res, {
      labelCount: Object.keys(refresh.labels).length,
      instanceCount: instances.length,
    }, "隧道名称已同步。");
  }));

  app.delete("/api/88frp/account", asyncHandler(async (_req, res) => {
    sendJson(res, await context.frpAccountService.disconnect(), "88FRP 账号已断开并清除本机凭据。");
  }));

  app.post("/api/instances", asyncHandler(async (req, res) => {
    const instance = await context.instanceService.create(req.body || {});
    sendJson(res, instance, "实例已创建。", 201);
  }));

  app.get("/api/instances/:id", asyncHandler(async (req, res) => {
    sendJson(res, await context.instanceService.get(req.params.id));
  }));

  app.put("/api/instances/:id", asyncHandler(async (req, res) => {
    sendJson(res, await context.instanceService.update(req.params.id, req.body || {}), "实例信息已更新。");
  }));

  app.delete("/api/instances/:id", asyncHandler(async (req, res) => {
    const instance = await context.instanceService.get(req.params.id);
    const runtime = await context.runtimeService.getStatus(req.params.id);
    if (runtime.pid && context.processManager.checkPid(runtime.pid)) {
      await context.runtimeService.stop(req.params.id);
    }
    await context.instanceService.delete(req.params.id);
    sendJson(res, { id: instance.id }, "实例已删除。");
  }));

  app.get("/api/instances/:id/config", asyncHandler(async (req, res) => {
    const instance = await context.instanceService.get(req.params.id);
    sendJson(res, {
      instanceId: instance.id,
      configText: instance.configText,
      validation: validateConfigText(instance.configText),
    });
  }));

  app.get("/api/instances/:id/tunnels", asyncHandler(async (req, res) => {
    await context.instanceService.get(req.params.id);
    sendJson(res, await context.tunnelService.list(req.params.id));
  }));

  app.put("/api/instances/:id/tunnels/selection", asyncHandler(async (req, res) => {
    await context.instanceService.get(req.params.id);
    sendJson(
      res,
      await context.tunnelService.saveSelection(req.params.id, req.body.selection || {}),
      "隧道选择已保存。"
    );
  }));

  app.put("/api/instances/:id/tunnels/groups", asyncHandler(async (req, res) => {
    await context.instanceService.get(req.params.id);
    sendJson(
      res,
      await context.tunnelService.saveGroupOverrides(req.params.id, req.body.groupOverrides || {}),
      "隧道分组已保存。"
    );
  }));

  app.put("/api/instances/:id/config", asyncHandler(async (req, res) => {
    const validation = await context.syncService.saveConfig(req.params.id, String(req.body.configText || ""));
    sendJson(res, { validation }, validation.warnings[0] || "配置已保存。");
  }));

  app.get("/api/instances/:id/status", asyncHandler(async (req, res) => {
    sendJson(res, await context.runtimeService.getStatus(req.params.id));
  }));

  app.get("/api/instances/:id/logs", asyncHandler(async (req, res) => {
    await context.instanceService.get(req.params.id);
    sendJson(res, {
      content: await context.store.readInstanceLog(req.params.id, Number(req.query.tail || 200)),
    });
  }));

  app.post("/api/instances/:id/start", asyncHandler(async (req, res) => {
    sendJson(res, await context.runtimeService.start(req.params.id), "启动指令已发送。");
  }));

  app.post("/api/instances/:id/stop", asyncHandler(async (req, res) => {
    sendJson(res, await context.runtimeService.stop(req.params.id), "停止指令已发送。");
  }));

  app.post("/api/instances/:id/restart", asyncHandler(async (req, res) => {
    sendJson(res, await context.runtimeService.restart(req.params.id), "重启指令已发送。");
  }));

  app.post("/api/instances/:id/sync", asyncHandler(async (req, res) => {
    sendJson(
      res,
      await context.syncService.syncInstance(req.params.id, {
        restartOnChange: Boolean(req.body.restartOnChange),
      }),
      "同步已完成。"
    );
  }));

  app.get("/login", (_req, res) => res.sendFile(path.join(publicDir, "console-login.html")));
  app.use(express.static(publicDir, { index: false }));
  app.use(asyncHandler(async (req, res, next) => {
    if (isDesktopRequest(req) || await context.consoleAuthService.verify(readCookie(req.headers.cookie, "88frp_console"))) return next();
    return res.redirect(302, "/login");
  }));
  app.use((_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.use((error, _req, res, _next) => {
    res.status(500).json({
      success: false,
      message: error.message || "服务内部错误",
      data: null,
    });
  });

  return {
    app,
    context,
    initializeRuntime,
    scheduler,
  };
}

function listenWebApp(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

async function startWebServer(options = {}) {
  const host = options.host || process.env.HOST || "0.0.0.0";
  const port = Number(options.port || process.env.PORT || 8801);
  const lockPath = options.lockPath || path.join(getRuntimeRoot(), "web-backend.lock");
  const processLock = acquireProcessLock(lockPath);
  let bundle = null;
  try {
    bundle = await createWebApp({ initializeRuntime: false });
  } catch (error) {
    processLock.release();
    throw error;
  }
  const { app, context, initializeRuntime, scheduler } = bundle;
  let server = null;
  let shuttingDown = false;

  try {
    server = await listenWebApp(app, port, host);
    await initializeRuntime();
  } catch (error) {
    scheduler.stop();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    processLock.release();
    throw error;
  }

  console.log(`88frp web listening on http://${host}:${port}`);

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    scheduler.stop();
    await context.logger.warn("web 服务准备停止。");
    await context.accessCenterService.stop();
    server.close(() => {
      processLock.release();
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return {
    ...bundle,
    processLock,
    server,
  };
}

module.exports = {
  createWebApp,
  listenWebApp,
  startWebServer,
};

if (require.main === module) {
  startWebServer().catch((error) => {
    if (error && error.code === "EALREADYRUNNING") {
      console.error(error.message);
    } else if (error && error.code === "EADDRINUSE") {
      console.error(`88frp web port ${process.env.PORT || 8801} is already in use; duplicate backend exits.`);
    } else {
      console.error(error);
    }
    process.exit(error && error.code === "EALREADYRUNNING" ? 0 : 1);
  });
}
