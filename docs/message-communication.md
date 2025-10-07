# 前端-后端-WebSocket 消息通信指南

## 1. 通信拓扑速览
- **web-vue 前端**（`web-vue/src`）：通过 `services/wsProxy.js` 管理 WebSocket 连接，对业务层暴露 `wsProxy.send(type, payload)`；各组合式函数在 UI 操作时发送消息。
- **WebSocket 网桥**（`websocket/server.py`）：统一收敛所有前端连接，并维护单一后端通道；负责路由消息、关联请求 ID、在后端掉线时广播告警。
- **FastAPI 后端**（`server/`）：业务 API 的来源地，同时运行 `ws_proxy_client.py` 作为 WebSocket 客户端；收到网桥消息后再回调本地 HTTP 路由（`/api/*`）。
- **下游服务**：Appium、设备发现服务等由 FastAPI 路由继续代理，形成完整链路。

```
前端 (web-vue)
   │  JSON 消息
   ▼
WebSocket 网桥 (websocket/server.py)
   │  JSON 消息
   ▼
后端 WS 客户端 (server/ws_proxy_client.py)
   │  HTTP 请求
   ▼
FastAPI 路由 (server/routes/*)
   │  驱动/外部服务
   ▼
Appium / 设备发现等
```

## 2. 连接与握手流程
1. **后端启动**：`server/main.py` 在 FastAPI `startup` 时调用 `ws_proxy_client.start()`，连接 `WS_PROXY_URL`（默认 `ws://127.0.0.1:8765`）。
2. **握手报文**：双方遵循 `system.*` 控制消息格式：
   - 网桥接受连接后先返回 `system.welcome`（含 `clientId`）。
   - 前端 `wsProxy` 在 `onopen` 时发出 `system.hello`，载荷 `{ role: 'frontend' }`。
   - 后端客户端在 `_on_open` 时发出 `system.hello`（角色 `backend`）。
   - 网桥确认后回复 `system.hello`（`ok: true`），并将后端连接标记为 `BACKEND_CONN`。
3. **健康检测**：后端客户端每 `PING_INTERVAL`（默认 30s）发送 `system.ping`，网桥回 `system.pong`；前端当前不发送自定义 ping，断线由浏览器事件触发。
4. **掉线广播**：当后端连接断开时，网桥会向所有仍在线的前端推送 `system.backend.disconnected`，并将挂起请求全部以 `backend_disconnected` 错误结束。

## 3. 请求-响应生命周期
- 前端通过 `wsProxy.send(type, payload, options)` 产生唯一 `id`，把消息放入待发送队列；若连接未打开，会触发重连并在连通后发送。
- 网桥校验 `type` 是否在 `MESSAGE_ROUTES`。若后端未连通或者类型未知，立即回送错误响应。
- 合法请求会被附带同一 `id` 转发给后端客户端，同时在 `PENDING` 中记录前端套接字。
- 后端客户端在 `_handle_proxy_request` 中查找同名路由，按声明的 HTTP 方法调用 FastAPI 本地接口：
  - `GET` 请求将 `payload` 作为查询参数。
  - `POST` 请求将 `payload` 作为 JSON 请求体（非对象时保持原样）。

  
- FastAPI 路由返回后端结果；客户端封装统一响应：
  ```json
  {
    "id": "msg-...",
    "type": "appium.session.create",
    "ok": true,
    "status": 200,
    "data": { ... }   // 或者失败时 "error": {...}
  }
  ```
- 网桥依据 `id` 找到原前端连接并转发响应；前端 `wsProxy` 匹配 `pending` Promise，清理定时器后解析结果。

## 4. 业务消息映射
| 消息类型 | HTTP 方法 | FastAPI 路径 | 主要职责 | 典型数据结构 |
| --- | --- | --- | --- | --- |
| `device.info` | GET | `/api/device-info` (`routes/misc.py`) | 获取当前 Appium 会话的窗口尺寸和截图尺寸 | `{ sessionId, size_pt: {w,h}, size_px: {w,h} }` |
| `appium.session.create` | POST | `/api/appium/create` (`routes/appium_proxy.py`) | 以固定 capability 模板创建 Appium 会话并触发流媒体启动 | 成功返回 `{ sessionId, capabilities: null }`，失败时 `error` |
| `appium.settings.fetch` | GET | `/api/appium/settings` | 拉取 Session 级 MJPEG 设置；410 代表会话失效 | `{ value: { mjpegScalingFactor, ... } }` |
| `appium.settings.apply` | POST | `/api/appium/settings` | 更新 MJPEG 相关设置；返回 `{ value: {...} }` 或 410 | 同上 |
| `appium.exec.mobile` | POST | `/api/appium/exec-mobile` | 代理 `mobile:` 系列脚本，内含自动重建会话逻辑 | `{ value: any, sessionId?, recreated? }` |
| `appium.actions.execute` | POST | `/api/appium/actions` | 直接转发 W3C Actions | 成功时透传 Appium 响应；410 时附带 `SESSION_GONE` 信息 |
| `discovery.devices.list` | GET | `/api/discovery/devices` (`routes/discovery_proxy.py`) | 通过 HTTP 代理转发到设备发现服务 | `{ devices: [...] }` |

