from typing import Any, Optional, Tuple

import asyncio
from io import BytesIO

from PIL import Image
from fastapi import APIRouter
from fastapi.responses import JSONResponse

import core
import appium_driver as ad

router = APIRouter()


def _is_invalid_session(exc: Exception) -> bool:
    if ad.InvalidSessionIdException is not None and isinstance(exc, ad.InvalidSessionIdException):
        return True
    msg = str(exc) or exc.__class__.__name__
    return "InvalidSessionId" in msg or "terminated" in msg or "session" in msg and "not started" in msg


async def _get_window_size_via_driver(driver: Any) -> Optional[Tuple[int, int]]:
    def _inner() -> Optional[Tuple[int, int]]:
        size = driver.get_window_size()
        if isinstance(size, dict):
            w = int(size.get("width", 0))
            h = int(size.get("height", 0))
        else:
            w = int(getattr(size, "width", 0))
            h = int(getattr(size, "height", 0))
        if w and h:
            return w, h
        return None

    return await asyncio.to_thread(_inner)


async def _get_screenshot_size_via_driver(driver: Any) -> Optional[Tuple[int, int]]:
    def _inner() -> Optional[Tuple[int, int]]:
        png_bytes = driver.get_screenshot_as_png()
        if not png_bytes:
            return None
        with Image.open(BytesIO(png_bytes)) as img:
            return img.size

    return await asyncio.to_thread(_inner)


@router.get("/api/device-info")
async def device_info(noShot: bool = False):
    base = core.APPIUM_BASE.rstrip("/") if core.APPIUM_BASE else None
    if not base:
        return JSONResponse({"error": "APPIUM_BASE is not configured"}, status_code=503)

    sid = core.APPIUM_LATEST.get(base)
    if not sid:
        return JSONResponse({"error": "No Appium session found. Please create a session first."}, status_code=503)

    driver = ad.get_driver(base, sid)
    if driver is None:
        return JSONResponse({"error": "Appium session is not active. Please recreate the session."}, status_code=503)

    try:
        size_pt = await _get_window_size_via_driver(driver)
        size_px = None
        if not (noShot or core.SKIP_SCREENSHOT_SIZE):
            try:
                px = await _get_screenshot_size_via_driver(driver)
                if px:
                    size_px = {"w": int(px[0]), "h": int(px[1])}
            except Exception as screenshot_err:
                if _is_invalid_session(screenshot_err):
                    ad.invalidate_session(base, sid)
                    return JSONResponse({"error": "Appium session has expired. Please recreate the session."}, status_code=503)
                core.logger.info(f"device-info: skip screenshot size due to: {screenshot_err}")

        return {
            "sessionId": sid,
            "size_pt": {"w": size_pt[0], "h": size_pt[1]} if size_pt else None,
            "size_px": size_px,
        }
    except Exception as exc:
        if _is_invalid_session(exc):
            ad.invalidate_session(base, sid)
            return JSONResponse({"error": "Appium session has expired. Please recreate the session."}, status_code=503)
        core.logger.exception("device-info failed via Appium driver")
        return JSONResponse({"error": str(exc)}, status_code=503)
