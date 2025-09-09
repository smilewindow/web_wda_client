from typing import Any, Dict, Optional, Tuple

import asyncio
import base64
from io import BytesIO

import httpx
from PIL import Image
from fastapi import APIRouter
from fastapi.responses import JSONResponse

import core

router = APIRouter()


async def _adopt_or_create_session(client: httpx.AsyncClient) -> str:
    """Adopt existing WDA session if possible; create only if allowed by env."""
    # Try existing sessions
    try:
        r = await client.get(f"{core.WDA_BASE}/sessions", timeout=5)
        r.raise_for_status()
        sessions = r.json().get("value", [])
        if isinstance(sessions, list) and sessions:
            sid = sessions[-1].get("id") or sessions[-1].get("sessionId")
            if sid:
                return sid
    except Exception:
        pass

    # Some WDA builds expose sessionId via /status; adopt if valid
    try:
        for _ in range(15):
            try:
                rs = await client.get(f"{core.WDA_BASE}/status", timeout=5)
                rs.raise_for_status()
                js = rs.json() or {}
                sid = js.get("sessionId") or (js.get("value") or {}).get("sessionId")
                if sid:
                    rv = await client.get(f"{core.WDA_BASE}/session/{sid}", timeout=5)
                    if rv.status_code == 200:
                        return sid
            except Exception:
                pass
            await asyncio.sleep(0.2)
    except Exception:
        pass

    if not core.WDA_AUTO_CREATE:
        raise RuntimeError("No WDA session found. Start WDA via Appium/Xcode or enable WDA_AUTO_CREATE=true.")

    # Create minimal session
    caps = {"capabilities": {}}
    r = await client.post(f"{core.WDA_BASE}/session", json=caps, timeout=20)
    r.raise_for_status()
    val = r.json().get("value", {})
    sid = val.get("sessionId") or val.get("id") or r.json().get("sessionId")
    if not sid:
        raise RuntimeError("Failed to obtain WDA sessionId")
    return sid


async def _get_window_size(client: httpx.AsyncClient, sid: str) -> Optional[Tuple[int, int]]:
    try:
        r = await client.get(f"{core.WDA_BASE}/session/{sid}/window/size", timeout=5)
        r.raise_for_status()
        v = r.json().get("value", {})
        w, h = int(v.get("width", 0)), int(v.get("height", 0))
        if w and h:
            return w, h
    except httpx.HTTPStatusError as e:
        if e.response is not None and e.response.status_code == 404:
            # Try once more by adopting/creating session
            sid2 = await _adopt_or_create_session(client)
            r = await client.get(f"{core.WDA_BASE}/session/{sid2}/window/size", timeout=5)
            r.raise_for_status()
            v = r.json().get("value", {})
            w, h = int(v.get("width", 0)), int(v.get("height", 0))
            if w and h:
                return w, h
        return None
    except Exception:
        return None
    return None


async def _get_screenshot_size(client: httpx.AsyncClient, sid: str) -> Tuple[int, int]:
    r = await client.get(f"{core.WDA_BASE}/session/{sid}/screenshot", timeout=20)
    r.raise_for_status()

    def _extract_b64(j: Dict[str, Any]) -> str:
        v = j.get("value")
        if isinstance(v, str):
            return v
        if isinstance(v, dict):
            for k in ("value", "data", "screenshot", "image"):
                s = v.get(k)
                if isinstance(s, str):
                    return s
        raise ValueError("unexpected screenshot response shape")

    b64 = _extract_b64(r.json())
    img = Image.open(BytesIO(base64.b64decode(b64)))
    return img.size


@router.get("/api/device-info")
async def device_info(noShot: bool = False):
    client = await core.get_http_client()
    try:
        sid = await _adopt_or_create_session(client)
        size_pt = await _get_window_size(client, sid)
        size_px = None
        if not (noShot or core.SKIP_SCREENSHOT_SIZE):
            try:
                pxw, pxh = await _get_screenshot_size(client, sid)
                size_px = {"w": pxw, "h": pxh}
            except Exception as _e:
                core.logger.info(f"device-info: skip screenshot size due to: {_e}")
        return {
            "sessionId": sid,
            "size_pt": {"w": size_pt[0], "h": size_pt[1]} if size_pt else None,
            "size_px": size_px,
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=503)
