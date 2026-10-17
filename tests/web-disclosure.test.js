const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

test("域名授权展开状态不被轮询重置，并按实例记住手动选择", async () => {
  const storage = new Map();
  function mount() {
    const nodes = new Map();
    function node(id) {
      if (nodes.has(id)) return nodes.get(id);
      const classes = new Set();
      const value = { style: {}, handlers: {}, attributes: {}, className: "", value: "",
        classList: { contains: key => classes.has(key), remove: key => classes.delete(key), add: key => classes.add(key),
          toggle(key, enabled) { const next = enabled === undefined ? !classes.has(key) : enabled; if (next) classes.add(key); else classes.delete(key); return next; } },
        addEventListener(event, fn) { this.handlers[event] = fn; },
        setAttribute(key, value) { this.attributes[key] = value; }, querySelectorAll: () => [],
      };
      nodes.set(id, value); return value;
    }
    const context = vm.createContext({ document: { getElementById: node, activeElement: null, hidden: false },
      window: { API: { getDomainBinding: async () => ({ data: { hasToken: true, config: { zone: "example.com", enabled: true, canWrite: false }, links: [] } }) },
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, toast: () => {} },
      setInterval() {}, console,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/web/public/js/domain-binding.js"), "utf8"), context);
    context.window.DomainBinding.bind();
    return { api: context.window.DomainBinding, node };
  }
  let page = mount();
  await page.api.activate("one");
  assert.equal(page.node("domainAuthCard").classList.contains("is-expanded"), false);
  page.node("btnToggleDomainAuth").handlers.click();
  assert.equal(page.node("domainAuthCard").classList.contains("is-expanded"), true);
  await page.api.refresh();
  assert.equal(page.node("domainAuthCard").classList.contains("is-expanded"), true);
  await page.api.activate("two");
  assert.equal(page.node("domainAuthCard").classList.contains("is-expanded"), false);
  await page.api.activate("one");
  assert.equal(page.node("domainAuthCard").classList.contains("is-expanded"), true);
  page = mount();
  await page.api.activate("one");
  assert.equal(page.node("btnToggleDomainAuth").attributes["aria-expanded"], "true");
  page.node("btnToggleDomainAuth").handlers.click();
  await page.api.refresh();
  assert.equal(page.node("btnToggleDomainAuth").attributes["aria-expanded"], "false");
});
