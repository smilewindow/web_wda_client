# WDA Web Console — 后端接口文档

本后端基于 FastAPI，适配/代理 WebDriverAgent（WDA）以提供投屏与手势控制能力。

## 基本信息

- 基础地址: `http://<host>:7000`
- 文档入口: `GET /docs`（Swagger UI），`GET /redoc`，`GET /openapi.json`
- 认证: 无（默认允许 CORS，生产环境请收紧）

## 环境变量

- `WDA_BASE`（必填）: WDA 根地址（含端口）。示例: `http://127.0.0.1:8100`、`http://192.168.1.23:8100`
- `MJPEG`（可选）: WDA 的 MJPEG 服务地址（不少 fork 默认 `:9100`）。示例: `http://127.0.0.1:9100`
  - 说明：/stream 现要求可用的 MJPEG 源。未配置时 /stream 返回 503；连接失败时返回 502；不再回退为连续截图流。
- `CONTROL_MODE`（可选）: 触控控制策略，`auto|wda|actions|jsonwp`，默认 `auto`。
  - `auto`: 按顺序尝试，首次成功后固定为该策略。
  - 指定模式（如 `jsonwp`）时，优先使用该模式；若需严格只用此模式，可配合 `ALLOW_FALLBACK=false`。
- `ALLOW_FALLBACK`（可选）: 是否允许从首选策略回退，`true|false`，默认 `true`。
- `WDA_TAP_IMPL`（可选）: 在 `CONTROL_MODE=wda` 下控制点击实现，`auto|tap0|drag`，默认 `auto`。
  - `tap0`: 使用 `POST /wda/tap/0`
  - `drag`: 使用 `POST /wda/dragfromtoforduration`（from=to，短时拖动模拟点击）
  - `auto`: 首次成功后自动固化为其中一种；也可通过 `ALLOW_FALLBACK=false` 强制只用所选实现。
- `APPIUM_BASE`（可选）: Appium Server 基础地址（含端口、可含 basepath），如 `http://127.0.0.1:4723`。供 `/api/appium/settings` 作为默认 base 使用。
- `WDA_AUTO_CREATE`（可选）: 是否在无会话时由后端自行创建 WDA 会话。
  - 取值: `true|false|auto`，默认 `auto`。
  - `auto`: 若设置了 `APPIUM_BASE` 则不自动创建（避免与 Appium 争抢 WDA 会话），否则自动创建。
  - 建议: 使用 Appium 创建会话时，让本变量为 `auto/false`，避免互相抢占导致 Appium 的 WDA 会话失效。

## 数据类型

- `Point`: `{ "x": number, "y": number }`
  - 单位为设备逻辑坐标（pt）。若设备不支持 pt 查询，将按像素(px)近似，仍可用。

## REST 接口

### GET /api/ping

- 功能: 探测 WDA 可用性。
- 响应 200: `{ "ok": true, "wda": <WDA /status 返回> }`
- 响应 500: `{ "ok": false, "error": string }`

示例:

```bash
curl -s http://127.0.0.1:7000/api/ping
```

### GET /api/device-info

- 功能: 返回当前会话、设备 pt/px 尺寸。
- 响应 200:
  ```json
  {
    "sessionId": "...",
    "size_pt": { "w": 390, "h": 844 } | null,
    "size_px": { "w": 1170, "h": 2532 }
  }
  ```

### POST /api/tap

- 功能: 发送点击。
- 请求体: `{ "x": number, "y": number }`（`Point`）
- 响应: 透传 WDA 返回 JSON。
- 兼容性: 若 `POST /wda/tap/0` 返回 404，则后端自动回退为 W3C Actions 序列实现点击。
  进阶回退: 若 `/actions` 也 404，将再回退到 JSONWP `POST /touch/perform`（press+release）。

示例:

```bash
curl -X POST http://127.0.0.1:7000/api/tap \
  -H 'Content-Type: application/json' \
  -d '{"x":100,"y":200}'
```

### POST /api/pressButton

