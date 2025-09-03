import os
import logging
from typing import Dict, Optional

import httpx

# Environment and global state shared across routers/utils

WDA_BASE = os.environ.get("WDA_BASE", "http://127.0.0.1:8100").rstrip("/")
MJPEG_URL = os.environ.get("MJPEG", "").rstrip("/")
APPIUM_BASE = os.environ.get("APPIUM_BASE", "").rstrip("/")

# Track last created Appium session per base
APPIUM_LATEST: Dict[str, str] = {}

# Control modes
CONTROL_MODE_ENV = os.environ.get("CONTROL_MODE", "auto").strip().lower()
if CONTROL_MODE_ENV not in {"auto", "wda", "actions", "jsonwp"}:
    CONTROL_MODE_ENV = "auto"
ALLOW_FALLBACK = os.environ.get("ALLOW_FALLBACK", "true").strip().lower() in {"1","true","yes","y"}
CURRENT_MODE: str = CONTROL_MODE_ENV

# WDA tap implementation preference
WDA_TAP_IMPL = os.environ.get("WDA_TAP_IMPL", "auto").strip().lower()
if WDA_TAP_IMPL not in {"auto", "tap0", "drag"}:
    WDA_TAP_IMPL = "auto"
PREFERRED_WDA_TAP: str = WDA_TAP_IMPL

# Single WDA session (lazy created)
SESSION_ID = None  # type: ignore

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

# Whether backend is allowed to create a new WDA session when none exists.
# auto: disable auto-create if APPIUM_BASE is set; otherwise enable.
_AUTO_ENV = os.environ.get("WDA_AUTO_CREATE", "auto").strip().lower()
if _AUTO_ENV in {"1", "true", "yes", "y"}:
    WDA_AUTO_CREATE = True
elif _AUTO_ENV in {"0", "false", "no", "n"}:
    WDA_AUTO_CREATE = False
else:
    WDA_AUTO_CREATE = False if APPIUM_BASE else True

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
    timeout=float(os.environ.get("HTTP_TIMEOUT", "30")),
    connect=float(os.environ.get("HTTP_CONNECT_TIMEOUT", "5")),
    read=float(os.environ.get("HTTP_READ_TIMEOUT", "30")),
    write=float(os.environ.get("HTTP_WRITE_TIMEOUT", "30")),
)


async def get_http_client() -> httpx.AsyncClient:
    """Return a process-wide shared AsyncClient with pooling and timeouts."""
    global _HTTP_CLIENT
    if _HTTP_CLIENT is None:
        _HTTP_CLIENT = httpx.AsyncClient(
            limits=HTTP_LIMITS,
            timeout=HTTP_TIMEOUT,
            headers={"User-Agent": "wda-web/1.0"},
            http2=False,  # keep H1 for widest compatibility with WDA/Appium
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
