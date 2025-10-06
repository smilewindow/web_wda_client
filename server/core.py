import os
import logging
from typing import Dict, Optional

import httpx

# Environment and global state shared across routers/utils

MJPEG_URL = os.environ.get("MJPEG", "").rstrip("/")
APPIUM_BASE = (os.environ.get("APPIUM_BASE") or "http://127.0.0.1:4723").rstrip("/")
_DISCOVERY_BASE_ENV = os.environ.get("DEVICE_DISCOVERY_BASE") or os.environ.get("DISCOVERY_BASE") or "http://127.0.0.1:3030"
DISCOVERY_BASE = _DISCOVERY_BASE_ENV.rstrip("/") if _DISCOVERY_BASE_ENV else ""

# Track last created Appium session per base
APPIUM_LATEST: Dict[str, str] = {}

# Logger
logger = logging.getLogger("wda.web")
if not logger.handlers:
    handler = logging.StreamHandler()
    fmt = logging.Formatter(
        fmt="[%(asctime)s] %(levelname)s %(filename)s:%(lineno)d %(message)s",
        datefmt="%H:%M:%S",
    )
    handler.setFormatter(fmt)
    logger.addHandler(handler)
logger.setLevel(logging.INFO)

# Disable uvicorn's default access logs to avoid duplication with our REQ/RESP
logging.getLogger("uvicorn.access").disabled = True

# ---------------------------------------------------------------------------
# Shared HTTP client (connection pool + unified timeouts/limits)
# ---------------------------------------------------------------------------

_HTTP_CLIENT: Optional[httpx.AsyncClient] = None

# Reasonable defaults; per-call can still override via function args
HTTP_LIMITS = httpx.Limits(
    max_connections=int(os.environ.get("HTTP_MAX_CONN", "100")),
    max_keepalive_connections=int(os.environ.get("HTTP_MAX_KEEPALIVE", "20")),
    keepalive_expiry=float(os.environ.get("HTTP_KEEPALIVE_EXPIRY", "45")),
)
HTTP_TIMEOUT = httpx.Timeout(
    timeout=float(os.environ.get("HTTP_TIMEOUT", "120")),
    connect=float(os.environ.get("HTTP_CONNECT_TIMEOUT", "10")),
    read=float(os.environ.get("HTTP_READ_TIMEOUT", "120")),
    write=float(os.environ.get("HTTP_WRITE_TIMEOUT", "120")),
)


async def get_http_client() -> httpx.AsyncClient:
    """Return a process-wide shared AsyncClient with pooling and timeouts."""
    global _HTTP_CLIENT
    if _HTTP_CLIENT is None:
        _HTTP_CLIENT = httpx.AsyncClient(
            limits=HTTP_LIMITS,
            timeout=HTTP_TIMEOUT,
            headers={"User-Agent": "wda-web/1.0"},
            http2=False,
        )
    return _HTTP_CLIENT


async def shutdown_http_client() -> None:
    """Close the shared AsyncClient if created."""
    global _HTTP_CLIENT
    try:
        if _HTTP_CLIENT is not None:
            await _HTTP_CLIENT.aclose()
    finally:
        _HTTP_CLIENT = None

# Whether to skip calling /screenshot for pixel size in /api/device-info.
# Helpful when video/DRM makes screenshot very slow or impossible.
SKIP_SCREENSHOT_SIZE = os.environ.get("SKIP_SCREENSHOT_SIZE", "false").strip().lower() in {"1","true","yes","y"}

# Only fallback on "safe" failures by default. Timeouts may still execute upstream,
# so do NOT fallback on timeouts unless explicitly enabled.
ALLOW_TIMEOUT_FALLBACK = os.environ.get("ALLOW_TIMEOUT_FALLBACK", "false").strip().lower() in {"1","true","yes","y"}