- 功能: 发送系统按键。
- 请求体: `{ "name": string }`
  - 常见取值: `home` | `volumeUp` | `volumeDown` | `lock` 等
- 响应: 透传 WDA 返回 JSON。

示例:

```bash
curl -X POST http://127.0.0.1:7000/api/pressButton \
  -H 'Content-Type: application/json' \
  -d '{"name":"home"}'
```

### POST /api/drag

- 功能: 一次性拖拽（直达）。
- 请求体:
  ```json
  {
    "from": { "x": 10, "y": 10 },
    "to":   { "x": 300, "y": 400 },
    "duration": 0.12
  }
  ```
- 响应: 透传 WDA 返回 JSON。
- 兼容性: 若 `POST /wda/dragfromtoforduration` 返回 404，则后端自动回退为 W3C Actions 序列实现拖拽。
  进阶回退: 若 `/actions` 也 404，将再回退到 JSONWP `POST /touch/perform`（press+moveTo+release，moveTo 为相对位移）。

### POST /api/drag-pump

- 功能: 分段拖拽（将轨迹拆为多段，跟手性更好）。
- 请求体:
  ```json
  {
    "points": [{"x":..,"y":..}, {"x":..,"y":..}, ...],
    "segDuration": 0.08
  }
  ```
- 响应 200: `{ "ok": true, "segments": <注入段数> }`
- 兼容性: 单段注入若 404，将对该段回退为 W3C Actions。

### POST /api/gestures/long-press

- 功能: 长按（坐标）。
- 请求体:
  ```json
  { "x": 120, "y": 340, "duration": 0.6 }
  // 或 { "x": 120, "y": 340, "durationMs": 600 }
  ```
- 行为: 优先使用 `POST /wda/dragfromtoforduration`（from=to，duration 为按住时长）；失败回退到 W3C Actions（pointerDown + pause + pointerUp），再回退 JSONWP touch/perform（press + wait + release）。
- 响应: 透传上游 JSON；无会话返回 503；上游不可达返回 502。

### POST /api/mjpeg/start

- 功能: 尝试通过 WDA 启动 MJPEG（仅部分 fork 支持）。
- 请求体（内置默认）: `{ "frameRate": 30, "screenshotQuality": 15 }`
- 响应: 透传 WDA 返回或 `{ "error": string }`（500）。

### GET /stream

- 功能: 仅代理 MJPEG 画面流。
- 要求: 必须设置 `MJPEG` 环境变量指向可用的 MJPEG 服务（可包含路径）。
- 行为:
  - 作为反向代理，原样透传上游 `Content-Type` 与 boundary。
  - 未配置返回 503；连接失败返回 502（不再回退为连续截图）。
- 响应头: `Content-Type: multipart/x-mixed-replace; boundary=...`

用法示例（HTML）:

```html
<img src="http://127.0.0.1:7000/stream" />
```

## WebSocket 协议

- 端点: `ws://<host>:7000/ws`
- 说明: 前端实时传输手势轨迹；服务端在 `drag-end` 时合并为分段拖拽注入。
- 消息格式（请求 → 响应）:
  - `{"type":"tap","x":100,"y":200}` → `{"ok":true}`
  - `{"type":"pressButton","name":"home"}` → `{"ok":true}`
  - `{"type":"drag-start","pt":Point}` → `{"ok":true}`
  - `{"type":"drag-move","pt":Point}` → `{"ok":true}`
  - `{"type":"drag-end","pt":Point,"segDuration":0.08}` → `{"ok":true}`

## Appium mobile: 命令代理

### POST /api/appium/exec-mobile

- 功能: 代理执行 Appium 的 `executeScript('mobile: ...', args)`。
- 请求体:
  ```json
  {
    "base": "http://127.0.0.1:4723",
    "sessionId": "<APPIUM_SESSION_ID>",
    "script": "mobile: swipe",
    "args": { "direction": "down" }
  }
  ```
- 行为: POST `{base}/session/{sessionId}/execute/sync`，body `{ script, args: [ ... ] }`（若 `args` 为对象则自动包成数组）。
- 响应: 透传 Appium 返回 JSON，或 `{ error, body }`（502）。

