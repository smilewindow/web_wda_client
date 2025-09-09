from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

import core

router = APIRouter()


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

    # 规范化 boundary 参数：部分上游会在 boundary 值前误带 "--"，浏览器可能无法解析
    ctype_out = chosen_ctype
    try:
        ct = chosen_ctype
        parts = [p.strip() for p in ct.split(";")]
        base = parts[0].lower()
        params = parts[1:]
        boundary_val = None
        rest = []
        for p in params:
            if p.lower().startswith("boundary="):
                boundary_val = p.split("=", 1)[1].strip().strip('"')
            else:
                rest.append(p)
        if base.startswith("multipart/x-mixed-replace") and boundary_val:
            if boundary_val.startswith("--"):
                boundary_val = boundary_val[2:]
            # 重新拼装 Content-Type
            ctype_out = "multipart/x-mixed-replace; boundary=" + boundary_val
            if rest:
                ctype_out += "; " + "; ".join(rest)
    except Exception:
        ctype_out = chosen_ctype

    async def body():
        client2 = await core.get_http_client()
        async with client2.stream("GET", chosen_url, timeout=None) as upstream2:
            async for chunk in upstream2.aiter_raw():
                yield chunk

    return StreamingResponse(body(), headers={
        "Content-Type": ctype_out,
        "Cache-Control": "no-cache, no-store",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
    })
