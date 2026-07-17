友情链接：[LINUX DO](https://linux.do/)
# LAN InkPad Enhanced

让 Android 手机在同一 Wi-Fi 下充当 Windows 浏览器的低延迟手写板。增强版支持将当前浏览器标签页通过 WebRTC 实时传到手机，并支持在画面上放大、平移和精确绘图。

增强版完整说明见 [ENHANCED.md](./ENHANCED.md)。稳定版保留在相邻的 `lan-inkpad` 目录中。

现在提供两种 Windows 显示方式：

- `extension/`：推荐，作为 Chrome/Edge 扩展覆盖绝大多数普通网页。
- `desktop/`：独立网页画布，可在项目页面内打开 PDF 并标注。

浏览器扩展的安装和限制见 [EXTENSION.md](./EXTENSION.md)。

## 已实现

- Windows 浏览器内打开 PDF，并在独立 Canvas 层实时标注
- 手机端普通笔、荧光笔、激光笔、橡皮、颜色、粗细、撤销和清屏
- 6 位房间码、一台电脑配对一台手机、断线自动重连、心跳与消息限制
- 整个画布或任意 `X / Y / 宽 / 高` 局部坐标范围
- 默认 `contain` 等比例映射；宽高比不同时手机自动留边，留边区域不会落笔
- 全部协议坐标使用 `0..1` 归一化值，Windows 端再映射为逻辑像素，避免 DPR/系统缩放重复换算
- Pointer Events、合并触控事件、逐帧小批量发送和手机本地即时预览
- Capacitor Android 打包配置与 PowerShell 构建脚本

## Windows 使用

1. 安装 Node.js 20 或更新版本。
2. 首次运行双击 `start-windows.cmd`；它会安装依赖、启动局域网服务并打开本机 IP 查询页面。
3. Windows 防火墙首次询问时，允许“专用网络”。
4. 电脑页面会显示 6 位配对码。手机端填写电脑局域网 IP（例如 `192.168.1.8:8788`）和配对码。
5. 在电脑页面打开 PDF，建议进入全屏，再按需输入目标坐标范围。

也可以在终端运行：

```powershell
npm install
npm start
```

电脑访问 `http://localhost:8788`。手机浏览器调试版可访问 `http://电脑IP:8788/mobile/`。

## Android APK

完整步骤见 [ANDROID.md](./ANDROID.md)。首次初始化：

```powershell
.\scripts\android-init.ps1
.\scripts\android-build.ps1
```

Debug APK 默认输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。

## 坐标定义

Windows 显示的坐标是当前网页画布的逻辑像素，不是 Windows 桌面的物理像素。目标范围为 `(x, y, width, height)`，手机有效绘图区内的归一化点 `(u, v)` 按下式映射：

```text
desktopX = x + u × width
desktopY = y + v × height
```

手机有效绘图区保持目标范围宽高比并居中。因此中心、四角和局部范围都能严格对应，不会因手机与电脑屏幕比例不同而被拉伸。

## 浏览器边界

普通网页不能绘制到 Acrobat、Office、Edge 的另一个标签页或整个 Windows 桌面。本项目把 PDF 放在同一网页中并叠加画布，这是“不安装 Windows EXE”前提下可靠的实现。纯双击 `file://` HTML 也不能监听 WebSocket 端口，所以 Windows 仍需运行本项目的 JavaScript 服务；它不是 EXE，也不需要安装桌面程序。

如果未来必须覆盖任意 Windows 软件，需要增加 Electron/Tauri/Win32 透明置顶窗口，这会改变当前产品边界。

## 测试

```powershell
npm test
npm run check
```

若手机连接失败，请检查两台设备是否在同一 Wi-Fi、路由器是否开启 AP 隔离、电脑防火墙是否允许 TCP 8788，以及手机填写的是否为电脑局域网 IP 而不是 `localhost`。
