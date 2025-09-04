from typing import Any, Dict, List, Optional
import json

import httpx
import asyncio
from fastapi import APIRouter, WebSocket
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.websockets import WebSocketState, WebSocketDisconnect
from pydantic import BaseModel, Field

import core
from wda_utils import (
    ensure_session,
    get_window_size,
    get_screenshot_size,
    _wda_post_with_retry,
    _wda_actions,
    _jsonwp_touch_perform,
    NoWdaSession,
)

router = APIRouter()


def _is_safe_to_fallback(e: httpx.HTTPError) -> bool:
    try:
        # Fallback is safe for missing endpoints or invalid sessions that are re-created,
        # and for connection errors prior to sending the request. Not safe for read/write timeouts.
        if isinstance(e, httpx.HTTPStatusError):
            code = getattr(e.response, 'status_code', None)
            if code == 404:
                # Unknown endpoint / Unhandled endpoint / Invalid session id handled upstream
                return True
            return False
        # Connection not established → request not delivered
        if isinstance(e, (httpx.ConnectError, httpx.ConnectTimeout)):
            return True
        # Timeouts after sending are ambiguous; allow only if explicitly enabled
        if isinstance(e, (httpx.ReadTimeout, httpx.WriteTimeout, httpx.TimeoutException)):
            return bool(core.ALLOW_TIMEOUT_FALLBACK)
    except Exception:
        pass
    return False

async def _handle_tap(x: float, y: float) -> Dict[str, Any]:
    client = await core.get_http_client()
    sid = await ensure_session(client)

    async def do_wda():
        core.logger.info("tap try mode=wda endpoint=/wda/tap/0")
        r = await _wda_post_with_retry(client, sid, "/wda/tap/0", {"x": x, "y": y}, timeout=10)
        return r.json()

    async def do_actions():
        core.logger.info("tap try mode=actions endpoint=/actions")
        actions = [{
            "type": "pointer",
            "id": "finger1",
            "parameters": {"pointerType": "touch"},
            "actions": [
                {"type": "pointerMove", "duration": 0, "x": int(x), "y": int(y), "origin": "viewport"},
                {"type": "pointerDown", "button": 0},
                {"type": "pause", "duration": 50},
                {"type": "pointerUp", "button": 0}
            ]
        }]
        r = await _wda_actions(client, sid, actions, timeout=10)
        return r.json()

    async def do_jsonwp():
        core.logger.info("tap try mode=jsonwp endpoint=/touch/perform")
        actions_tw = [
            {"action": "press", "options": {"x": int(x), "y": int(y)}},
            {"action": "release", "options": {}}
        ]
        r = await _jsonwp_touch_perform(client, sid, actions_tw, timeout=10)
        return r.json()

    async def do_wda_drag():
        core.logger.info("tap try mode=wda endpoint=/wda/dragfromtoforduration (tap via drag)")
        r = await _wda_post_with_retry(client, sid, "/wda/dragfromtoforduration", {
            "fromX": float(x), "fromY": float(y),
            "toX": float(x),   "toY": float(y),
            "duration": 0.05,
        }, timeout=10)
        return r.json()

    # order per current mode; WDA tap impl preference respected
    wda_variants = (
        [(do_wda_drag, "wda_drag"), (do_wda, "wda")]
        if core.PREFERRED_WDA_TAP == "drag"
        else [(do_wda, "wda"), (do_wda_drag, "wda_drag")]
    )
    order_map = {
        "wda":    [*wda_variants, (do_actions, "actions"), (do_jsonwp, "jsonwp")],
        "actions":[(do_actions, "actions"), (do_jsonwp, "jsonwp"), *wda_variants],
        "jsonwp": [(do_jsonwp, "jsonwp"), (do_actions, "actions"), *wda_variants],
        "auto":   [*wda_variants, (do_actions, "actions"), (do_jsonwp, "jsonwp")],
    }
    order = order_map.get(core.CURRENT_MODE, order_map["auto"])

    last_exc = None
    for i, (fn, mode_name) in enumerate(order):
        try:
            if not core.ALLOW_FALLBACK and i > 0:
                break
            res = await fn()
            # Fix modes on first success
            if core.CURRENT_MODE == "auto":
                core.CURRENT_MODE = "wda" if mode_name.startswith("wda") else mode_name
                core.logger.info(f"control mode -> {core.CURRENT_MODE}")
            if core.PREFERRED_WDA_TAP == "auto" and mode_name in ("wda", "wda_drag"):
                core.PREFERRED_WDA_TAP = "drag" if mode_name == "wda_drag" else "tap0"
                core.logger.info(f"wda tap impl -> {core.PREFERRED_WDA_TAP}")
            return res
        except httpx.HTTPError as e:
            body = getattr(getattr(e, 'response', None), 'text', '') if getattr(e, 'response', None) is not None else ''
            code = getattr(getattr(e, 'response', None), 'status_code', None)
            core.logger.warning(f"tap {fn.__name__} failed: status={code} err={e} body={str(body)[:200]}")
            if not _is_safe_to_fallback(e):
                last_exc = e
                break
            last_exc = e
            continue
    if last_exc:
        raise last_exc
    raise RuntimeError("tap failed without explicit error")


