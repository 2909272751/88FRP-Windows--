const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/core/store");

test("状态写入中途读者仍得到完整旧数据，并发保存按调用顺序提交", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-atomic-"));
  const file = path.join(root, "runtime.json");
  const store = new Store({ dataDir: root });
  const originalWrite = fs.writeFile;
  let release, entered;
  const paused = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { entered = resolve; });
  try {
    await originalWrite(file, JSON.stringify({ status: "running", keep: "old" }));
    let first = true;
    fs.writeFile = async (destination, contents, options) => {
      if (first) {
        first = false;
        await originalWrite(destination, contents.slice(0, 7), options);
        entered();
        await paused;
        return originalWrite(destination, contents, "utf8");
      }
      return originalWrite(destination, contents, options);
    };
    const one = store.writeJson(file, { status: "starting", sequence: 1 });
    const two = store.writeJson(file, { status: "running", sequence: 2 });
    await writing;
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { status: "running", keep: "old" });
    release();
    await Promise.all([one, two]);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { status: "running", sequence: 2 });
    assert.deepEqual(await fs.readdir(root), ["runtime.json"]);
  } finally {
    release(); fs.writeFile = originalWrite;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("保存中断保留完整原配置，不留下临时文件，后续保存仍可成功", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "88frp-save-failure-"));
  const file = path.join(root, "settings.json");
  const store = new Store({ dataDir: root });
  const originalWrite = fs.writeFile;
  try {
    await originalWrite(file, '{"keep":"history"}');
    fs.writeFile = async (destination, contents, options) => {
      await originalWrite(destination, contents.slice(0, 7), options);
      throw Object.assign(new Error("Simulated disk write interruption"), { code: "EIO" });
    };
    await assert.rejects(store.writeJson(file, { keep: "new" }), /interruption/);
    assert.equal(await fs.readFile(file, "utf8"), '{"keep":"history"}');
    assert.deepEqual(await fs.readdir(root), ["settings.json"]);
    fs.writeFile = originalWrite;
    await store.writeJson(file, { keep: "recovered" });
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { keep: "recovered" });
  } finally {
    fs.writeFile = originalWrite;
    await fs.rm(root, { recursive: true, force: true });
  }
});
