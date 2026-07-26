#!/usr/bin/env node
const path = require("path");
const express = require("express");

const { preloadEnvFromArgv } = require("../shared/env-loader");

preloadEnvFromArgv();

const { createAppContext } = require("../core/bootstrap");
const { validateConfigText } = require("../core/sync-service");
const { prepareRuntimeAssets } = require("../shared/runtime-assets");
const { getPublicDir } = require("../shared/runtime-env");

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

async function createWebApp() {
  await prepareRuntimeAssets();
  const context = await createAppContext();
  const app = express();
  const publicDir = getPublicDir();

  await context.processManager.hydrateRuntimeState();
  await context.runtimeService.restoreOnBoot();
  const scheduler = context.syncService.startAutoSyncScheduler();
  await scheduler.start();

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));

  app.get("/api/health", (_req, res) => {
    sendJson(res, {
      service: "88frp-node-web",
      nodeVersion: process.version,
      frpc: context.processManager.getBinaryStatus(),
    });
  });

  app.get("/api/instances", asyncHandler(async (_req, res) => {
    sendJson(res, await context.instanceService.list());
  }));

  app.get("/api/88frp/account", asyncHandler(async (_req, res) => {
    sendJson(res, await context.frpAccountService.getStatus());
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
    scheduler,
  };
}

async function startWebServer() {
  const host = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || 8801);
  const { app, context, scheduler } = await createWebApp();
  const server = app.listen(port, host, () => {
    console.log(`88frp web listening on http://${host}:${port}`);
  });

  async function shutdown() {
    scheduler.stop();
    await context.logger.warn("web 服务准备停止。");
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = {
  createWebApp,
  startWebServer,
};

if (require.main === module) {
  startWebServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