# Request models
class Point(BaseModel):
    x: float
    y: float


class TapRequest(BaseModel):
    x: float
    y: float


class DragRequest(BaseModel):
    from_: Point = Field(..., alias="from")
    to: Point
    duration: float = 0.12

    class Config:
        allow_population_by_field_name = True


class LongPressRequest(BaseModel):
    x: float
    y: float
    duration: Optional[float] = None
    durationMs: Optional[float] = None


@router.get("/api/ping")
async def api_ping():
    try:
        client = await core.get_http_client()
        r = await client.get(f"{core.WDA_BASE}/status", timeout=5)
        r.raise_for_status()
        return {"ok": True, "wda": r.json()}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/api/device-info")
async def device_info(noShot: bool = False):
    try:
        client = await core.get_http_client()
        sid = await ensure_session(client)
        pts = await get_window_size(client)
        size_px = None
        # Skip /screenshot size if requested via query or globally through env
        if not (noShot or core.SKIP_SCREENSHOT_SIZE):
            try:
                pxw, pxh = await get_screenshot_size(client)
                size_px = {"w": pxw, "h": pxh}
            except Exception as _e:
                # Do not fail the whole request if screenshot sizing is unavailable
                core.logger.info(f"device-info: skip screenshot size due to: {_e}")
                size_px = None
        return {
            "sessionId": sid,
            "size_pt": {"w": pts[0], "h": pts[1]} if pts else None,
            "size_px": size_px,
        }
    except NoWdaSession as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    except httpx.HTTPError as e:
        return JSONResponse({"error": str(e)}, status_code=502)


@router.post("/api/control-mode")
async def api_control_mode(payload: Dict[str, Any]):
    mode = str(payload.get("mode", "")).strip().lower()
    mapping = {
        "wda": "wda",
        "appium": "actions",
        "actions": "actions",
        "jsonwp": "jsonwp",
        "auto": "auto",
    }
    if mode not in mapping:
        return JSONResponse({"error": f"invalid mode: {mode}"}, status_code=400)
    core.CURRENT_MODE = mapping[mode]
    core.logger.info(f"control mode set to {core.CURRENT_MODE}")
    return {"ok": True, "mode": mode, "current": core.CURRENT_MODE}


@router.post("/api/tap")
async def api_tap(payload: TapRequest):
    try:
        return await _handle_tap(float(payload.x), float(payload.y))
    except NoWdaSession as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    except httpx.HTTPError as e:
        return JSONResponse({"error": str(e)}, status_code=502)


@router.post("/api/pressButton")
async def api_press(payload: Dict[str, Any]):
    name = payload.get("name", "home")
    try:
        client = await core.get_http_client()
        sid = await ensure_session(client)
        r = await _wda_post_with_retry(client, sid, "/wda/pressButton", {"name": name}, timeout=10)
        return r.json()
    except NoWdaSession as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    except httpx.HTTPError as e:
        return JSONResponse({"error": str(e)}, status_code=502)


@router.post("/api/drag")
async def api_drag(payload: DragRequest):
    f = {"x": float(payload.from_.x), "y": float(payload.from_.y)}
    t = {"x": float(payload.to.x), "y": float(payload.to.y)}
    duration = float(payload.duration)
    try:
        client = await core.get_http_client()
        # Reuse the same fallback logic via a shared helper
        return await _perform_drag_with_fallback(client, f, t, duration)
    except NoWdaSession as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    except httpx.HTTPError as e:
        return JSONResponse({"error": str(e)}, status_code=502)


