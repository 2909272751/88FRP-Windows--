const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readJsonWithRecoverySync, writeJsonAtomicSync } = require("../src/shared/atomic-json-file");

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "88frp-atomic-json-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("持久配置写入保留上一份有效版本", t => {
  const directory = tempDir(t);
  const file = path.join(directory, "config.json");
  const previous = `${file}.previous`;
  writeJsonAtomicSync(file, { version: 1 });
  writeJsonAtomicSync(file, { version: 2 }, { backupPaths: [previous] });

  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(previous, "utf8")), { version: 1 });
});

test("刷盘失败时不替换现有配置且不留下临时文件", t => {
  const directory = tempDir(t);
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, '{"version":1}\n');
  const originalFsync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw Object.assign(new Error("Simulated fsync failure"), { code: "EIO" }); };
    assert.throws(() => writeJsonAtomicSync(file, { version: 2 }), /fsync failure/);
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1 });
  assert.deepEqual(fs.readdirSync(directory), ["config.json"]);
});

test("读取到损坏 JSON 时从备份自愈并归档损坏内容", t => {
  const directory = tempDir(t);
  const file = path.join(directory, "config.json");
  const previous = `${file}.previous`;
  fs.writeFileSync(previous, '{"version":1}\n');
  fs.writeFileSync(file, Buffer.alloc(32));

  const result = readJsonWithRecoverySync(file, { backupPaths: [previous] });
  assert.equal(result.recovered, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1 });
  assert.ok(fs.readdirSync(directory).some(name => name.includes("config.json.corrupt-")));
});

test("主文件丢失时从最近有效备份恢复", t => {
  const directory = tempDir(t);
  const file = path.join(directory, "config.json");
  const previous = `${file}.previous`;
  fs.writeFileSync(previous, '{"version":7}\n');

  const result = readJsonWithRecoverySync(file, { backupPaths: [previous] });
  assert.equal(result.recovered, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 7 });
});
