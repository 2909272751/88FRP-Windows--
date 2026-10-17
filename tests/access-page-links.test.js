const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("访问中心未启用的网页地址仍能点击，UDP 和纯地址模式继续只提供复制", async () => {
  function element(tagName = "div") {
    return { tagName, children: [], attributes: {}, handlers: {}, value: "", style: {},
      classList: { add() {}, remove() {} },
      append(...nodes) { this.children.push(...nodes); },
      appendChild(node) { this.children.push(node); return node; },
      replaceChildren(...nodes) { this.children = nodes; },
      addEventListener(name, action) { this.handlers[name] = action; },
      setAttribute(name, value) { this.attributes[name] = value; },
    };
  }
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const links = [
    { name: "其他电脑", enabled: false, canOpen: true, url: "http://192.0.2.1:8080", endpoint: "192.0.2.1:8080",
      domainCanOpen: true, domainUrl: "http://example.com:8080", domainEndpoint: "example.com:8080" },
    { name: "UDP", enabled: true, canOpen: false, url: "", endpoint: "192.0.2.1:3478",
      domainCanOpen: false, domainUrl: "", domainEndpoint: "example.com:3478" },
    { name: "纯地址", enabled: false, canOpen: false, url: "", endpoint: "192.0.2.1:22" },
    { name: "自定义", enabled: false, canOpen: true, url: "https://example.net/app", profile: { customUrl: "https://example.net/app" } },
  ];
  const opened = [];
  const context = vm.createContext({ document: { getElementById: node, createElement: element },
    window: { localStorage: { getItem: () => null }, location: { href: "http://example.net/access" },
      open: (...args) => opened.push(args) },
    fetch: async () => ({ ok: true, json: async () => ({ success: true, data: links }) }), console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/web/public/access/access.js"), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  const all = [];
  function visit(item) { all.push(item); item.children.forEach(visit); }
  visit(node("linkList"));
  assert.deepEqual(all.filter(item => item.tagName === "a").map(item => item.href).sort(),
    ["http://192.0.2.1:8080", "http://example.com:8080", "https://example.net/app"].sort());
  for (const anchor of all.filter(item => item.tagName === "a")) {
    assert.equal(anchor.target, "_blank");
    assert.equal(anchor.rel, "noopener noreferrer");
  }
  const open = all.find(item => item.attributes["aria-label"] === "打开域名链接：其他电脑");
  assert.equal(open.disabled, false);
  open.handlers.click();
  assert.equal(opened[0][0], "http://example.com:8080");
  assert.equal(all.find(item => item.attributes["aria-label"] === "打开节点直连：UDP").disabled, true);
  assert.equal(all.find(item => item.attributes["aria-label"] === "复制节点直连：UDP").disabled, false);
  assert.equal(all.find(item => item.attributes["aria-label"] === "打开节点直连：纯地址").disabled, true);
  assert.equal(node("enabledCount").textContent, "1");
  assert.equal(node("openableCount").textContent, "2");
  assert.equal(node("totalCount").textContent, "4");
  assert.equal(links[0].enabled, false);
  assert.ok(all.some(item => item.className === "status-label" && item.innerHTML.includes("未启用")));
});
