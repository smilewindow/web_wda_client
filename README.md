// 运行步骤：
// 1) 准备 WebDriverAgent（WDA）：
// - iPhone 打开「开发者模式」并信任电脑；USB 连接或同网段 Wi‑Fi。
// - 使用 Xcode 运行 WebDriverAgentRunner 到设备，确保 8100 可访问（或你现有的端口）。
// - 若你的 WDA 支持 MJPEG 服务器：POST /wda/mjpegserver/start 可启动 9100 端口的 MJPEG（见 server/main.py 中的 start_mjpeg()）。
//
// 2) 启动后端：
// cd server
// pip install -U fastapi "uvicorn[standard]" httpx pillow
// WDA_BASE=http://127.0.0.1:8100 MJPEG=http://127.0.0.1:9100 uvicorn main:app --reload --port 7000
// （变量说明）
// WDA_BASE = WDA 的根地址（含 8100）；
// MJPEG = MJPEG 服务地址（不少实现是 9100）。可仅填主机+端口，也可含路径：
//   例：http://127.0.0.1:9100 或 http://127.0.0.1:9100/stream.mjpeg 或 /mjpeg
//   后端会依次尝试: ""(原样)、/mjpeg、/mjpeg/、/mjpeg/0、/mjpeg/1、/stream.mjpeg、/video、/stream、/mjpegstream、/
//   注意：现已不再回退为连续截图模式，必须提供可用的 MJPEG 服务。
//
// 3) 启动前端（任选一种）：
// A. 简单：直接用静态服务器（例如：python -m http.server 8080）在 web 目录启动；
// B. 或者将 web/index.html 放到你已有的站点；
// 然后浏览器打开 http://localhost:8080 （或你的域名），默认会连接 http://localhost:7000 后端。
// 前端右下角“Appium 设置”提供：
// - 获取会话：在 Base 填 Appium 地址，点“获取会话”尝试读取现有会话（部分 Appium v2 返回空）。
// - 创建会话：填写 UDID，点“创建会话”用最小能力创建（默认 bundleId=com.apple.Preferences、noReset=true、wda=8100、mjpeg=9100、newCommandTimeout=0 永不超时）。
// - 读取设置：从 Appium 拉取当前 MJPEG 参数回填滑块。
// - 应用参数：动态设置 mjpegScalingFactor / mjpegServerFramerate / mjpegServerScreenshotQuality。
// - 保活：已移除前端保活逻辑；若以 appium:newCommandTimeout=0 创建会话，通常无需保活。

// ─────────────────────────────────────────────────────────────────────────────
// 额外说明：IPv6 与自适应
// ─────────────────────────────────────────────────────────────────────────────
// 1) IPv6 本机访问：若浏览器地址为 http://[::1]:8080，前端会自动为默认 API
//    加上方括号生成 http://[::1]:7000。也可手动指定：
//    例）http://localhost:8080/?api=http://127.0.0.1:7000 或 http://localhost:8080/?api=http://[::1]:7000
// 2) 画面自适应：前端已将流画面高度限制为窗口高度减去约 160px（为 HUD 与工具栏预留），
//    一般能完整显示整机画面。若仍超出，可自行在 web/index.html 调整该预留：
//      #stream { max-height: calc(100vh - 160px); }

// 后端 API 文档：见 server/API.md 或直接打开后端 /docs 交互式文档（例：http://127.0.0.1:7000/docs）。
// 示例与工具：
// - cURL: server/examples/curl-examples.sh（BASE=... bash 运行）
// - VS Code/IntelliJ HTTP: server/examples/wda.http
// - Postman: server/postman_collection.json（变量 baseUrl）
// - Insomnia: server/insomnia_export.json（环境变量 baseUrl）