@router.post("/api/drag-pump")
async def api_drag_pump(payload: Dict[str, Any]):
    points: List[Dict[str, float]] = payload.get("points", [])
    seg_dur = float(payload.get("segDuration", 0.08))
    if len(points) < 2:
        return {"ok": True, "segments": 0}

    try:
        client = await core.get_http_client()
        sid = await ensure_session(client)
        for i in range(1, len(points)):
            a, b = points[i - 1], points[i]
            try:
                await _wda_post_with_retry(client, sid, "/wda/dragfromtoforduration", {
                    "fromX": float(a["x"]), "fromY": float(a["y"]),
                    "toX": float(b["x"]), "toY": float(b["y"]),
                    "duration": seg_dur,
                }, timeout=20)
            except httpx.HTTPStatusError as e:
                if e.response is not None and e.response.status_code == 404:
                    dur_ms = max(1, int(seg_dur * 1000))
                    actions = [{
                        "type": "pointer",
                        "id": "finger1",
                        "parameters": {"pointerType": "touch"},
                        "actions": [
                            {"type": "pointerMove", "duration": 0, "x": int(a["x"]), "y": int(a["y"]), "origin": "viewport"},
                            {"type": "pointerDown", "button": 0},
                            {"type": "pointerMove", "duration": dur_ms, "x": int(b["x"]), "y": int(b["y"]), "origin": "viewport"},
                            {"type": "pointerUp", "button": 0}
                        ]
                    }]
                    core.logger.info("drag-pump segment fallback to /actions")
                    try:
                        await _wda_actions(client, sid, actions, timeout=20)
                    except httpx.HTTPStatusError as e2:
                        if e2.response is not None and e2.response.status_code == 404:
                            core.logger.info("drag-pump segment fallback to JSONWP /touch/perform")
                            dx = int(b["x"] - a["x"])
                            dy = int(b["y"] - a["y"])
                            actions_tw = [
                                {"action": "press", "options": {"x": int(a["x"]), "y": int(a["y"]) }},
                                {"action": "moveTo", "options": {"x": dx, "y": dy}},
                                {"action": "release", "options": {}}
                            ]
                            await _jsonwp_touch_perform(client, sid, actions_tw, timeout=20)
                        else:
                            raise
                else:
                    raise
        return {"ok": True, "segments": len(points) - 1}
    except NoWdaSession as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    except httpx.HTTPError as e:
        return JSONResponse({"error": str(e)}, status_code=502)


# 一次性轨迹注入：将整条轨迹编成 W3C Actions（或 JSONWP）一次注入
@router.post("/api/drag-trace")
async def api_drag_trace(payload: Dict[str, Any]):
    points: List[Dict[str, float]] = payload.get("points", [])
    total_ms = int(float(payload.get("totalDurationMs", 0)) or 0)
    if len(points) < 2:
        return {"ok": True, "segments": 0}
    try:
        client = await core.get_http_client()
        sid = await ensure_session(client)
        # 构造 W3C Actions：pointerMove(0,to p0), pointerDown, then pointerMove(dt, to p1..pn), pointerUp
        moves: List[Dict[str, Any]] = []
        p0 = points[0]
        moves.append({"type": "pointerMove", "duration": 0, "x": int(p0["x"]), "y": int(p0["y"]), "origin": "viewport"})
        moves.append({"type": "pointerDown", "button": 0})
        # 计算每段时长：如未提供总时长，则用 16ms 近似
        if total_ms <= 0:
            dt = 16
            for i in range(1, len(points)):
                pi = points[i]
                moves.append({"type": "pointerMove", "duration": dt, "x": int(pi["x"]), "y": int(pi["y"]), "origin": "viewport"})
        else:
            # 平均分配每段时长；至少 1ms
            segs = max(1, len(points) - 1)
            dt = max(1, int(round(total_ms / segs)))
            for i in range(1, len(points)):
                pi = points[i]
                moves.append({"type": "pointerMove", "duration": dt, "x": int(pi["x"]), "y": int(pi["y"]), "origin": "viewport"})
        moves.append({"type": "pointerUp", "button": 0})

        actions = [{
            "type": "pointer",
            "id": "finger1",
            "parameters": {"pointerType": "touch"},
            "actions": moves,
        }]

        try:
            core.logger.info(f"drag-trace try mode=actions len={len(points)}")
            r = await _wda_actions(client, sid, actions, timeout=30)
            return r.json()
        except httpx.HTTPStatusError as e:
            if e.response is not None and e.response.status_code == 404:
                core.logger.info("drag-trace fallback to JSONWP /touch/perform")
                # JSONWP：press(p0) + moveTo(rel) ... + release
                actions_tw: List[Dict[str, Any]] = []
                actions_tw.append({"action": "press", "options": {"x": int(p0["x"]), "y": int(p0["y"]) }})
                prev = p0
                for i in range(1, len(points)):
                    pi = points[i]
                    dx = int(pi["x"] - prev["x"])
                    dy = int(pi["y"] - prev["y"])
                    actions_tw.append({"action": "moveTo", "options": {"x": dx, "y": dy}})
                    prev = pi
                actions_tw.append({"action": "release", "options": {}})
                r2 = await _jsonwp_touch_perform(client, sid, actions_tw, timeout=30)
                return r2.json()
            raise
    except NoWdaSession as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    except httpx.HTTPError as e:
        return JSONResponse({"error": str(e)}, status_code=502)

