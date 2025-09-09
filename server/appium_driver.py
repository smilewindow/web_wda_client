import asyncio
from typing import Any, Dict, List, Optional, Tuple

import core

try:  # soft import; give clear error if missing
    from appium.webdriver import Remote  # type: ignore
    try:
        from appium.options.ios import XCUITestOptions  # type: ignore
    except Exception:  # pragma: no cover
        XCUITestOptions = None  # type: ignore
    APPIM_AVAILABLE = True
except Exception as _e:  # pragma: no cover
    Remote = None  # type: ignore
    XCUITestOptions = None  # type: ignore
    APPIM_AVAILABLE = False


# In-memory driver registry: (base, sessionId) -> driver
_DRIVERS: Dict[Tuple[str, str], Any] = {}


def _key(base: str, sid: str) -> Tuple[str, str]:
    return (base.rstrip("/"), sid)


async def ensure_available() -> None:
    if not APPIM_AVAILABLE:
        raise RuntimeError('Appium-Python-Client is not installed. Install via: pip install "Appium-Python-Client>=3.0.0"')


async def create_session(base: str, capabilities: Dict[str, Any]) -> Tuple[str, Any]:
    await ensure_available()
    b = base.rstrip("/")

    # Attempt 1: XCUITestOptions (Appium v2 preferred)
    driver = None
    last_err: Optional[Exception] = None
    if XCUITestOptions is not None:
        def _mk_opts() -> Any:
            opts = XCUITestOptions()
            # Feed provided caps as-is
            for k, v in (capabilities or {}).items():
                try:
                    opts.set_capability(k, v)
                except Exception:
                    pass
            return Remote(command_executor=b, options=opts)
        try:
            driver = await asyncio.to_thread(_mk_opts)
        except Exception as e:
            last_err = e
            core.logger.warning(f"Appium create (options) failed: {e}")

    # Attempt 2: legacy desired_capabilities with de-namespaced caps
    if driver is None:
        def _mk_legacy() -> Any:
            caps_legacy: Dict[str, Any] = {}
            for k, v in (capabilities or {}).items():
                kk = k
                if isinstance(k, str) and k.startswith("appium:"):
                    kk = k.split(":", 1)[1]
                caps_legacy[kk] = v
            return Remote(command_executor=b, desired_capabilities=caps_legacy)
        try:
            driver = await asyncio.to_thread(_mk_legacy)
        except Exception as e2:
            core.logger.error(f"Appium create (legacy) failed: {e2}")
            if last_err is not None:
                core.logger.error(f"Previous create (options) error: {last_err}")
            raise

    sid = getattr(driver, "session_id", None)
    if not sid:
        try:
            driver.quit()
        except Exception:
            pass
        raise RuntimeError("Failed to obtain Appium sessionId from driver")
    _DRIVERS[_key(b, sid)] = driver
    try:
        core.APPIUM_LATEST[b] = sid
    except Exception:
        pass
    return sid, driver


def get_driver(base: str, sid: str) -> Optional[Any]:
    return _DRIVERS.get(_key(base, sid))


async def exec_mobile(base: str, sid: str, script: str, args: Any) -> Any:
    await ensure_available()
    drv = get_driver(base, sid)
    if drv is None:
        raise RuntimeError("unknown session; create it via /api/appium/create in this backend")

    def _exec() -> Any:
        # Appium Python Client accepts dict for mobile: commands; it wraps as array internally
        return drv.execute_script(script, args)

    return await asyncio.to_thread(_exec)


async def get_settings(base: str, sid: str) -> Dict[str, Any]:
    await ensure_available()
    drv = get_driver(base, sid)
    if drv is None:
        raise RuntimeError("unknown session; create it via /api/appium/create in this backend")

    def _get() -> Dict[str, Any]:
        return drv.get_settings()

    return await asyncio.to_thread(_get)


async def update_settings(base: str, sid: str, settings: Dict[str, Any]) -> Dict[str, Any]:
    await ensure_available()
    drv = get_driver(base, sid)
    if drv is None:
        raise RuntimeError("unknown session; create it via /api/appium/create in this backend")

    def _upd_and_get() -> Dict[str, Any]:
        try:
            drv.update_settings(settings)
        except Exception as e:
            raise
        return drv.get_settings()

    return await asyncio.to_thread(_upd_and_get)


def list_sessions(base: str) -> List[str]:
    b = base.rstrip("/")
    res = []
    for (bb, sid) in list(_DRIVERS.keys()):
        if bb == b:
            res.append(sid)
    return res
