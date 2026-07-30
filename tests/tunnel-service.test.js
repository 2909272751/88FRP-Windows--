const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRuntimeConfig,
  inferTunnelGroups,
  parseFrpcTunnels,
} = require("../src/core/tunnel-service");

const SAMPLE_CONFIG = `
serverAddr = "frp.example.com"
serverPort = 7000

[[proxies]]
name = "rdp"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3389
remotePort = 13966

[[proxies]]
name = "web"
type = "tcp"
localPort = 8080
remotePort = 18080
`;

test("parses frpc proxy tunnel summaries", () => {
  const tunnels = parseFrpcTunnels(SAMPLE_CONFIG);

  assert.equal(tunnels.length, 2);
  assert.deepEqual(
    tunnels.map((item) => ({
      name: item.name,
      type: item.type,
      localPort: item.localPort,
      remotePort: item.remotePort,
    })),
    [
      { name: "rdp", type: "tcp", localPort: 3389, remotePort: 13966 },
      { name: "web", type: "tcp", localPort: 8080, remotePort: 18080 },
    ]
  );
});

test("builds runtime config with only selected tunnels", () => {
  const runtimeConfig = buildRuntimeConfig(SAMPLE_CONFIG, { web: true });

  assert.match(runtimeConfig, /serverAddr = "frp\.example\.com"/);
  assert.doesNotMatch(runtimeConfig, /name = "rdp"/);
  assert.match(runtimeConfig, /name = "web"/);
});

test("new or unselected tunnels default to disabled", () => {
  const runtimeConfig = buildRuntimeConfig(SAMPLE_CONFIG, {});

  assert.match(runtimeConfig, /serverPort = 7000/);
  assert.doesNotMatch(runtimeConfig, /name = "rdp"/);
  assert.doesNotMatch(runtimeConfig, /name = "web"/);
});

test("shows cached display names without changing the FRPC selection key", async () => {
  const { TunnelService } = require("../src/core/tunnel-service");
  const store = {
    async readConfig() { return SAMPLE_CONFIG; },
    async getTunnelSelection() { return { rdp: true }; },
    async getTunnelLabels() { return { rdp: { displayName: "公司电脑" } }; },
  };
  const service = new TunnelService({ store });
  const result = await service.list("instance-1");

  assert.equal(result.tunnels[0].name, "rdp");
  assert.equal(result.tunnels[0].displayName, "公司电脑");
  assert.equal(result.tunnels[0].enabled, true);
});

test("按备注开头自动分组，并优先保留手动分组", () => {
  const groups = inferTunnelGroups([
    { name: "office_pc", displayName: "公司电脑" },
    { name: "office_nas", displayName: "公司 alist" },
    { name: "home_pc", displayName: "家电脑" },
    { name: "home_nas", displayName: "家alist" },
    { name: "misc", displayName: "cd2" },
  ], { misc: "测试环境" });

  assert.deepEqual(groups.map((item) => ({ name: item.name, group: item.group, groupSource: item.groupSource })), [
    { name: "office_pc", group: "公司", groupSource: "automatic" },
    { name: "office_nas", group: "公司", groupSource: "automatic" },
    { name: "home_pc", group: "家", groupSource: "automatic" },
    { name: "home_nas", group: "家", groupSource: "automatic" },
    { name: "misc", group: "测试环境", groupSource: "manual" },
  ]);
});