# Internal helper: perform a single drag segment with fallback (WDA → actions → JSONWP)
async def _perform_drag_with_fallback(client: httpx.AsyncClient, f: Dict[str, float], t: Dict[str, float], duration: float) -> Dict[str, Any]:
    sid = await ensure_session(client)

    async def do_wda():
        core.logger.info("drag try mode=wda endpoint=/wda/dragfromtoforduration")
        r = await _wda_post_with_retry(client, sid, "/wda/dragfromtoforduration", {
            "fromX": float(f["x"]), "fromY": float(f["y"]),
            "toX": float(t["x"]), "toY": float(t["y"]),
            "duration": float(duration),
        }, timeout=20)
        return r.json()

    async def do_actions():
        core.logger.info("drag try mode=actions endpoint=/actions")
        dur_ms = max(1, int(duration * 1000))
        actions = [{
            "type": "pointer",
            "id": "finger1",
            "parameters": {"pointerType": "touch"},
            "actions": [
                {"type": "pointerMove", "duration": 0, "x": int(f["x"]), "y": int(f["y"]), "origin": "viewport"},
                {"type": "pointerDown", "button": 0},
                {"type": "pointerMove", "duration": dur_ms, "x": int(t["x"]), "y": int(t["y"]), "origin": "viewport"},
                {"type": "pointerUp", "button": 0}
            ]
        }]
        r = await _wda_actions(client, sid, actions, timeout=20)
        return r.json()

    async def do_jsonwp():
        dx = int(t["x"] - f["x"])
        dy = int(t["y"] - f["y"])
        actions_tw = [
            {"action": "press", "options": {"x": int(f["x"]), "y": int(f["y"]) }},
            {"action": "moveTo", "options": {"x": dx, "y": dy}},
            {"action": "release", "options": {}}
        ]
        core.logger.info("drag try mode=jsonwp endpoint=/touch/perform")
        r = await _jsonwp_touch_perform(client, sid, actions_tw, timeout=20)
        return r.json()

    order_map = {
        "wda":    [(do_wda, "wda"), (do_actions, "actions"), (do_jsonwp, "jsonwp")],
        "actions":[(do_actions, "actions"), (do_jsonwp, "jsonwp"), (do_wda, "wda")],
        "jsonwp": [(do_jsonwp, "jsonwp"), (do_actions, "actions"), (do_wda, "wda")],
        "auto":   [(do_wda, "wda"), (do_actions, "actions"), (do_jsonwp, "jsonwp")],
    }
    order = order_map.get(core.CURRENT_MODE, order_map["auto"])

    last_exc: Optional[httpx.HTTPError] = None
    for i, (fn, mode_name) in enumerate(order):
        try:
            if not core.ALLOW_FALLBACK and i > 0:
                break
            res = await fn()
            if core.CURRENT_MODE == "auto":
                core.CURRENT_MODE = mode_name
                core.logger.info(f"control mode -> {core.CURRENT_MODE}")
            return res
        except httpx.HTTPError as e:
            body = getattr(getattr(e, 'response', None), 'text', '') if getattr(e, 'response', None) is not None else ''
            code = getattr(getattr(e, 'response', None), 'status_code', None)
            core.logger.warning(f"drag {_safe_name(fn)} failed: status={code} err={e} body={str(body)[:200]}")
            if not _is_safe_to_fallback(e):
                last_exc = e
                break
            last_exc = e
            continue
    if last_exc:
        raise last_exc
    raise RuntimeError("drag failed without explicit error")