> 需要新增消息时，需在 *两处* 同步维护：`websocket/server.py` 与 `server/ws_proxy_client.py` 的 `MESSAGE_ROUTES`。

## 5. 错误、超时与重试
- **前端超时**：`wsProxy` 默认 60s 超时，并针对长耗时操作设定上限（如 `appium.session.create` 240s）。超时会触发 Promise 拒绝和错误 toast。
- **连接故障**：浏览器 `onclose` 会触发状态变更为 `closed`，全部挂起请求以 `WebSocket connection closed` 失败，并按 1.5s 指数退避重连至 15s。
- **后端错误映射**：FastAPI 返回非 2xx 被视为 `ok: false`，其 `body` 填入 `error` 字段。常见业务含义：
  - 410：会话失效。前端会清理缓存 SessionId 并提示重建。
  - 503：服务未配置或下游不可达，例如 Appium 未启动、设备发现服务缺失。
  - 5xx：接口内部异常，前端 toast 原始错误消息。
- **自动自愈**：`useGestures` 在收到 410 时会尝试调用 `appium.session.create` 重建会话后重试原请求。

## 6. 前端调用入口速查
- `useAppiumSession` (`web-vue/src/composables/useAppiumSession.js`)
  - 创建/刷新会话、同步 MJPEG 设置，对应 `appium.session.create` 与 `appium.settings.*`。
- `useGestures` (`web-vue/src/composables/useGestures.js`)
  - 点击、滑动、W3C Actions 与 `mobile:` 脚本；大量使用 `appium.exec.mobile` 和 `appium.actions.execute`。
- `useStreamControls` (`web-vue/src/composables/useStreamControls.js`)
  - 维护 WebSocket 地址配置，调用 `wsProxy.setUrl()` 并触发 `wsProxy.ensureConnection()`。
- `App.vue` 直接触发的请求：
  - `fetchDeviceInfo()` → `device.info`
  - `refreshDiscoveryDevices()` → `discovery.devices.list`

## 7. 环境变量与配置
| 组件 | 变量 | 默认值 / 作用 |
| --- | --- | --- |
| 前端 (`wsProxy.js`) | `VITE_DEFAULT_WS_URL`；URL 查询 `?ws=...`、`?ws_host=...&ws_port=` | 解析初始 WebSocket 地址，支持运行时覆盖 |
| 网桥 (`websocket/server.py`) | `WS_HOST=0.0.0.0`、`WS_PORT=8765` | 指定监听地址和端口 |
| 后端客户端 (`ws_proxy_client.py`) | `WS_PROXY_URL` / `WS_URL` / `DEFAULT_WS_URL` | 选择要连接的网桥地址 |
|  | `WS_PROXY_PING_INTERVAL=30`、`WS_PROXY_PING_TIMEOUT=10` | 控制心跳频率与超时时间 |
|  | `WS_PROXY_RECONNECT_BASE=1.5`、`WS_PROXY_RECONNECT_MAX=20` | 控制重连退避 |
|  | `WS_BACKEND_HTTP_BASE=http://127.0.0.1:7070` | 转发 HTTP 请求的后端基址 |

## 8. 扩展与调试建议
- **新增业务消息**：
  1. 在网桥 `MESSAGE_ROUTES` 和后端客户端映射表中声明类型和目标 API。
  2. 在 FastAPI 中实现对应路由，返回结构遵循现有 `{ ... }` 格式；必要时更新前端调用点。
- **排查问题**：
  - 启用 `websocket/server.py` 的日志可看到前端消息轨迹与错误。
  - FastAPI `access_log` 中会记录 `/api/*` 请求与响应体，便于追踪。
  - 前端开发模式下可在浏览器控制台访问 `window.WSProxy` 获取连接状态、发送测试消息。
- **保持 DRY**：若新增消息与现有接口类似，优先复用 FastAPI 路由层逻辑，而不是在 WebSocket 客户端内直接实现。

## 9. 常见故障路径
- **后端未连接网桥**：前端请求立即收到 `backend_unavailable`；检查后端环境变量或启动顺序。
- **Appium 会话丢失**：消息返回 410，前端会自动清理 SessionId 并提示重建；如需自动化恢复，可参考 `useGestures` 的自愈逻辑。
- **设备发现服务不可达**：`discovery.devices.list` 返回 502，`routes/discovery_proxy.py` 日志会提示 `DEVICE_DISCOVERY_BASE 未配置` 或上游报错。

以上文档覆盖当前实现中的所有 WebSocket 消息交互路径，可作为排障和扩展的基线。
