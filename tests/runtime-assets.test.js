const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { ensureExecutableFileMode } = require("../src/shared/runtime-assets");

test("ensureExecutableFileMode 在非 Windows 环境下为文件补执行权限", {
  skip: process.platform === "win32",
}, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-runtime-assets-"));
  const filePath = path.join(tempDir, "88frpc");

  try {
    await fs.writeFile(filePath, "demo", { mode: 0o644 });
    await ensureExecutableFileMode(filePath);

    const stat = await fs.stat(filePath);
    assert.equal(Boolean(stat.mode & 0o111), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