def _safe_name(fn: Any) -> str:
    try:
        return getattr(fn, "__name__", str(fn))
    except Exception:
        return str(fn)


@router.get("/stream")
async def stream():
    if not core.MJPEG_URL:
        return JSONResponse({"error": "MJPEG not configured. Set env MJPEG=http://host:port[/path]"}, status_code=503)

    candidates = (
        "",
        "/mjpeg",
        "/mjpeg/",
        "/mjpeg/0",
        "/mjpeg/1",
        "/stream.mjpeg",
        "/video",
        "/stream",
        "/mjpegstream",
        "/",
    )
    chosen_url: Optional[str] = None
    chosen_ctype: Optional[str] = None
    last_err: Optional[Exception] = None

    client = await core.get_http_client()
    for path in candidates:
        url = f"{core.MJPEG_URL}{path}"
        try:
            async with client.stream("GET", url, timeout=None) as upstream:
                ctype = upstream.headers.get("Content-Type", "")
                if not ctype.lower().startswith("multipart/x-mixed-replace"):
                    continue
                chosen_url = url
                chosen_ctype = ctype
                break
        except Exception as e:
            last_err = e
            continue

    if not chosen_url or not chosen_ctype:
        msg = f"MJPEG connect failed for {core.MJPEG_URL}: {last_err}"
        core.logger.error(msg)
        return JSONResponse({"error": msg}, status_code=502)

    core.logger.info(f"MJPEG proxy connected: {chosen_url} ctype={chosen_ctype}")

    async def body():
        client2 = await core.get_http_client()
        async with client2.stream("GET", chosen_url, timeout=None) as upstream2:
            async for chunk in upstream2.aiter_raw():
                yield chunk

    return StreamingResponse(body(), headers={
        "Content-Type": chosen_ctype,
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache",
    })


@router.post("/api/mjpeg/start")
async def start_mjpeg():
    try:
        client = await core.get_http_client()
        sid = await ensure_session(client)
        try:
            r = await client.post(
                f"{core.WDA_BASE}/session/{sid}/wda/mjpegserver/start",
                json={"frameRate": 30, "screenshotQuality": 15}, timeout=15
            )
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as e:
            return JSONResponse({"error": str(e)}, status_code=500)
    except NoWdaSession as e:
        return JSONResponse({"error": str(e)}, status_code=503)


async def _handle_long_press(x: float, y: float, duration: float) -> Dict[str, Any]:
    client = await core.get_http_client()
    sid = await ensure_session(client)

    async def do_wda():
        # 用 dragfromtoforduration(from=to) 模拟长按
        return (await _wda_post_with_retry(client, sid, "/wda/dragfromtoforduration", {
            "fromX": x, "fromY": y,
            "toX": x,   "toY": y,
            "duration": duration,
        }, timeout=20)).json()

    async def do_actions():
        dur_ms = max(1, int(duration * 1000))
        actions = [{
            "type": "pointer",
            "id": "finger1",
            "parameters": {"pointerType": "touch"},
            "actions": [
                {"type": "pointerMove", "duration": 0, "x": int(x), "y": int(y), "origin": "viewport"},
                {"type": "pointerDown", "button": 0},
                {"type": "pause", "duration": dur_ms},
                {"type": "pointerUp", "button": 0}
            ]
        }]
        return (await _wda_actions(client, sid, actions, timeout=20)).json()

    async def do_jsonwp():
        actions_tw = [
            {"action": "press", "options": {"x": int(x), "y": int(y)}},
            {"action": "wait", "options": {"ms": max(1, int(duration * 1000))}},
            {"action": "release", "options": {}}
        ]
        return (await _jsonwp_touch_perform(client, sid, actions_tw, timeout=20)).json()

    order_map = {
        "wda":    [(do_wda, "wda"), (do_actions, "actions"), (do_jsonwp, "jsonwp")],
        "actions":[(do_actions, "actions"), (do_jsonwp, "jsonwp"), (do_wda, "wda")],
        "jsonwp": [(do_jsonwp, "jsonwp"), (do_actions, "actions"), (do_wda, "wda")],
        "auto":   [(do_wda, "wda"), (do_actions, "actions"), (do_jsonwp, "jsonwp")],
    }
    order = order_map.get(core.CURRENT_MODE, order_map["auto"])

    last_exc = None
    for i, (fn, _mode_name) in enumerate(order):
        try:
            if not core.ALLOW_FALLBACK and i > 0:
                break
            return await fn()
        except httpx.HTTPError as e:
            if not _is_safe_to_fallback(e):
                last_exc = e
                break
            last_exc = e
            continue
    if last_exc:
        raise last_exc
    return {"ok": True}