## Appium Settings 代理

### GET /api/appium/settings

- 功能: 代理 `GET {base}/session/{sessionId}/appium/settings`。
- 查询参数: `base`（可省略，默认 `APPIUM_BASE`）、`sessionId`（必填）。
- 响应: 透传 Appium 返回 JSON，或 `{ error, body }`。

### POST /api/appium/settings

- 功能: 代理 `POST {base}/session/{sessionId}/appium/settings`，设置 MJPEG 等参数。
- 请求体:
  ```json
  {
    "base": "http://127.0.0.1:4723",
    "sessionId": "<APPIUM_SESSION_ID>",
    "settings": {
      "mjpegScalingFactor": 60,
      "mjpegServerFramerate": 30,
      "mjpegServerScreenshotQuality": 15
    }
  }
  ```
- 响应: 透传 Appium 返回 JSON，或 `{ error, body }`。

## 错误与返回码

- 200: 请求成功。大多数控制指令透传 WDA 的返回结构。
- 400: 参数格式错误（少见）。
- 500: 上游 WDA 不可达、会话创建失败、或 MJPEG 启动失败等；返回 `{ "error": string }`。
- 502: MJPEG 上游连接失败（/stream）。
- 503: 未配置 MJPEG 环境变量导致 /stream 不可用。
- 注: 服务会在检测到 404（多为 session 失效）时自动重建会话并重试一次。

## 注意事项

- 坐标映射: 建议使用设备 pt 尺寸（`/api/device-info` 的 `size_pt`）。若为 `null`，则以像素近似映射。
- CORS: 开发期默认放开 `allow_origins: ["*"]`，生产请按需限制。
- 文档: 访问 `GET /docs` 可交互式调试上述接口。

## 示例与工具

- cURL 脚本: `server/examples/curl-examples.sh`
  - 使用: `BASE=http://127.0.0.1:7000 bash server/examples/curl-examples.sh`
- VS Code/IntelliJ `.http`: `server/examples/wda.http`
  - 直接在编辑器内逐条发送。
- Postman 集合: `server/postman_collection.json`
  - 导入后设置变量 `baseUrl`（默认 `http://127.0.0.1:7000`）。
- Insomnia 导出: `server/insomnia_export.json`
  - 导入后在环境中修改 `baseUrl`。

## Appium Sessions/创建

### GET /api/appium/sessions

- 功能: 代理 `GET {base}/sessions`，用于尝试发现现有 Appium 会话（部分 Appium v2 会返回 404，此时返回空列表）。
- 查询参数: `base`（可省略，默认 `APPIUM_BASE`）。
- 响应: `{ "sessions": ["sid1", "sid2", ...] }`

### GET /api/appium/last-session

- 功能: 返回最近一次通过本服务创建的 Appium 会话 ID，并校验是否仍存在。
- 查询参数: `base`（可省略，默认 `APPIUM_BASE`）。
- 响应: `{ "sessionId": string|null, "ok": boolean }`

### POST /api/appium/create

- 功能: 代理 `POST {base}/session` 创建会话。
- 请求体:
  ```json
  {
    "base": "http://127.0.0.1:4723",
    "udid": "<DEVICE_UDID>",
    "wdaLocalPort": 8100,
    "mjpegServerPort": 9100,
    "bundleId": "com.apple.Preferences",
    "noReset": true
  }
  ```
- 响应: `{ "sessionId": "...", "capabilities": { ... } }` 或 `{ error, body }`。
### POST /api/drag-trace

- 功能: 一次性轨迹注入（将整条轨迹编为 W3C Actions）。
- 请求体:
  ```json
  {
    "points": [{"x":..,"y":..}, ...],
    "totalDurationMs": 0
  }
  ```
  - `totalDurationMs` 可选；不提供时按每段约 16ms 平均分配。
- 行为: 优先 `POST /actions`（W3C pointer 序列），404 回退 JSONWP `POST /touch/perform`（press + moveTo... + release）。
- 响应: 透传上游 JSON。
