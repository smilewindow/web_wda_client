import ipaddress
import logging
import os
import socket
from typing import Dict, Optional
from urllib.parse import urlparse

import httpx

# Environment and global state shared across routers/utils

MJPEG_URL = os.environ.get("MJPEG", "").rstrip("/")
APPIUM_BASE = (os.environ.get("APPIUM_BASE") or "http://127.0.0.1:4723").rstrip("/")
_DISCOVERY_BASE_ENV = os.environ.get("DEVICE_DISCOVERY_BASE") or os.environ.get("DISCOVERY_BASE") or "http://127.0.0.1:3030"
DISCOVERY_BASE = _DISCOVERY_BASE_ENV.rstrip("/") if _DISCOVERY_BASE_ENV else ""

# Track last created Appium session per base
APPIUM_LATEST: Dict[str, str] = {}


def _pick_private(candidates: list[str], preferred_prefix: str) -> Optional[str]:
    for cand in candidates:
        try:
            ip_obj = ipaddress.ip_address(cand)
        except ValueError:
            continue
        if ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_reserved or ip_obj.is_multicast:
            continue
        if not ip_obj.is_private:
            continue
        if preferred_prefix and not cand.startswith(preferred_prefix):
            continue
        return cand
    return None


def _guess_lan_ip() -> str:
    override = (os.environ.get("LAN_IP") or os.environ.get("APP_LAN_IP") or "").strip()
    if override:
        return override

    preferred_prefix = (os.environ.get("LAN_IP_PREFERRED_PREFIX") or "").strip()
    candidates: list[str] = []

    parsed = urlparse(APPIUM_BASE)
    if parsed.hostname:
        candidates.append(parsed.hostname)

    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        for info in infos:
            addr = info[4][0]
            candidates.append(addr)
    except Exception:
        pass

    try:
        host_ips = socket.gethostbyname_ex(socket.gethostname())[2]
        candidates.extend(host_ips)
    except Exception:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            ip = probe.getsockname()[0]
            candidates.append(ip)
    except Exception:
        pass

    seen = set()
    deduped = []
    for cand in candidates:
        if not cand or cand in seen:
            continue
        seen.add(cand)
        deduped.append(cand)

    chosen = _pick_private(deduped, preferred_prefix)
    if not chosen and preferred_prefix:
        chosen = _pick_private(deduped, preferred_prefix="")
    if chosen:
        return chosen

    for cand in deduped:
        try:
            ip_obj = ipaddress.ip_address(cand)
        except ValueError:
            continue
        if ip_obj.is_loopback:
            continue
        return cand

    return "127.0.0.1"


def _build_lan_appium_base() -> str:
    override = (os.environ.get("APPIUM_BASE_LAN") or os.environ.get("APPIUM_BASE_URL") or "").strip()
    if override:
        return override.rstrip("/")
    parsed = urlparse(APPIUM_BASE)
    scheme = parsed.scheme or "http"
    port = parsed.port
    if port is None:
        port = 443 if scheme == "https" else 80
    host = _guess_lan_ip()
    return f"{scheme}://{host}:{port}".rstrip("/")


APPIUM_BASE_LAN = _build_lan_appium_base()


def _build_backend_base() -> str:
    override = (os.environ.get("BACKEND_BASE_LAN") or os.environ.get("BACKEND_BASE_URL") or "").strip()
    if override:
        return override.rstrip("/")
    port_raw = os.environ.get("BACKEND_PORT", "7070").strip()
    try:
        port = int(port_raw)
    except Exception:
        port = 7070
    if port <= 0:
        port = 7070
    host = _guess_lan_ip()
    return f"http://{host}:{port}".rstrip("/")


BACKEND_BASE_LAN = _build_backend_base()

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
