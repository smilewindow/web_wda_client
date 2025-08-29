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
// MJPEG = WDA MJPEG 服务地址（很多 fork 是 9100）。若没有 MJPEG，可留空，后端会回退为轮询 /screenshot。
//
// 3) 启动前端（任选一种）：
// A. 简单：直接用静态服务器（例如：python -m http.server 8080）在 web 目录启动；
// B. 或者将 web/index.html 放到你已有的站点；
// 然后浏览器打开 http://localhost:8080 （或你的域名），默认会连接 http://localhost:7000 后端。
