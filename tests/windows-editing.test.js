const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('桌面状态轮询保留中文输入、光标、隧道选择和配置草稿', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '88frp-editing-'));
  const instance = { id: 'fixture-instance', name: 'Fixture', runtime: { status: 'running', pid: 1234 } };
  const tunnel = { name: 'fixture-tunnel', displayName: 'Fixture', enabled: false, type: 'tcp', localPort: 123, remotePort: 456 };
  const server = http.createServer((req, res) => {
    const route = req.url;
    let data = {};
    if (route === '/api/instances') data = [instance];
    else if (route.endsWith('/config')) data = { configText: 'original configuration' };
    else if (route.endsWith('/tunnels')) data = { tunnels: [tunnel] };
    else if (route.endsWith('/logs')) data = { logs: '' };
    else if (route === '/api/instances/fixture-instance') data = instance;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(root, 'machine-config.json'), JSON.stringify({ dataRoot: root }));
    const framework = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319');
    const exe = path.join(root, 'editing-test.exe');
    execFileSync(path.join(framework, 'csc.exe'), [
      '/nologo', '/target:exe', '/codepage:65001', '/main:NativeEditingRegression', `/out:${exe}`,
      ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'System.Xaml.dll', 'Microsoft.CSharp.dll'].map(x => `/reference:${x}`),
      ...['WindowsBase', 'PresentationCore', 'PresentationFramework'].map(x => `/reference:${path.join(framework, 'WPF', x + '.dll')}`),
      ...['WpfClient.cs', 'DomainTab.cs', 'ConsoleSecurityWindow.cs', 'ClientThemePalette.cs', 'ClientUiStyles.cs'].map(x => path.join(__dirname, '../src/windows-launcher', x)),
      path.join(__dirname, 'fixtures/NativeEditingRegression.cs'),
    ], { windowsHide: true, timeout: 20000 });
    const { stdout } = await promisify(execFile)(exe, [String(server.address().port)], { windowsHide: true, timeout: 20000 });
    assert.match(stdout, /PASS: runtime polls preserve/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
