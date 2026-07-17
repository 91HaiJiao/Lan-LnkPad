# LAN InkPad Android 打包

手机端是 `mobile/` 下的原生 HTML/CSS/JavaScript，使用 Capacitor 封装成 APK。Windows 端仍可直接在浏览器打开 `desktop/`，两端通过局域网 WebSocket 通信。

## 一次性环境准备

1. 安装 Node.js 18+、Android Studio（含 Android SDK、SDK Platform 和 Android SDK Build-Tools）。
2. 在项目根目录安装 Capacitor 依赖（如果项目尚未安装）：

   ```powershell
   npm install @capacitor/core @capacitor/android
   npm install -D @capacitor/cli
   ```

3. 初始化 Android 工程：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\android-init.ps1
   ```

   该命令只会创建 `android/`（若已存在则保留，不覆盖手工修改）。

## 构建与安装

同步 `mobile/` 并构建 Debug APK：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\android-build.ps1
```

生成文件位于 `android/app/build/outputs/apk/debug/app-debug.apk`。连接开启 USB 调试的手机或启动模拟器后，可执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\android-run.ps1
```

需要 Android Studio 调试时可附加 `-Open`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\android-build.ps1 -Open
```

发布包示例：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\android-build.ps1 -Configuration Release
```

Release APK 需在 Android Studio 中配置签名后再分发。

## 局域网与明文连接

`capacitor.config.json` 将 Android 本地页面设为 `http` scheme 并启用 `server.cleartext`，避免从手机页面连接 Windows 端 `ws://`/`http://` 地址时触发 HTTPS 混合内容拦截；仅在可信家庭/办公网络使用。首次连接时请在手机和电脑上确认两台设备处于同一 Wi‑Fi，并使用电脑局域网 IP（不要填写 `localhost`）。

若路由器启用了 AP 隔离、Windows 防火墙阻止端口，需关闭 AP 隔离或放行应用使用的端口。Capacitor 本身不负责发现服务，项目内的配对/连接界面仍按前端实现为准。

## 开发迭代

修改 `mobile/` 后重新执行 `android-build.ps1`（其内部会运行 `npx cap sync android`）。不要直接编辑 `android/app/src/main/assets/public`，该目录会在下一次同步时被覆盖。
