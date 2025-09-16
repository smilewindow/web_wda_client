# appium-device-discovery

用 [`appium-ios-device`](https://github.com/appium/appium-ios-device) 搭建的“设备发现”微服务，**无需 Appium 会话** 即可列出已连接的 iOS 设备、读取设备名/系统版本/型号/序列号等基础信息。
（可选）若开启 `ENABLE_DEVICETCL_ENRICH=true`，还会用 `xcrun devicectl` 补充连接方式等元数据。

> **运行环境要求**
> - **macOS + Xcode**（因为背后依赖 usbmuxd/Lockdown 和 devicectl）
> - Node.js 18+
> - 设备已 **信任/配对** 当前 Mac，且设备 **开启开发者模式**

## 快速开始

```bash
# 1) 安装依赖
npm i

# 2) 开发运行
npm run dev

# 或构建 & 生产运行
npm run build
npm start
```

默认端口 3030。可在 .env 或环境变量里配置：

```
PORT=3030
ENABLE_CORS=true
ENABLE_DEVICETCL_ENRICH=false
```

## API

### GET /health

检测工具链可用性。

```json
{ "ok": true, "xcrunFound": true, "devicectlAvailable": true }
```

### GET /devices

列出设备（无需会话）。

```json
{
  "devices": [
    {
      "udid": "00008120-XXXX...",
      "name": "iPhone 15 Pro",
      "osVersion": "18.6.2",
      "model": "iPhone16,2",
      "serialNumber": "XXXXXXX",
      "connection": "USB"
    }
  ]
}
```

### GET /devices/:udid

获取单台设备详情（含 raw Lockdown 信息）。

```json
{
  "udid": "00008120-XXXX...",
  "name": "iPhone 15 Pro",
  "osVersion": "18.6.2",
  "model": "iPhone16,2",
  "serialNumber": "XXXXXXX",
  "connection": "USB",
  "raw": { "...": "Lockdown fields..." }
}
```

## 与你的系统集成

前端调用本服务的 GET /devices 展示可用设备列表（含 UDID）。

用户选择设备后，把 UDID 传给你的 Python 后端，由后端去调用 Appium Server POST /session（在 caps 设置该 UDID）。

若你想走 Wi-Fi 直连 WDA，会话时可设置 webDriverAgentUrl（填设备上的 ServerURLHere 地址）；否则默认 USB + iproxy。

## 常见问题

- **为什么不用 Docker？** iOS 设备发现需要 macOS/Xcode 和本机的 usbmuxd/Lockdown 通道，容器内通常不可用，因此推荐直接在 macOS 主机运行该服务。
- **拿不到详细信息但能看到 UDID？** 说明设备未信任/未配对/未开开发者模式。请在设备上“信任此电脑”，并在 iOS 设置中打开“开发者模式”。

---

## 使用说明（TL;DR）

1. 在 macOS 上安装 Node 18+、Xcode。
2. 执行：

```bash
npm i
npm run dev
```

3. 打开：

- http://localhost:3030/health
- http://localhost:3030/devices
- http://localhost:3030/devices/<你的UDID>

前端先调 /devices 拿 UDID 列表，再把选中的 UDID 交给你现在的 Python 后端去建 Appium 会话即可。
