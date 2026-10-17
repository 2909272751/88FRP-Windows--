const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

test("原生主题在 WPF 样式封装和控件渲染后仍可反复切换", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "88frp-theme-"));
  try {
    const framework = path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319");
    const wpf = path.join(framework, "WPF");
    const exe = path.join(dir, "theme-test.exe");
    execFileSync(path.join(framework, "csc.exe"), [
      "/nologo", "/target:exe", "/codepage:65001", `/out:${exe}`,
      "/reference:System.dll", "/reference:System.Core.dll", "/reference:System.Xaml.dll",
      ...["WindowsBase", "PresentationCore", "PresentationFramework"].map(name => `/reference:${path.join(wpf, name + ".dll")}`),
      path.join(__dirname, "../src/windows-launcher/ClientThemePalette.cs"),
      path.join(__dirname, "../src/windows-launcher/ClientUiStyles.cs"),
      path.join(__dirname, "fixtures/ClientThemeRegression.cs"),
    ], { windowsHide: true, timeout: 20000 });
    const result = execFileSync(exe, [], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    assert.match(result, /PASS: frozen-brush reproduction and 20 rendered-style theme switches/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