@router.post("/api/gestures/long-press")
async def api_long_press(payload: LongPressRequest):
    """长按。payload: { x: number, y: number, duration?: seconds, durationMs?: number }"""
    try:
        x = float(payload.x)
        y = float(payload.y)
    except Exception:
        return JSONResponse({"error": "x,y are required"}, status_code=400)

    dur = payload.duration
    if dur is None:
        dms = payload.durationMs
        if dms is not None:
            try:
                dur = float(dms) / 1000.0
            except Exception:
                dur = 0.6
        else:
            dur = 0.6
    duration = max(0.05, float(dur))

    try:
        return await _handle_long_press(x, y, duration)
    except NoWdaSession as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    except httpx.HTTPError as e:
        return JSONResponse({"error": str(e)}, status_code=502)


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    peer = f"{ws.client.host}:{ws.client.port}" if ws.client else "-"
    core.logger.info(f"WS connect from {peer}")

    try:
        while ws.client_state == WebSocketState.CONNECTED:
            try:
                msg = await ws.receive_text()
                data = json.loads(msg)
                cmd_type = data.get("type")
                payload = data.get("payload", {})
                core.logger.info(f"WS recv cmd={cmd_type} payload={payload}")

                if cmd_type == "tap":
                    await _handle_tap(float(payload["x"]), float(payload["y"]))
                
                elif cmd_type == "longPress":
                    dur_ms = payload.get("durationMs", 600)
                    duration_sec = max(0.05, float(dur_ms) / 1000.0)
                    await _handle_long_press(float(payload["x"]), float(payload["y"]), duration_sec)

                elif cmd_type == "drag":
                    f = {"x": float(payload["from"]["x"]), "y": float(payload["from"]["y"])}
                    t = {"x": float(payload["to"]["x"]), "y": float(payload["to"]["y"])}
                    duration = float(payload.get("duration", 0.12))
                    client = await core.get_http_client()
                    await _perform_drag_with_fallback(client, f, t, duration)

                elif cmd_type == "pressButton":
                    name = payload.get("name", "home")
                    client = await core.get_http_client()
                    sid = await ensure_session(client)
                    await _wda_post_with_retry(client, sid, "/wda/pressButton", {"name": name}, timeout=10)
                
                else:
                    core.logger.warning(f"WS unhandled command type: {cmd_type}")
                    continue

                # Acknowledge successful processing
                if ws.client_state == WebSocketState.CONNECTED:
                    await ws.send_text(json.dumps({"ok": True, "for_cmd": cmd_type}))

            except json.JSONDecodeError:
                core.logger.warning(f"WS received invalid JSON")
            except Exception as e:
                core.logger.error(f"WS error processing command: {e}")
                if ws.client_state == WebSocketState.CONNECTED:
                    try:
                        await ws.send_text(json.dumps({"ok": False, "error": str(e)}))
                    except Exception:
                        pass

    except WebSocketDisconnect:
        core.logger.info(f"WS disconnect from {peer}")
    except Exception as e:
        core.logger.error(f"WS connection failed for {peer}: {e}")
    finally:
        core.logger.info(f"WS closing for {peer}")
