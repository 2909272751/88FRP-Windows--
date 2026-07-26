# 88FRP Windows 原生客户端

一个面向 Windows 的 88FRP 桌面客户端，提供原生窗口、托盘后台运行、开机自启动、远程配置同步、隧道选择和日志查看。

## 主要功能

- 原生 Windows 桌面界面，双击 `88FRP.exe` 即可使用
- 关闭窗口后保持托盘后台运行
- 首次启动引导设置开机自启动
- 注册表启动项 + Windows 计划任务双通道自启动
- 后台核心自动守护，异常时自动拉起
- 支持同步 88FRP 远程配置
- 桌面端与 Web 控制台均可连接 88FRP 账号并显示隧道备注名称
- 可选择保存加密密码，在登录失效时自动重新登录
- 支持只运行勾选的隧道
- 同步后保留已保存的隧道选择，新隧道默认关闭
- 配置编辑、实例启动/停止/重启、运行日志查看
- 高 DPI 适配，支持高分辨率屏幕

## 下载使用

请在 GitHub Release 中下载：

```text
88FRP-Windows-Setup-1.1.0.exe
```

双击安装器并按向导完成安装即可。建议使用默认安装目录；也可以安装到固定目录，例如 `D:\88FRP\`。

安装后从开始菜单或桌面快捷方式打开 `88FRP`。不要单独打开 `88frp-web.exe`，它是隐藏运行的后台核心。

## 88FRP 账号与备注名称

在桌面端或 Web 控制台点击“连接 88FRP”，输入 88FRP 用户名和密码即可。

- 连接完成后会获取已有隧道的官方备注名称
- 同步配置发生变化时自动更新备注名称
- Web 隧道列表优先显示备注名称，并保留 FRPC 标识和端口信息
- 默认使用 Windows DPAPI 加密保存密码；取消勾选后，只保存登录令牌，不会自动重新登录

## 隧道选择逻辑

客户端会保存远程同步得到的完整配置，但实际运行时只生成包含已勾选隧道的运行配置。

- 完整配置：`frpc.toml`
- 隧道选择：`selection.json`
- 实际运行配置：`runtime-frpc.toml`

同步远程配置后：

- 已存在隧道保留原来的启用/禁用状态
- 新出现的隧道默认关闭
- 未勾选隧道保留在配置中，但不会启动

## 自启动原理

开启自启动后会写入两处：

1. 当前用户注册表启动项

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run\88FRP
```

2. Windows 计划任务

```text
88FRP Background
```

两者都会执行：

```text
88FRP.exe --background
```

程序内部有单实例保护，即使两个自启动通道同时触发，也只会保留一个后台实例。

## 开发和构建

安装依赖：

```bash
npm install
```

运行测试：

```bash
npm test
```

构建 Windows 发布包：

```powershell
npm run build:windows:native
```

构建 Windows 安装器（需安装 Inno Setup 6 或 7）：

```powershell
npm run build:windows:installer
```

构建结果：

```text
dist/88FRP-Windows/88FRP.exe
dist/88FRP-Windows.zip
dist/88FRP-Windows-Setup-1.1.0.exe
```

## 项目结构

```text
src/core/                  核心服务、实例管理、进程管理、隧道过滤
src/web/                   隐藏后台 Web/API 核心
src/windows-launcher/      C# WinForms 原生客户端
assets/                    Logo 和图标资源
scripts/                   构建和服务脚本
tests/                     自动化测试
```

## 常见问题

### 为什么同步配置提示 500？

这通常表示远程配置接口返回错误。常见原因：

- 密钥不正确
- 88FRP 平台接口临时异常
- 当前账号没有返回有效配置

请检查密钥后再同步。

### 为什么不建议单独打开 88frp-web.exe？

`88frp-web.exe` 是后台核心，不是用户入口。普通用户应该打开 `88FRP.exe`。

### 这是 Windows Service 吗？

当前版本是登录后自启动的桌面托盘程序，不是系统级 Windows Service。它适合个人 Windows 桌面长期后台运行。

## 许可证

请根据上游 88FRP/frpc 相关许可要求使用。
