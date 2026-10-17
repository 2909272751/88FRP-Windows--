const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

test("Web 控制台能初始化并切换四个页面，非法保存视图会回到隧道页", async () => {
  for (const view of ["", "?view=domain", "?view=invalid"]) {
    const nodes = new Map();
    function node(id) {
      if (nodes.has(id)) return nodes.get(id);
      const classes = new Set();
      const value = { id, style: {}, dataset: {}, handlers: {},
        classList: { toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key), add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
        setAttribute() {}, addEventListener(event, fn) { this.handlers[event] = fn; },
        querySelector: key => node(`${id}/${key}`), querySelectorAll: () => [], appendChild() {}, focus() {}, };
      nodes.set(id, value); return value;
    }
    const tabs = ["tunnels", "editor", "log", "domain"].map(id => Object.assign(node(`tab-${id}`), { dataset: { view: id } }));
    let ready, calls = 0;
    const context = vm.createContext({
      document: { getElementById: node, querySelector: node, addEventListener: (event, fn) => { if (event === "DOMContentLoaded") ready = fn; },
        querySelectorAll: selector => selector === ".tab" ? tabs : [], documentElement: node("html") },
      window: { location: { search: view }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: false }) },
      API: { getInstances: async () => { calls++; return { data: [] }; }, getFrpAccount: async () => { calls++; return { data: { connected: false } }; } },
      URLSearchParams, setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {}, console,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/web/public/js/app.js"), "utf8"), context);
    assert.doesNotThrow(() => ready());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2, "初始化必须发起实例及账号加载");
    assert.equal(typeof context.window.toast, "function");
    for (const tab of tabs) {
      await tab.handlers.click();
      assert.equal(node(`${tab.dataset.view}View`).classList.contains("active"), true);
      assert.equal(tabs.filter(x => x.classList.contains("active")).length, 1);
    }
  }
});
