const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/core/store");
const { createAppContext } = require("../src/core/bootstrap");

test("升级后启动保留历史同步间隔与启动偏好，不以默认值覆盖", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-preserve-"));
  const oldInterval = process.env.AUTO_SYNC_INTERVAL_MS;
  const oldAutoStart = process.env.INSTANCE_AUTO_START_ON_BOOT;
  delete process.env.AUTO_SYNC_INTERVAL_MS; delete process.env.INSTANCE_AUTO_START_ON_BOOT;
  try {
    const store = new Store({ dataDir: directory }); await store.initialize();
    await store.saveSettings({ autoSyncIntervalMs: 900000, instanceAutoStartOnBoot: false, customSetting: "keep" });
    const context = await createAppContext({ dataDir: directory });
    assert.equal(context.settings.autoSyncIntervalMs, 900000);
    assert.equal(context.settings.instanceAutoStartOnBoot, false);
    assert.equal(context.settings.customSetting, "keep");
  } finally {
    if (oldInterval === undefined) delete process.env.AUTO_SYNC_INTERVAL_MS; else process.env.AUTO_SYNC_INTERVAL_MS = oldInterval;
    if (oldAutoStart === undefined) delete process.env.INSTANCE_AUTO_START_ON_BOOT; else process.env.INSTANCE_AUTO_START_ON_BOOT = oldAutoStart;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
