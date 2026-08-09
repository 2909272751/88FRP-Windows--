const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { DEFAULT_AUTO_SYNC_INTERVAL_MS } = require("../src/shared/constants");
const { Store } = require("../src/core/store");
const {
  RemoteSyncError,
  SyncService,
  normalizeAutoSyncInterval,
  parseRetryAfter,
} = require("../src/core/sync-service");

test("同一实例的并发同步只执行一次远程请求", async () => {
  let fetchCount = 0;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const store = {
    async getInstance() {
      return { id: "demo", name: "demo" };
    },
    async readConfig() {
      return "unchanged";
    },
  };
  const service = new SyncService({ store });
  service.fetchRemoteConfig = async () => {
    fetchCount += 1;
    await fetchGate;
    return {
      configText: "unchanged",
      validation: { valid: true, errors: [], warnings: [] },
    };
  };

  const first = service.syncInstance("demo", { restartOnChange: true });
  const second = service.syncInstance("demo", { restartOnChange: true });
  releaseFetch();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(fetchCount, 1);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.changed, false);
});

test("自动同步失败后进入退避而不是立即重复请求", async () => {
  let syncCount = 0;
  const logMessages = [];
  const service = new SyncService({
    store: {
      async listInstances() {
        return [{ id: "demo", name: "demo", autoSyncEnabled: true }];
      },
    },
    logger: {
      async error(message) {
        logMessages.push(message);
      },
    },
  });
  service.syncInstance = async () => {
    syncCount += 1;
    throw new Error("network timeout");
  };
  const scheduler = service.startAutoSyncScheduler();

  await scheduler.tick();
  await scheduler.tick();

  assert.equal(syncCount, 1);
  assert.equal(logMessages.length, 1);
  assert.match(logMessages[0], /network timeout/);
});

test("自动同步默认间隔为五分钟", () => {
  assert.equal(DEFAULT_AUTO_SYNC_INTERVAL_MS, 5 * 60_000);
  assert.equal(normalizeAutoSyncInterval(60_000), 5 * 60_000);
  assert.equal(normalizeAutoSyncInterval(10 * 60_000), 10 * 60_000);
});

test("旧版保存的一分钟同步间隔在升级后自动按五分钟运行", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-settings-migration-"));
  try {
    const store = new Store({ dataDir });
    await store.initialize();
    await fs.writeFile(store.settingsFile, JSON.stringify({ autoSyncIntervalMs: 60_000 }), "utf8");

    assert.equal((await store.getSettings()).autoSyncIntervalMs, DEFAULT_AUTO_SYNC_INTERVAL_MS);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("远程接口限流时保留 Retry-After 供调度器退避", async () => {
  const service = new SyncService({
    store: {
      async getSettings() { return { apiTimeout: 1000 }; },
    },
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => name === "retry-after" ? "120" : "" },
    }),
  });

  await assert.rejects(
    service.fetchRemoteConfig({ remoteUrl: "https://example.test/{{secret}}", secretKey: "demo" }),
    (error) => error instanceof RemoteSyncError && error.status === 429 && error.retryAfterMs === 120_000
  );
});

test("Retry-After 同时支持 HTTP 日期", () => {
  const now = Date.parse("2026-08-09T00:00:00Z");
  assert.equal(parseRetryAfter("Sun, 09 Aug 2026 00:03:00 GMT", now), 180_000);
});
