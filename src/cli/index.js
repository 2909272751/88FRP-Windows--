#!/usr/bin/env node
const fs = require("fs/promises");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { Command } = require("commander");
const { confirm, input, select } = require("@inquirer/prompts");

const { getCleanArgv, preloadEnvFromArgv } = require("../shared/env-loader");

preloadEnvFromArgv();

const { DEFAULT_AGENT_HOST, DEFAULT_AGENT_PORT, DEFAULT_REMOTE_URL } = require("../shared/constants");

const AGENT_HOST = process.env.AGENT_HOST || DEFAULT_AGENT_HOST;
const AGENT_PORT = Number(process.env.AGENT_PORT || DEFAULT_AGENT_PORT);
const SELECT_PAGE_SIZE = 8;

function sendAgentRequest(payload) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: AGENT_HOST, port: AGENT_PORT }, () => {
      client.write(`${JSON.stringify(payload)}\n`);
    });

    let raw = "";
    client.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    client.on("error", reject);
    client.on("close", () => {
      try {
        const response = JSON.parse((raw || "{}").trim());
        if (!response.success) {
          reject(new Error(response.message || "agent 请求失败"));
          return;
        }
        resolve(response.data);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function isAgentRunning() {
  try {
    await sendAgentRequest({ action: "health" });
    return true;
  } catch {
    return false;
  }
}

function startAgentDetached() {
  const agentEntry = path.join(__dirname, "..", "agent", "server.js");
  const child = spawn(process.execPath, [agentEntry], {
    cwd: path.resolve(__dirname, "..", ".."),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function ensureAgentRunning() {
  if (await isAgentRunning()) {
    return;
  }

  startAgentDetached();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await isAgentRunning()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("agent 启动失败，请手动执行 `npm run agent` 排查。");
}

function formatBool(value) {
  return value ? "是" : "否";
}

function translateStatus(status) {
  return {
    stopped: "已停止",
    starting: "启动中",
    running: "运行中",
    stopping: "停止中",
    error: "异常",
  }[status] || "未知";
}

function printSectionTitle(title) {
  console.log(`\n=== ${title} ===`);
}

function promptSelect(message, choices) {
  return select({
    message,
    choices,
    pageSize: Math.min(SELECT_PAGE_SIZE, Math.max(choices.length, 1)),
  });
}

function parseChineseBoolean(value, label) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "是", "开", "开启"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "否", "关", "关闭"].includes(normalized)) {
    return false;
  }

  throw new Error(`${label} 仅支持 true/false、是/否、开/关。`);
}

function printInstances(items) {
  if (!items.length) {
    console.log("当前没有实例。");
    return;
  }

  for (const item of items) {
    console.log(
      [
        `ID: ${item.id}`,
        `名称: ${item.name}`,
        `状态: ${translateStatus(item.runtime.status)}`,
        `自动同步: ${formatBool(item.autoSyncEnabled)}`,
        `自动恢复: ${formatBool(item.autoStartEnabled)}`,
      ].join(" | ")
    );
  }
}

function printInstanceDetail(instance) {
  printSectionTitle("实例信息");
  console.log(`ID: ${instance.id}`);
  console.log(`名称: ${instance.name}`);
  console.log(`远程地址: ${instance.remoteUrl || "(未设置)"}`);
  console.log(`密钥: ${instance.secretKey ? "已设置" : "未设置"}`);
  console.log(`自动同步: ${formatBool(instance.autoSyncEnabled)}`);
  console.log(`自动恢复: ${formatBool(instance.autoStartEnabled)}`);
  console.log(`已创建配置文件: ${formatBool(instance.hasConfig)}`);
  console.log(`创建时间: ${instance.createdAt || "-"}`);
  console.log(`更新时间: ${instance.updatedAt || "-"}`);
  printRuntimeStatus(instance.runtime);
}

function printRuntimeStatus(runtime) {
  printSectionTitle("运行状态");
  console.log(`状态: ${translateStatus(runtime.status)}`);
  console.log(`PID: ${runtime.pid ?? "-"}`);
  console.log(`最近启动时间: ${runtime.lastStartedAt || "-"}`);
  console.log(`最近退出码: ${runtime.lastExitCode ?? "-"}`);
  console.log(`最近错误: ${runtime.lastError || "-"}`);
  console.log(`状态更新时间: ${runtime.updatedAt || "-"}`);
}

async function fetchInstancesOrThrow() {
  const items = await sendAgentRequest({ action: "list" });
  if (!items.length) {
    throw new Error("当前没有实例，请先创建实例。");
  }
  return items;
}

async function chooseInstanceId(message = "请选择实例") {
  const items = await fetchInstancesOrThrow();
  return promptSelect(
    message,
    items.map((item) => ({
      name: `${item.name} | ${translateStatus(item.runtime.status)} | ${item.id}`,
      value: item.id,
      description: `自动同步: ${formatBool(item.autoSyncEnabled)}，自动恢复: ${formatBool(item.autoStartEnabled)}`,
    }))
  );
}

async function askInstancePayload(existing = {}) {
  const name = await input({
    message: "请输入实例名称",
    default: existing.name || "",
    validate(value) {
      return value.trim() ? true : "实例名称不能为空";
    },
  });

  const secretKey = await input({
    message: "请输入密钥，可留空",
    default: existing.secretKey || "",
  });

  const remoteUrl = await input({
    message: "请输入远程配置地址，可留空",
    default: existing.remoteUrl || DEFAULT_REMOTE_URL,
  });

  const autoSyncEnabled = await confirm({
    message: "是否开启自动同步？",
    default: Boolean(existing.autoSyncEnabled),
  });

  const autoStartEnabled = await confirm({
    message: "服务启动时是否自动恢复该实例？",
    default: existing.autoStartEnabled !== false,
  });

  return {
    name: name.trim(),
    secretKey: secretKey.trim(),
    remoteUrl: remoteUrl.trim(),
    autoSyncEnabled,
    autoStartEnabled,
  };
}

async function readConfigTextFromOptions(options) {
  if (options.file) {
    return fs.readFile(path.resolve(options.file), "utf8");
  }

  if (options.text) {
    return String(options.text);
  }

  if (options.stdin) {
    return new Promise((resolve, reject) => {
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        raw += chunk;
      });
      process.stdin.on("end", () => resolve(raw));
      process.stdin.on("error", reject);
    });
  }

  throw new Error("请通过 `--file`、`--text` 或 `--stdin` 提供配置内容。");
}

async function saveConfigFromFileFlow(instanceId) {
  const filePath = await input({
    message: "请输入配置文件路径",
    validate(value) {
      return value.trim() ? true : "配置文件路径不能为空";
    },
  });
  const configText = await fs.readFile(path.resolve(filePath.trim()), "utf8");
  return sendAgentRequest({
    action: "config:set",
    input: { instanceId, configText },
  });
}

async function showMenu() {
  await ensureAgentRunning();

  while (true) {
    const action = await promptSelect("请选择操作", [
        { name: "1.查看实例列表", value: "list" },
        { name: "2.创建实例", value: "create" },
        { name: "3.修改实例信息", value: "update" },
        { name: "4.删除实例", value: "delete" },
        { name: "5.查看实例状态", value: "status" },
        { name: "6.启动实例", value: "start" },
        { name: "7.停止实例", value: "stop" },
        { name: "8.重启实例", value: "restart" },
        { name: "9.查看实例配置", value: "config-get" },
        { name: "10.从文件导入配置", value: "config-set-file" },
        { name: "11.手动同步实例", value: "sync" },
        { name: "12.查看实例日志", value: "logs" },
        { name: "13.退出菜单", value: "quit" },
      ]);

    if (action === "quit") {
      break;
    }

    if (action === "list") {
      printSectionTitle("实例列表");
      printInstances(await sendAgentRequest({ action: "list" }));
      continue;
    }

    if (action === "create") {
      const payload = await askInstancePayload();
      const result = await sendAgentRequest({ action: "create", input: payload });
      console.log(`已创建实例：${result.name}（${result.id}）`);
      continue;
    }

    const instanceId = await chooseInstanceId("请选择要操作的实例");

    if (action === "update") {
      const instance = await sendAgentRequest({ action: "get", input: { instanceId } });
      const payload = await askInstancePayload(instance);
      const result = await sendAgentRequest({
        action: "update",
        input: { instanceId, payload },
      });
      console.log(`实例信息已更新：${result.name}`);
      continue;
    }

    if (action === "delete") {
      const instance = await sendAgentRequest({ action: "get", input: { instanceId } });
      const confirmed = await confirm({
        message: `确认删除实例“${instance.name}”吗？`,
        default: false,
      });
      if (!confirmed) {
        console.log("已取消删除。");
        continue;
      }
      await sendAgentRequest({ action: "delete", input: { instanceId } });
      console.log("实例已删除。");
      continue;
    }

    if (action === "status") {
      const instance = await sendAgentRequest({ action: "get", input: { instanceId } });
      printInstanceDetail(instance);
      continue;
    }

    if (action === "start" || action === "stop" || action === "restart") {
      const result = await sendAgentRequest({ action, input: { instanceId } });
      printRuntimeStatus(result);
      continue;
    }

    if (action === "config-get") {
      const result = await sendAgentRequest({ action: "config:get", input: { instanceId } });
      printSectionTitle("配置内容");
      console.log(result.configText || "(空配置)");
      continue;
    }

    if (action === "config-set-file") {
      const result = await saveConfigFromFileFlow(instanceId);
      console.log(result.validation.warnings[0] || "配置已导入。");
      continue;
    }

    if (action === "sync") {
      const restartOnChange = await confirm({
        message: "配置变更后是否重启实例？",
        default: true,
      });
      const result = await sendAgentRequest({ action: "sync", input: { instanceId, restartOnChange } });
      console.log(
        result.changed
          ? `同步成功，运行动作：${result.runtimeAction}`
          : "远程配置没有变化。"
      );
      continue;
    }

    if (action === "logs") {
      const result = await sendAgentRequest({ action: "logs", input: { instanceId, tail: 200 } });
      printSectionTitle("运行日志");
      console.log(result.content || "(空日志)");
    }
  }
}

const program = new Command();
program.name("88frpctl").description("88FRP 命令行工具");
program.configureHelp({
  helpWidth: 100,
  subcommandTerm(cmd) {
    return cmd.name() + (cmd.usage() ? ` ${cmd.usage()}` : "");
  },
  optionTerm(option) {
    return option.flags;
  },
});
program.addHelpText("beforeAll", "88FRP 命令行工具\n\n");
program.addHelpText("afterAll", "\n示例:\n  88frpctl menu\n  88frpctl create --name 主力隧道 --auto-sync\n");

program
  .command("menu")
  .description("打开中文交互式菜单")
  .action(async () => {
    await showMenu();
  });

program
  .command("agent-start")
  .description("启动本地管理服务")
  .action(async () => {
    await ensureAgentRunning();
    console.log("本地管理服务已启动。");
  });

program
  .command("agent-stop")
  .description("停止本地管理服务")
  .action(async () => {
    await sendAgentRequest({ action: "agent:stop" });
    console.log("本地管理服务停止指令已发送。");
  });

program
  .command("agent-status")
  .description("查看本地管理服务状态")
  .action(async () => {
    await ensureAgentRunning();
    const result = await sendAgentRequest({ action: "health" });
    printSectionTitle("本地管理服务状态");
    console.log(`运行状态: 正常`);
    console.log(`PID: ${result.pid}`);
    console.log(`frpc 路径: ${result.frpc.path}`);
    console.log(`frpc 已存在: ${formatBool(result.frpc.exists)}`);
    console.log(`frpc 可执行: ${formatBool(result.frpc.canExecute)}`);
  });

program
  .command("list")
  .description("列出实例")
  .action(async () => {
    await ensureAgentRunning();
    printSectionTitle("实例列表");
    printInstances(await sendAgentRequest({ action: "list" }));
  });

program
  .command("create")
  .description("创建实例")
  .requiredOption("--name <name>", "实例名称")
  .option("--secret <secret>", "远程配置密钥")
  .option("--remote-url <url>", "远程配置地址")
  .option("--auto-sync", "开启自动同步")
  .option("--no-auto-start", "关闭启动自动恢复")
  .action(async (options) => {
    await ensureAgentRunning();
    const result = await sendAgentRequest({
      action: "create",
      input: {
        name: options.name,
        secretKey: options.secret || "",
        remoteUrl: options.remoteUrl || DEFAULT_REMOTE_URL,
        autoSyncEnabled: Boolean(options.autoSync),
        autoStartEnabled: options.autoStart,
      },
    });
    console.log(`已创建实例：${result.name}（${result.id}）`);
  });

program
  .command("update <id>")
  .description("更新实例基础信息")
  .option("--name <name>", "实例名称")
  .option("--secret <secret>", "远程配置密钥")
  .option("--remote-url <url>", "远程配置地址")
  .option("--auto-sync <value>", "设置自动同步，支持 true/false、是/否")
  .option("--auto-start <value>", "设置启动自动恢复，支持 true/false、是/否")
  .action(async (id, options) => {
    await ensureAgentRunning();
    const payload = {};
    if (options.name !== undefined) payload.name = options.name;
    if (options.secret !== undefined) payload.secretKey = options.secret;
    if (options.remoteUrl !== undefined) payload.remoteUrl = options.remoteUrl;
    if (options.autoSync !== undefined) payload.autoSyncEnabled = parseChineseBoolean(options.autoSync, "自动同步");
    if (options.autoStart !== undefined) payload.autoStartEnabled = parseChineseBoolean(options.autoStart, "自动恢复");

    const result = await sendAgentRequest({
      action: "update",
      input: { instanceId: id, payload },
    });
    console.log(`实例信息已更新：${result.name}`);
  });

program
  .command("delete <id>")
  .description("删除实例")
  .option("--force", "不再二次确认")
  .action(async (id, options) => {
    await ensureAgentRunning();
    if (!options.force) {
      const confirmed = await confirm({
        message: `确认删除实例 ${id} 吗？`,
        default: false,
      });
      if (!confirmed) {
        console.log("已取消删除。");
        return;
      }
    }

    await sendAgentRequest({ action: "delete", input: { instanceId: id } });
    console.log("实例已删除。");
  });

program
  .command("status <id>")
  .description("查看实例详情和运行状态")
  .action(async (id) => {
    await ensureAgentRunning();
    const result = await sendAgentRequest({ action: "get", input: { instanceId: id } });
    printInstanceDetail(result);
  });

for (const commandName of ["start", "stop", "restart"]) {
  program
    .command(`${commandName} <id>`)
    .description(`${commandName === "start" ? "启动" : commandName === "stop" ? "停止" : "重启"}实例`)
    .action(async (id) => {
      await ensureAgentRunning();
      const result = await sendAgentRequest({ action: commandName, input: { instanceId: id } });
      printRuntimeStatus(result);
    });
}

program
  .command("config-get <id>")
  .description("查看实例配置")
  .action(async (id) => {
    await ensureAgentRunning();
    const result = await sendAgentRequest({ action: "config:get", input: { instanceId: id } });
    printSectionTitle("配置内容");
    console.log(result.configText || "(空配置)");
  });

program
  .command("config-set <id>")
  .description("写入实例配置")
  .option("--file <path>", "从文件读取配置")
  .option("--text <text>", "直接传入配置文本")
  .option("--stdin", "从标准输入读取配置")
  .action(async (id, options) => {
    await ensureAgentRunning();
    const configText = await readConfigTextFromOptions(options);
    const result = await sendAgentRequest({
      action: "config:set",
      input: { instanceId: id, configText },
    });
    console.log(result.validation.warnings[0] || "配置已保存。");
  });

program
  .command("sync <id>")
  .description("手动同步远程配置")
  .option("--restart-on-change", "配置变更后自动重启实例")
  .action(async (id, options) => {
    await ensureAgentRunning();
    const result = await sendAgentRequest({
      action: "sync",
      input: { instanceId: id, restartOnChange: Boolean(options.restartOnChange) },
    });
    console.log(result.changed ? `同步成功，运行动作：${result.runtimeAction}` : "远程配置没有变化。");
  });

program
  .command("logs <id>")
  .description("查看实例日志")
  .option("--tail <number>", "读取最后 N 行日志", "200")
  .action(async (id, options) => {
    await ensureAgentRunning();
    const result = await sendAgentRequest({
      action: "logs",
      input: { instanceId: id, tail: Number(options.tail || 200) },
    });
    printSectionTitle("运行日志");
    console.log(result.content || "(空日志)");
  });

program.parseAsync(getCleanArgv(), { from: "user" }).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
