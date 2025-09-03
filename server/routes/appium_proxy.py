from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

import core

router = APIRouter()


@router.post("/api/appium/settings")
async def api_appium_set(payload: Dict[str, Any]):
    base = (payload.get("base") or core.APPIUM_BASE).rstrip("/") if (payload.get("base") or core.APPIUM_BASE) else None
    sid = payload.get("sessionId")
    settings = payload.get("settings", {})
    if not base or not sid or not isinstance(settings, dict):
        return JSONResponse({"error": "base, sessionId, settings are required"}, status_code=400)
    url = f"{base}/session/{sid}/appium/settings"
    client = await core.get_http_client()
    try:
        r = await client.post(url, json={"settings": settings}, timeout=15)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        body = getattr(e.response, 'text', '') if getattr(e, 'response', None) is not None else ''
        return JSONResponse({"error": str(e), "body": body}, status_code=502)


@router.get("/api/appium/settings")
async def api_appium_get(base: Optional[str] = None, sessionId: Optional[str] = None):
    b = (base or core.APPIUM_BASE).rstrip("/") if (base or core.APPIUM_BASE) else None
    sid = sessionId
    if not b or not sid:
        return JSONResponse({"error": "query params base and sessionId are required"}, status_code=400)
    url = f"{b}/session/{sid}/appium/settings"
    client = await core.get_http_client()
    try:
        r = await client.get(url, timeout=10)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        body = getattr(e.response, 'text', '') if getattr(e, 'response', None) is not None else ''
        return JSONResponse({"error": str(e), "body": body}, status_code=502)


@router.get("/api/appium/sessions")
async def api_appium_sessions(base: Optional[str] = None):
    b = (base or core.APPIUM_BASE).rstrip("/") if (base or core.APPIUM_BASE) else None
    if not b:
        return JSONResponse({"error": "query param base is required or set APPIUM_BASE"}, status_code=400)
    url = f"{b}/sessions"
    client = await core.get_http_client()
    try:
        r = await client.get(url, timeout=10)
        if r.status_code == 404:
            return {"sessions": []}
        r.raise_for_status()
        data = r.json()
        val = data.get("value") or {}
        sessions = val.get("sessions") or (val if isinstance(val, list) else [])
        ids = []
        for s in sessions:
            sid = s.get("id") or s.get("sessionId")
            if sid:
                ids.append(sid)
        return {"sessions": ids}
    except httpx.HTTPError as e:
        body = getattr(e.response, 'text', '') if getattr(e, 'response', None) is not None else ''
        core.logger.warning(f"appium sessions GET failed: url={url} err={e} body={str(body)[:200]}")
        return JSONResponse({"error": str(e), "body": body}, status_code=502)


@router.post("/api/appium/create")
async def api_appium_create(payload: Dict[str, Any]):
    base = (payload.get("base") or core.APPIUM_BASE).rstrip("/") if (payload.get("base") or core.APPIUM_BASE) else None
    udid = payload.get("udid")
    wda_port = int(payload.get("wdaLocalPort", 8100))
    mjpeg_port = int(payload.get("mjpegServerPort", 9100))
    bundle_id = payload.get("bundleId")
    no_reset = payload.get("noReset")
    new_cmd_to = payload.get("newCommandTimeout", 0)
    extra_caps = payload.get("extraCaps", {})
    if not base or not udid:
        return JSONResponse({"error": "base and udid are required"}, status_code=400)
    caps: Dict[str, Any] = {
        "platformName": "iOS",
        "appium:automationName": "XCUITest",
        "appium:udid": udid,
        "appium:wdaLocalPort": wda_port,
        "appium:mjpegServerPort": mjpeg_port,
        "appium:newCommandTimeout": int(new_cmd_to) if new_cmd_to is not None else 0,
    }
    # Merge any extra capabilities provided by client
    if isinstance(extra_caps, dict):
        try:
            caps.update(extra_caps)
        except Exception:
            pass
    if bundle_id:
        caps["appium:bundleId"] = bundle_id
    if no_reset is not None:
        caps["appium:noReset"] = bool(no_reset)
    payload_caps = {"capabilities": {"firstMatch": [caps]}}
    url = f"{base}/session"
    client = await core.get_http_client()
    try:
        r = await client.post(url, json=payload_caps, timeout=60)
        r.raise_for_status()
        j = r.json()
        val = j.get("value", {})
        sid = val.get("sessionId") or j.get("sessionId") or val.get("id")
        if not sid:
            return JSONResponse({"error": "no sessionId in response", "resp": j}, status_code=502)
        try:
            core.APPIUM_LATEST[base] = sid
        except Exception:
            pass
        return {"sessionId": sid, "capabilities": val.get("capabilities")}
    except httpx.HTTPError as e:
        body = getattr(e.response, 'text', '') if getattr(e, 'response', None) is not None else ''
        return JSONResponse({"error": str(e), "body": body}, status_code=502)


@router.get("/api/appium/last-session")
async def api_appium_last_session(base: Optional[str] = None):
    b = (base or core.APPIUM_BASE).rstrip("/") if (base or core.APPIUM_BASE) else None
    if not b:
        return JSONResponse({"error": "query param base is required or set APPIUM_BASE"}, status_code=400)
    sid = core.APPIUM_LATEST.get(b)
    if not sid:
        return {"sessionId": None, "ok": False}
    url = f"{b}/session/{sid}"
    client = await core.get_http_client()
    try:
        r = await client.get(url, timeout=8)
        if r.status_code == 200:
            return {"sessionId": sid, "ok": True}
    except Exception:
        pass
    try:
        del core.APPIUM_LATEST[b]
    except Exception:
        pass
    return {"sessionId": None, "ok": False}


@router.post("/api/appium/exec-mobile")
async def api_appium_exec_mobile(payload: Dict[str, Any]):
    """代理执行 Appium 的 mobile: 命令。
    请求体示例：
    {
      "base": "http://127.0.0.1:4723",
      "sessionId": "<APPIUM_SESSION_ID>",
      "script": "mobile: swipe",
      "args": { "direction": "down" } | [ ... ]
    }
    """
    b = (payload.get("base") or core.APPIUM_BASE).rstrip("/") if (payload.get("base") or core.APPIUM_BASE) else None
    sid = payload.get("sessionId")
    script = payload.get("script")
    args = payload.get("args")
    if not b or not sid or not isinstance(script, str):
        return JSONResponse({"error": "base, sessionId, script are required"}, status_code=400)
    if isinstance(args, list):
        args_arr = args
    elif isinstance(args, dict) or args is None:
        args_arr = [args or {}]
    else:
        return JSONResponse({"error": "args must be an object or array"}, status_code=400)

    url = f"{b}/session/{sid}/execute/sync"
    body = {"script": script, "args": args_arr}
    client = await core.get_http_client()
    try:
        r = await client.post(url, json=body, timeout=30)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        body_text = getattr(e.response, 'text', '') if getattr(e, 'response', None) is not None else ''
        core.logger.warning(f"appium exec-mobile failed: url={url} script={script} err={e} body={str(body_text)[:200]}")
        return JSONResponse({"error": str(e), "body": body_text}, status_code=502)
