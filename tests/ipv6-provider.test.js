const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deduplicateCandidates,
  scoreCandidate,
  selectBestCandidate,
} = require("../src/core/gateway/ipv6-provider");

function candidate(overrides = {}) {
  return {
    address: "240e:3b8:30:bc81:5e39:af6e:4220:4f7a",
    interfaceName: "WLAN",
    prefixOrigin: "RouterAdvertisement",
    suffixOrigin: "Link",
    prefixLength: 64,
    skipAsSource: false,
    ...overrides,
  };
}

test("稳定 RouterAdvertisement 地址优先于 DHCP 临时地址", () => {
  const stable = candidate();
  const dhcp = candidate({
    address: "240e:3b8:30:bc81::dc",
    prefixOrigin: "Dhcp",
    suffixOrigin: "Dhcp",
    prefixLength: 128,
    skipAsSource: true,
  });

  assert.ok(scoreCandidate(stable, "240e:3b8:30:bc81::dc") > scoreCandidate(dhcp, "240e:3b8:30:bc81::dc"));
  assert.equal(selectBestCandidate([dhcp, stable], "240e:3b8:30:bc81::dc").address, stable.address);
});

test("skip-as-source 地址不会因为上次使用过而继续抢占", () => {
  const stable = candidate();
  const dhcp = candidate({
    address: "240e:3b8:30:bc81::dc",
    prefixOrigin: "Dhcp",
    suffixOrigin: "Dhcp",
    prefixLength: 128,
    skipAsSource: true,
  });

  assert.equal(selectBestCandidate([dhcp, stable], dhcp.address).address, stable.address);
});

test("去重时保留 SkipAsSource 与地址族信息", () => {
  const result = deduplicateCandidates([
    {
      IPAddress: "240e:3b8:30:bc81::dc",
      InterfaceAlias: "WLAN",
      PrefixOrigin: "Dhcp",
      SuffixOrigin: "Dhcp",
      PrefixLength: 128,
      SkipAsSource: true,
    },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].skipAsSource, true);
  assert.equal(result[0].prefixLength, 128);
});

test("Windows 枚举数字会转换为稳定地址语义", () => {
  const result = deduplicateCandidates([
    {
      IPAddress: "240e:3b8:30:bc81:5e39:af6e:4220:4f7a",
      InterfaceAlias: "WLAN",
      PrefixOrigin: 4,
      SuffixOrigin: 4,
      PrefixLength: 64,
      SkipAsSource: false,
    },
    {
      IPAddress: "240e:3b8:30:bc81::dc",
      InterfaceAlias: "WLAN",
      PrefixOrigin: 3,
      SuffixOrigin: 3,
      PrefixLength: 128,
      SkipAsSource: true,
    },
  ]);

  assert.equal(result.find((item) => item.address.endsWith("5e39:af6e:4220:4f7a")).prefixOrigin, "routeradvertisement");
  assert.equal(result.find((item) => item.address.endsWith("::dc")).suffixOrigin, "dhcp");
});
