const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { ProcessManager } = require("../src/core/process-manager");
const { Store } = require("../src/core/store");

class FakeChild extends EventEmitter {
  constructor(pid, alive) {
    super();
    this.pid = pid;
    this.alive = alive;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    alive.add(pid);
  }

  start() {
    setImmediate(() => this.emit("spawn"));
  }

  crash(code = 1) {
    if (!this.alive.delete(this.pid)) return;
    this.emit("close", code, null);
  }

  kill() {
    this.killed = true;
    if (this.alive.delete(this.pid)) this.emit("close", 0, "SIGTERM");
    return true;
  }
}

async function waitFor(predicate, timeoutMs = 800) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached before timeout");
}

test("managed FRPC restarts after a crash without creating duplicates", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-process-manager-"));
  const store = new Store({ dataDir });
  const alive = new Set();
  const children = [];
  const warnings = [];
  let nextPid = 50_000;
  try {
    await store.initialize();
    const instance = await store.createInstance({ name: "demo" });
    await store.saveConfig(instance.id, 'serverAddr = "example.test"\n[[proxies]]\nname = "demo"\ntype = "tcp"\n');
    const binaryPath = path.join(dataDir, "88frpc.exe");
    await fs.writeFile(binaryPath, "fake", "utf8");
    const manager = new ProcessManager({
      store,
      frpcBinaryPath: binaryPath,
      prepareConfigPath: (instanceId) => store.getConfigPath(instanceId),
      restartDelays: [5, 10],
      stableAfterMs: 60,
      monitorIntervalMs: 100,
      logger: {
        async info() {},
        async warn(message) { warnings.push(message); },
        async error() {},
      },
      spawnProcess() {
        const child = new FakeChild(nextPid++, alive);
        children.push(child);
        child.start();
        return child;
      },
    });
    manager.checkPid = (pid) => alive.has(pid);

    await manager.start(instance);
    await manager.start(instance);
    assert.equal(children.length, 1, "repeated start must be idempotent");

    children[0].crash(1);
    await waitFor(async () => children.length === 2 && (await store.getRuntime(instance.id)).status === "running");
    assert.equal(children.length, 2);
    assert.equal(warnings.length, 1);

    await manager.stop(instance.id);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(children.length, 2, "intentional stop must cancel recovery");
    assert.equal((await store.getRuntime(instance.id)).status, "stopped");
    manager.stopSupervisor();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("后台重启时无法停止旧 FRPC 会接管原进程而不是重复启动", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-process-adopt-"));
  const store = new Store({ dataDir });
  try {
    await store.initialize();
    const instance = await store.createInstance({ name: "adopted" });
    await store.saveConfig(instance.id, 'serverAddr = "example.test"\n');
    const binaryPath = path.join(dataDir, "88frpc.exe");
    await fs.writeFile(binaryPath, "fake", "utf8");
    await store.saveRuntime(instance.id, {
      status: "running",
      pid: 43_210,
      ownerPid: process.pid + 1,
      binaryPath,
      lastStartedAt: new Date().toISOString(),
    });
    let spawnCount = 0;
    const warnings = [];
    const manager = new ProcessManager({
      store,
      frpcBinaryPath: binaryPath,
      prepareConfigPath: (instanceId) => store.getConfigPath(instanceId),
      pidAlive: () => true,
      signalProcess() {
        const error = new Error("operation not permitted");
        error.code = "EPERM";
        throw error;
      },
      processInspector: async () => ({
        name: "88frpc",
        path: binaryPath,
        startTime: (await store.getRuntime(instance.id)).lastStartedAt,
      }),
      spawnProcess() {
        spawnCount += 1;
        throw new Error("must not spawn");
      },
      logger: {
        async warn(message) { warnings.push(message); },
      },
    });

    await manager.hydrateRuntimeState();
    await manager.inspectSupervisedProcesses();

    const runtime = await store.getRuntime(instance.id);
    assert.equal(spawnCount, 0);
    assert.equal(runtime.pid, 43_210);
    assert.equal(runtime.status, "running");
    assert.equal(warnings.length, 1);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("旧 PID 已被其他程序复用时不会误杀该进程", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-process-reused-pid-"));
  const store = new Store({ dataDir });
  try {
    await store.initialize();
    const instance = await store.createInstance({ name: "reused-pid" });
    const binaryPath = path.join(dataDir, "88frpc.exe");
    await fs.writeFile(binaryPath, "fake", "utf8");
    await store.saveRuntime(instance.id, {
      status: "running",
      pid: 43_212,
      ownerPid: process.pid + 1,
      binaryPath,
      lastStartedAt: new Date().toISOString(),
    });
    let signalCount = 0;
    const manager = new ProcessManager({
      store,
      frpcBinaryPath: binaryPath,
      pidAlive: () => true,
      signalProcess() { signalCount += 1; },
      processInspector: async () => ({ name: "notepad", path: "C:\\Windows\\notepad.exe" }),
      logger: {},
    });

    await manager.hydrateRuntimeState();

    const runtime = await store.getRuntime(instance.id);
    assert.equal(signalCount, 0);
    assert.equal(runtime.pid, null);
    assert.equal(runtime.status, "reconnecting");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("首次升级会安全接管没有所有者字段的旧版 FRPC", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-process-legacy-adopt-"));
  const store = new Store({ dataDir });
  try {
    await store.initialize();
    const instance = await store.createInstance({ name: "legacy" });
    const binaryPath = path.join(dataDir, "88frpc.exe");
    await fs.writeFile(binaryPath, "fake", "utf8");
    const startedAt = new Date().toISOString();
    await store.saveRuntime(instance.id, {
      status: "running",
      pid: 43_213,
      ownerPid: null,
      binaryPath: "",
      lastStartedAt: startedAt,
    });
    let signalCount = 0;
    const manager = new ProcessManager({
      store,
      frpcBinaryPath: binaryPath,
      pidAlive: () => true,
      signalProcess() { signalCount += 1; },
      processInspector: async () => ({ name: "88frpc", path: "", startTime: startedAt }),
      logger: {},
    });

    await manager.hydrateRuntimeState();

    const runtime = await store.getRuntime(instance.id);
    assert.equal(signalCount, 0);
    assert.equal(runtime.pid, 43_213);
    assert.equal(runtime.status, "running");
    assert.equal(runtime.ownerPid, process.pid);
    assert.equal(runtime.binaryPath, binaryPath);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
