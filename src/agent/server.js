#!/usr/bin/env node
const net = require("net");

const { preloadEnvFromArgv } = require("../shared/env-loader");

preloadEnvFromArgv();

const { createAppContext } = require("../core/bootstrap");
const { DEFAULT_AGENT_HOST, DEFAULT_AGENT_PORT } = require("../shared/constants");

function createResponse(success, data = null, message = "ok") {
  return JSON.stringify({ success, message, data });
}

async function reply(socket, context, raw, shutdown) {
  try {
    const payload = raw.trim() ? JSON.parse(raw.trim()) : {};
    const data = await handleAction(context, payload, shutdown);
    socket.end(`${createResponse(true, data)}\n`);
  } catch (error) {
    socket.end(`${createResponse(false, null, error.message)}\n`);
  }
}

async function handleAction(context, payload, shutdown) {
  const { action, input = {} } = payload || {};
  switch (action) {
    case "health":
      return {
        agent: "running",
        pid: process.pid,
        frpc: context.processManager.getBinaryStatus(),
      };
    case "list":
      return context.instanceService.list();
    case "get":
      return context.instanceService.get(input.instanceId);
    case "create":
      return context.instanceService.create(input);
    case "update":
      return context.instanceService.update(input.instanceId, input.payload || {});
    case "delete":
      return context.instanceService.delete(input.instanceId);
    case "status":
      return context.runtimeService.getStatus(input.instanceId);
    case "start":
      return context.runtimeService.start(input.instanceId);
    case "stop":
      return context.runtimeService.stop(input.instanceId);
    case "restart":
      return context.runtimeService.restart(input.instanceId);
    case "config:get": {
      const instance = await context.instanceService.get(input.instanceId);
      return {
        instanceId: instance.id,
        configText: instance.configText,
      };
    }
    case "config:set": {
      const validation = await context.syncService.saveConfig(input.instanceId, input.configText || "");
      return { validation };
    }
    case "tunnels:list":
      return context.tunnelService.list(input.instanceId);
    case "tunnels:selection:set":
      return context.tunnelService.saveSelection(input.instanceId, input.selection || {});
    case "sync":
      return context.syncService.syncInstance(input.instanceId, {
        restartOnChange: Boolean(input.restartOnChange),
      });
    case "logs":
      return {
        content: await context.store.readInstanceLog(input.instanceId, input.tail || 200),
      };
    case "agent:stop":
      setTimeout(() => shutdown(), 100);
      return { stopping: true };
    default:
      throw new Error(`不支持的 action: ${action}`);
  }
}

async function startAgent() {
  const context = await createAppContext();
  const host = process.env.AGENT_HOST || DEFAULT_AGENT_HOST;
  const port = Number(process.env.AGENT_PORT || DEFAULT_AGENT_PORT);

  await context.processManager.hydrateRuntimeState();
  await context.runtimeService.restoreOnBoot();
  const scheduler = context.syncService.startAutoSyncScheduler();
  await scheduler.start();

  const server = net.createServer((socket) => {
    let raw = "";
    let handled = false;

    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (!handled && raw.includes("\n")) {
        handled = true;
        reply(socket, context, raw, shutdown);
      }
    });

    socket.on("end", async () => {
      if (!handled && raw.trim()) {
        handled = true;
        await reply(socket, context, raw, shutdown);
      }
    });
  });

  async function shutdown() {
    scheduler.stop();
    server.close();
    await context.logger.warn("agent 已停止。");
    process.exit(0);
  }

  server.listen(port, host, async () => {
    await context.logger.info(`agent 已启动: tcp://${host}:${port}`);
    console.log(`88frp agent listening on tcp://${host}:${port}`);
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startAgent().catch((error) => {
  console.error(error);
  process.exit(1);
});
