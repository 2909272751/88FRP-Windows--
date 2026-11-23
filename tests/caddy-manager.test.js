const test = require("node:test");
const assert = require("node:assert/strict");

const { CaddyManager } = require("../src/core/gateway/caddy-manager");

test("Caddy 配置预检使用 adapt，不触发 Cloudflare Token 在线校验", async () => {
  const calls = [];
  const manager = new CaddyManager({
    store: { caddyfilePath: "Caddyfile" },
    binaryPath: process.execPath,
    logger: {},
    validateCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: "{}", stderr: "" };
    },
  });
  manager.setToken("secret-token");
  await manager.validateConfig("Caddyfile.candidate");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["adapt", "--config", "Caddyfile.candidate", "--adapter", "caddyfile"]);
  assert.deepEqual(calls[0].options.env, {});
  assert.equal(calls[0].args.includes("validate"), false);
});
