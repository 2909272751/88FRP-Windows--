const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decorateStatus,
  parsePortValues,
  validPorts,
} = require("../src/core/gateway/firewall-service");

test("防火墙端口解析兼容数组、逗号和范围", () => {
  assert.deepEqual(parsePortValues([7777, "50258,64540", "8000-8002"]), [
    7777,
    50258,
    64540,
    8000,
    8001,
    8002,
  ]);
  assert.deepEqual(parsePortValues(["0", "65536", "bad", ""]), []);
  assert.deepEqual(validPorts([7777, 7777, "50258", 70000]), [7777, 50258]);
});

test("防火墙状态逐端口判断覆盖情况", () => {
  const status = decorateStatus(
    {
      supported: true,
      tcpRule: true,
      udpRule: false,
      tcpPorts: ["7777,50258"],
      udpPorts: [],
      firewallEnabled: true,
    },
    [7777, 50258, 64540],
    [],
  );
  assert.deepEqual(status.tcpPorts, [7777, 50258]);
  assert.deepEqual(status.missingTcpPorts, [64540]);
  assert.equal(status.tcpCovered, false);
  assert.equal(status.udpCovered, true);
});

test("没有 UDP 期望端口时不会被标记为缺失", () => {
  const status = decorateStatus(
    {
      supported: true,
      tcpRule: true,
      udpRule: false,
      tcpPorts: [7777],
      udpPorts: [],
      firewallEnabled: false,
      profiles: [{ name: "Domain", enabled: false }],
    },
    [7777],
    [],
  );
  assert.equal(status.firewallEnabled, false);
  assert.equal(status.tcpCovered, true);
  assert.deepEqual(status.missingUdpPorts, []);
});
