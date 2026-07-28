const test = require("node:test");
const assert = require("node:assert/strict");

const { SyncService } = require("../src/core/sync-service");

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
