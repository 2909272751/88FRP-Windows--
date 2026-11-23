# 3.3.1 验收证据

本目录记录 2026-11-23 的真实验收结果，供后续维护和交付复核。

## 文件

- `web-gateway-1440.png`、`web-services-1440.png`、`web-domain-1440.png`、`web-remote-1440.png`、`web-runtime-1440.png`：生产 8801 五个管理页截图。
- `web-services-1000.png`：1000 逻辑宽度单列布局截图。
- `portal-1440.png`：公开导航页截图。
- `web-error-recovery-1440.png`：模拟后台失败后的错误提示与重试入口。
- `native-uia-tree.txt`：真实 `88FRP.exe` 五页 Windows UIA 树；所有禁用工程词为 0。
- `native-exe.json`：真实 EXE 路径、大小、SHA-256、窗口标题和 UIA 关键项。
- `web-qa.json`：生产页面 JS 错误和禁用词计数。
- `responsive-audit.json`：1000/1280/1440/1920 四档 × 五页 + 公开导航的溢出和按钮重叠检查。
- `first-paint.json`：骨架/缓存首屏耗时。
- `save-feedback.json`：保存设备设置的 UI 提示。
- `link-hrefs.json`：公开导航和服务卡片链接清单。
- `core-api.json`：生产核心接口状态码。
- `npm-test-final.txt`：最终全量测试输出。

## 说明

当前远程桌面会话处于断开状态，WPF `RenderTargetBitmap` 和 `PrintWindow` 无法取得原生像素，故不把黑图作为视觉证据；原生端以 UIA 树和 EXE 元数据验收，Web 视觉以真实 8801 页面截图验收。
