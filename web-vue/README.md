# web-vue

基于 Vue 3 + Vite 的 WDA Web 控制台重构版本，核心功能与旧版 `web/` 静态页保持一致：

- MJPEG / WebRTC 双流切换
- Appium 一键操作与参数调节
- 手势识别（点击、长按、拖拽/滚动、捏合）
- WebSocket 通道与设备发现

## 本地开发

```bash
npm install
npm run dev
```

默认使用 `http://<当前主机>:7070` 作为 API 基址，可通过地址栏追加 `?api=...` 覆盖；
WebSocket 端口默认 `8765`（亦可通过 `?ws=` 或 `?ws_host/ws_port` 覆盖），与旧版保持一致。

## 构建与预览

```bash
npm run build
npm run preview
```

打包结果位于 `dist/`，可直接部署到静态服务器上（需同时提供 MJPEG/WebRTC 流与 WebSocket 服务）。
