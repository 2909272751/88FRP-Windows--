const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { RotatingLogWriter, readLogTail } = require("../src/shared/log-files");

test("rotating log writer keeps bounded backups", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-log-"));
  const logPath = path.join(dataDir, "runtime.log");
  try {
    const writer = new RotatingLogWriter(logPath, { maxBytes: 64, backups: 2 });
    await writer.write(`${"a".repeat(50)}\n`);
    await writer.write(`${"b".repeat(30)}\n`);
    await writer.write(`${"c".repeat(50)}\n`);
    await writer.end();

    assert.match(await fs.readFile(logPath, "utf8"), /^c+/);
    assert.match(await fs.readFile(`${logPath}.1`, "utf8"), /^b+/);
    assert.match(await fs.readFile(`${logPath}.2`, "utf8"), /^a+/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("tail reader returns only the requested final lines", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-log-tail-"));
  const logPath = path.join(dataDir, "runtime.log");
  try {
    const lines = Array.from({ length: 10_000 }, (_, index) => `line-${index}`);
    await fs.writeFile(logPath, `${lines.join("\n")}\n`, "utf8");
    assert.equal(await readLogTail(logPath, 3), "line-9997\nline-9998\nline-9999");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
