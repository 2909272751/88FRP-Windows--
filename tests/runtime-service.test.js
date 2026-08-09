const test = require("node:test");
const assert = require("node:assert/strict");

const { RuntimeService } = require("../src/core/runtime-service");

test("backend restart marker resumes a running instance even when boot autostart is disabled", async () => {
  const started = [];
  const instance = { id: "demo", name: "demo", autoStartEnabled: false, hasConfig: true };
  const runtime = { status: "restarting", pid: null, resumeOnBackendStart: true };
  const service = new RuntimeService({
    store: {
      async getSettings() { return { instanceAutoStartOnBoot: false }; },
      async listInstances() { return [instance]; },
      async getRuntime() { return runtime; },
    },
    processManager: {
      checkPid() { return false; },
      async start(value) { started.push(value.id); return { status: "running" }; },
    },
    logger: { async info() {}, async error() {} },
  });

  assert.deepEqual(await service.restoreOnBoot(), ["demo"]);
  assert.deepEqual(started, ["demo"]);
});

test("backend shutdown delegates whether active instances should resume", async () => {
  const calls = [];
  const service = new RuntimeService({
    store: {},
    processManager: { async stopAll(options) { calls.push(options); } },
    logger: {},
  });
  await service.prepareForBackendShutdown({ resumeInstances: true });
  await service.prepareForBackendShutdown({ resumeInstances: false });
  assert.deepEqual(calls, [{ resume: true }, { resume: false }]);
});
