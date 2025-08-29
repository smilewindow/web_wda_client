import os
import base64
import json
from typing import AsyncIterator, List, Dict, Any, Optional, Tuple

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from starlette.websockets import WebSocketState
from PIL import Image
from io import BytesIO

# ─────────────────────────────────────────────────────────────────────────────
# 环境变量
#   WDA_BASE : WDA 根地址（含端口），例如 http://127.0.0.1:8100 或 http://192.168.1.23:8100
#   MJPEG    : （可选）WDA 的 MJPEG 地址（不少 fork 在 9100），例如 http://127.0.0.1:9100
# ─────────────────────────────────────────────────────────────────────────────

WDA_BASE = os.environ.get("WDA_BASE", "http://127.0.0.1:8100").rstrip("/")
MJPEG_URL = os.environ.get("MJPEG", "").rstrip("/")

# 维护一个全局 session id，必要时自动创建
SESSION_ID: Optional[str] = None

app = FastAPI(title="WDA-Web Console", version="1.0")

# 允许跨域调试（生产环境请按需收紧）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# 内部工具函数
# ─────────────────────────────────────────────────────────────────────────────

async def ensure_session(client: httpx.AsyncClient) -> str:
    """复用或创建一个 WDA 会话，返回 sessionId。"""
    global SESSION_ID

    # 已缓存则先尝试返回（也可在此添加一次轻量校验 /status）
    if SESSION_ID:
        return SESSION_ID

    # 1) 尝试读取现有 sessions
    try:
        r = await client.get(f"{WDA_BASE}/sessions", timeout=5)
        r.raise_for_status()
        sessions = r.json().get("value", [])
        if isinstance(sessions, list) and sessions:
            sid = sessions[-1].get("id") or sessions[-1].get("sessionId")
            if sid:
                SESSION_ID = sid
                return SESSION_ID
    except Exception:
        pass

    # 2) 创建新 session（最小 capabilities；按需补充）
    caps = {"capabilities": {}}
    r = await client.post(f"{WDA_BASE}/session", json=caps, timeout=20)
    r.raise_for_status()
    val = r.json().get("value", {})
    sid = val.get("sessionId") or val.get("id")
    if not sid:
        # 一些实现把 sessionId 放在顶层 value 外
        sid = r.json().get("sessionId")
    if not sid:
        raise RuntimeError("Failed to obtain WDA sessionId")
    SESSION_ID = sid
    return SESSION_ID


async def get_window_size(client: httpx.AsyncClient) -> Optional[Tuple[int, int]]:
    """尝试获取逻辑坐标（pt）。不支持则返回 None。"""
    sid = await ensure_session(client)
    try:
        r = await client.get(f"{WDA_BASE}/session/{sid}/window/size", timeout=5)
        r.raise_for_status()
        v = r.json().get("value", {})
        w, h = int(v.get("width", 0)), int(v.get("height", 0))
        if w and h:
            return w, h
    except Exception:
        return None
    return None


async def get_screenshot_size(client: httpx.AsyncClient) -> Tuple[int, int]:
    """获取 /screenshot 的像素尺寸（w_px, h_px）。"""
    sid = await ensure_session(client)
    r = await client.get(f"{WDA_BASE}/session/{sid}/screenshot", timeout=20)
    r.raise_for_status()
    b64 = r.json().get("value")
    img = Image.open(BytesIO(base64.b64decode(b64)))
    return img.size  # (w_px, h_px)


# ─────────────────────────────────────────────────────────────────────────────
# API 路由
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/ping")
async def api_ping():
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{WDA_BASE}/status", timeout=5)
            r.raise_for_status()
            return {"ok": True, "wda": r.json()}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.get("/api/device-info")
async def device_info():
    async with httpx.AsyncClient() as client:
        sid = await ensure_session(client)
        pts = await get_window_size(client)
        pxw, pxh = await get_screenshot_size(client)
        return {
            "sessionId": sid,
            "size_pt": {"w": pts[0], "h": pts[1]} if pts else None,
            "size_px": {"w": pxw, "h": pxh},
        }


@app.post("/api/tap")
async def api_tap(payload: Dict[str, Any]):
    x, y = float(payload["x"]), float(payload["y"])
    async with httpx.AsyncClient() as client:
        sid = await ensure_session(client)
        r = await client.post(
            f"{WDA_BASE}/session/{sid}/wda/tap/0",
            json={"x": x, "y": y}, timeout=10
        )
        r.raise_for_status()
        return r.json()


@app.post("/api/pressButton")
async def api_press(payload: Dict[str, Any]):
    # name: home / volumeUp / volumeDown / lock 等
    name = payload.get("name", "home")
    async with httpx.AsyncClient() as client:
        sid = await ensure_session(client)
        r = await client.post(
            f"{WDA_BASE}/session/{sid}/wda/pressButton",
            json={"name": name}, timeout=10
        )
        r.raise_for_status()
        return r.json()


