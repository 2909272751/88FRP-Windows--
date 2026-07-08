const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  getCleanArgv,
  parseEnvText,
  resolveEnvFilePath,
} = require("../src/shared/env-loader");

test("parseEnvText 支持注释、export 和引号值", () => {
  const parsed = parseEnvText(`
# comment
HOST=127.0.0.1
export PORT=9901
APP_BASE_DIR="D:/88frp data"
INVALID-LINE
`);

  assert.equal(parsed.HOST, "127.0.0.1");
  assert.equal(parsed.PORT, "9901");
  assert.equal(parsed.APP_BASE_DIR, "D:/88frp data");
});

test("getCleanArgv 会移除 --env-file 参数", () => {
  const argv = ["menu", "--env-file", "./test.env", "--name", "demo"];
  assert.deepEqual(getCleanArgv(argv), ["menu", "--name", "demo"]);
});

test("resolveEnvFilePath 返回绝对路径", () => {
  const cwd = path.join("D:\\", "workspace");
  const resolved = resolveEnvFilePath(["--env-file", ".env.local"], cwd);
  assert.equal(resolved, path.resolve(cwd, ".env.local"));
});

test("在 require 常量模块前预加载 env 文件会影响默认数据目录", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-env-test-"));
  const envFilePath = path.join(tempDir, "app.env");
  const customBaseDir = path.join(tempDir, "custom-base");

  await fs.writeFile(envFilePath, `APP_BASE_DIR=${customBaseDir}\n`, "utf8");

  const script = `
    const { preloadEnvFromArgv } = require("./src/shared/env-loader");
    preloadEnvFromArgv({ argv: ["--env-file", ${JSON.stringify(envFilePath)}] });
    const constants = require("./src/shared/constants");
    process.stdout.write(constants.DEFAULT_DATA_DIR);
  `;

  const output = execFileSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
  });

  assert.equal(output, path.join(customBaseDir, "data"));
  await fs.rm(tempDir, { recursive: true, force: true });
});
