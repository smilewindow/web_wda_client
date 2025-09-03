import base64
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

import httpx
import asyncio
from PIL import Image

import core


class NoWdaSession(RuntimeError):
    pass


async def ensure_session(client: httpx.AsyncClient) -> str:
    """Reuse or create a WDA session and return sessionId."""
    if core.SESSION_ID:
        return core.SESSION_ID  # type: ignore

    # Try existing sessions
    try:
        r = await client.get(f"{core.WDA_BASE}/sessions", timeout=5)
        r.raise_for_status()
        sessions = r.json().get("value", [])
        if isinstance(sessions, list) and sessions:
            sid = sessions[-1].get("id") or sessions[-1].get("sessionId")
            if sid:
                core.SESSION_ID = sid
                return sid
    except Exception:
        pass

    # Fallback: some WDA builds expose sessionId via /status only; try to adopt it if valid
    try:
        for _ in range(15):  # ~3s total (@200ms)
            try:
                rs = await client.get(f"{core.WDA_BASE}/status", timeout=5)
                rs.raise_for_status()
                js = rs.json() or {}
                sid = js.get("sessionId") or (js.get("value") or {}).get("sessionId")
                if sid:
                    # validate the session id is actually active
                    rv = await client.get(f"{core.WDA_BASE}/session/{sid}", timeout=5)
                    if rv.status_code == 200:
                        core.SESSION_ID = sid
                        return sid
            except Exception:
                pass
            await asyncio.sleep(0.2)
    except Exception:
        pass

    # No existing session; create if allowed
    if not core.WDA_AUTO_CREATE:
        raise NoWdaSession("No WDA session found. Start WDA via Appium/Xcode or enable WDA_AUTO_CREATE=true.")

    caps = {"capabilities": {}}
    r = await client.post(f"{core.WDA_BASE}/session", json=caps, timeout=20)
    r.raise_for_status()
    val = r.json().get("value", {})
    sid = val.get("sessionId") or val.get("id") or r.json().get("sessionId")
    if not sid:
        raise RuntimeError("Failed to obtain WDA sessionId")
    core.SESSION_ID = sid
    return sid


async def get_window_size(client: httpx.AsyncClient) -> Optional[Tuple[int, int]]:
    """Get logical pt size if supported; else None."""
    sid = await ensure_session(client)
    try:
        r = await client.get(f"{core.WDA_BASE}/session/{sid}/window/size", timeout=5)
        r.raise_for_status()
        v = r.json().get("value", {})
        w, h = int(v.get("width", 0)), int(v.get("height", 0))
        if w and h:
            return w, h
    except httpx.HTTPStatusError as e:
        # Some WDA returns 404; try once after recreating session
        if e.response is not None and e.response.status_code == 404:
            core.SESSION_ID = None
            sid = await ensure_session(client)
            try:
                r = await client.get(f"{core.WDA_BASE}/session/{sid}/window/size", timeout=5)
                r.raise_for_status()
                v = r.json().get("value", {})
                w, h = int(v.get("width", 0)), int(v.get("height", 0))
                if w and h:
                    return w, h
            except Exception:
                return None
        return None
    except Exception:
        return None
    return None


async def get_screenshot_size(client: httpx.AsyncClient) -> Tuple[int, int]:
    """Fetch /screenshot and return (w_px, h_px)."""
    sid = await ensure_session(client)
    try:
        r = await client.get(f"{core.WDA_BASE}/session/{sid}/screenshot", timeout=20)
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        if e.response is not None and e.response.status_code == 404:
            core.SESSION_ID = None
            sid = await ensure_session(client)
            r = await client.get(f"{core.WDA_BASE}/session/{sid}/screenshot", timeout=20)
            r.raise_for_status()
        else:
            raise

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


async def _wda_post_with_retry(client: httpx.AsyncClient, sid: str, subpath: str, payload: Dict[str, Any], timeout: float = 10.0) -> httpx.Response:
    url = f"{core.WDA_BASE}/session/{sid}{subpath}"
    try:
        r = await client.post(url, json=payload, timeout=timeout)
        r.raise_for_status()
        return r
    except httpx.HTTPStatusError as e:
        body = None
        try:
            body = e.response.text
        except Exception:
            pass
        core.logger.warning(f"WDA POST {url} -> {getattr(e.response,'status_code',None)} body={str(body)[:200]}")
        if e.response is not None and e.response.status_code == 404:
            core.SESSION_ID = None
            new_sid = await ensure_session(client)
            url2 = f"{core.WDA_BASE}/session/{new_sid}{subpath}"
            r2 = await client.post(url2, json=payload, timeout=timeout)
            r2.raise_for_status()
            return r2
        raise


async def _wda_actions(client: httpx.AsyncClient, sid: str, actions: List[Dict[str, Any]], timeout: float = 15.0) -> httpx.Response:
    url = f"{core.WDA_BASE}/session/{sid}/actions"
    try:
        r = await client.post(url, json={"actions": actions}, timeout=timeout)
        r.raise_for_status()
        return r
    except httpx.HTTPStatusError as e:
        if e.response is not None and e.response.status_code == 404:
            core.SESSION_ID = None
            sid = await ensure_session(client)
            r2 = await client.post(f"{core.WDA_BASE}/session/{sid}/actions", json={"actions": actions}, timeout=timeout)
            r2.raise_for_status()
            return r2
        raise


async def _jsonwp_touch_perform(client: httpx.AsyncClient, sid: str, actions: List[Dict[str, Any]], timeout: float = 15.0) -> httpx.Response:
    url = f"{core.WDA_BASE}/session/{sid}/touch/perform"
    try:
        r = await client.post(url, json={"actions": actions}, timeout=timeout)
        r.raise_for_status()
        return r
    except httpx.HTTPStatusError as e:
        if e.response is not None and e.response.status_code == 404 and "invalid session id" in e.response.text.lower():
            core.SESSION_ID = None
            sid = await ensure_session(client)
            r2 = await client.post(f"{core.WDA_BASE}/session/{sid}/touch/perform", json={"actions": actions}, timeout=timeout)
            r2.raise_for_status()
            return r2
        raise