@app.post("/api/drag")
async def api_drag(payload: Dict[str, Any]):
    """一次性拖拽。payload: { from: {x,y}, to: {x,y}, duration: 0.12 }"""
    f, t = payload.get("from"), payload.get("to")
    duration = float(payload.get("duration", 0.12))
    async with httpx.AsyncClient() as client:
        sid = await ensure_session(client)
        r = await client.post(
            f"{WDA_BASE}/session/{sid}/wda/dragfromtoforduration",
            json={
                "fromX": float(f["x"]), "fromY": float(f["y"]),
                "toX": float(t["x"]), "toY": float(t["y"]),
                "duration": duration,
            }, timeout=20
        )
        r.raise_for_status()
        return r.json()


@app.post("/api/drag-pump")
async def api_drag_pump(payload: Dict[str, Any]):
    """分段拖拽：沿 points 逐段注入，跟手性更好。
    payload: { points: [{x,y}, ...], segDuration: 0.08 }
    """
    points: List[Dict[str, float]] = payload.get("points", [])
    seg_dur = float(payload.get("segDuration", 0.08))
    if len(points) < 2:
        return {"ok": True, "segments": 0}

    async with httpx.AsyncClient() as client:
        sid = await ensure_session(client)
        for i in range(1, len(points)):
            a, b = points[i - 1], points[i]
            r = await client.post(
                f"{WDA_BASE}/session/{sid}/wda/dragfromtoforduration",
                json={
                    "fromX": float(a["x"]), "fromY": float(a["y"]),
                    "toX": float(b["x"]), "toY": float(b["y"]),
                    "duration": seg_dur,
                }, timeout=20
            )
            r.raise_for_status()
    return {"ok": True, "segments": len(points) - 1}


@app.get("/stream")
async def stream():
    """MJPEG 代理；若未配置 MJPEG，则回退为连续截图的 multipart 流。"""
    if MJPEG_URL:
        async with httpx.AsyncClient() as client:
            # 依次尝试常见路径
            for path in ("/mjpegstream", "/stream", "/"):
                try:
                    # 直接 GET，上游会返回带 boundary 的 Content-Type
                    upstream = await client.stream("GET", f"{MJPEG_URL}{path}", timeout=None)
                    # 拿到上游头里的 Content-Type，原样透传
                    ctype = upstream.headers.get(
                        "Content-Type",
                        "multipart/x-mixed-replace; boundary=--BoundaryString",
                    )

                    async def body():
                        async for chunk in upstream.aiter_raw():
                            yield chunk

                    # 关键：不要手写 boundary，使用上游的 Content-Type
                    return StreamingResponse(body(), headers={
                        "Content-Type": ctype,
                        "Cache-Control": "no-cache, no-store",
                        "Pragma": "no-cache",
                    })
                except Exception:
                    continue

    # 回退：轮询 /screenshot，统一转成 JPEG（更稳更省带宽）
    boundary = "frame"

    async def poller() -> AsyncIterator[bytes]:
        async with httpx.AsyncClient() as client:
            sid = await ensure_session(client)
            while True:
                r = await client.get(f"{WDA_BASE}/session/{sid}/screenshot", timeout=20)
                v = r.json().get("value")
                raw = base64.b64decode(v)
                img = Image.open(BytesIO(raw)).convert("RGB")
                buf = BytesIO()
                img.save(buf, format="JPEG", quality=60, optimize=True)
                jpg = buf.getvalue()
                yield (
                    f"--{boundary}\r\n"
                    f"Content-Type: image/jpeg\r\n"
                    f"Content-Length: {len(jpg)}\r\n\r\n".encode("ascii")
                    + jpg + b"\r\n"
                )

    return StreamingResponse(
        poller(), media_type=f"multipart/x-mixed-replace; boundary={boundary}"
    )


@app.post("/api/mjpeg/start")
async def start_mjpeg():
    """尝试通过 WDA 启动 MJPEG 服务器（若 fork 支持）。"""
    async with httpx.AsyncClient() as client:
        sid = await ensure_session(client)
        try:
            r = await client.post(
                f"{WDA_BASE}/session/{sid}/wda/mjpegserver/start",
                json={
                    "frameRate": 30,          # 调整 20~60
                    "screenshotQuality": 15,  # 10~30 越低越糊但更省带宽
                }, timeout=15
            )
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as e:
            return JSONResponse({"error": str(e)}, status_code=500)


# WebSocket：前端实时传手势，这里做缓冲后一次性分段注入
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    async with httpx.AsyncClient() as client:
        _ = await ensure_session(client)

    buffer: List[Dict[str, float]] = []
    try:
        while True:
            msg = await ws.receive_text()
            data = json.loads(msg)
            t = data.get("type")
            if t == "tap":
                await api_tap({"x": data["x"], "y": data["y"]})
            elif t == "pressButton":
                await api_press({"name": data.get("name", "home")})
            elif t == "drag-start":
                buffer = [data["pt"]]
            elif t == "drag-move":
                buffer.append(data["pt"])  # 缓存轨迹
            elif t == "drag-end":
                buffer.append(data["pt"])  # 最后一点
                await api_drag_pump({"points": buffer, "segDuration": data.get("segDuration", 0.08)})
                buffer = []
            # 简单 ack
            if ws.client_state == WebSocketState.CONNECTED:
                await ws.send_text("{\"ok\":true}")
    except WebSocketDisconnect:
        if ws.client_state != WebSocketState.DISCONNECTED:
            await ws.close()

