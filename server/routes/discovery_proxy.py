from typing import Any, Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

import core

router = APIRouter()


async def _forward_get(path: str, timeout: Optional[float] = 10.0) -> Response:
    base = (core.DISCOVERY_BASE or "").rstrip("/")
    if not base:
        return JSONResponse({"error": "DEVICE_DISCOVERY_BASE 未配置"}, status_code=503)

    url = f"{base}{path}"
    client = await core.get_http_client()
    try:
        resp = await client.get(url, timeout=timeout)
    except httpx.RequestError as exc:
        core.logger.error(f"discovery proxy request error: {exc}")
        return JSONResponse({"error": f"discovery service unreachable: {exc}"}, status_code=502)

    content_type = resp.headers.get("content-type")
    body = resp.content
    if content_type and "application/json" in content_type.lower():
        try:
            data: Any = resp.json()
            return JSONResponse(data, status_code=resp.status_code)
        except ValueError:
            pass
    return Response(content=body, status_code=resp.status_code, media_type=content_type)


@router.get("/api/discovery/health")
async def discovery_health():
    return await _forward_get("/health", timeout=5.0)


@router.get("/api/discovery/devices")
async def discovery_devices():
    return await _forward_get("/devices", timeout=10.0)


@router.get("/api/discovery/devices/{udid}")
async def discovery_device_detail(udid: str):
    return await _forward_get(f"/devices/{udid}", timeout=10.0)
