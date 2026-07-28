const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { acquireProcessLock } = require("../src/shared/process-lock");

test("同一运行目录只允许持有一个后台进程锁", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-lock-test-"));
  const lockPath = path.join(tempDir, "web-backend.lock");
  const first = acquireProcessLock(lockPath);
  try {
    assert.throws(
      () => acquireProcessLock(lockPath),
      (error) => error && error.code === "EALREADYRUNNING" && error.pid === process.pid
    );
  } finally {
    first.release();
  }

  const second = acquireProcessLock(lockPath);
  second.release();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("后台进程锁会回收已经退出进程留下的锁文件", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-stale-lock-test-"));
  const lockPath = path.join(tempDir, "web-backend.lock");
  await fs.writeFile(lockPath, "2147483647\n", "utf8");

  const lock = acquireProcessLock(lockPath);
  lock.release();

  await assert.rejects(fs.access(lockPath));
  await fs.rm(tempDir, { recursive: true, force: true });
});
