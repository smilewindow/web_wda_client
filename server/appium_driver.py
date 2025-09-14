import asyncio
from typing import Any, Dict, List, Optional, Tuple

import core
import logging

try:  # soft import; give clear error if missing
    from appium.webdriver import Remote  # type: ignore
    try:
        from appium.options.ios import XCUITestOptions  # type: ignore
    except Exception:  # pragma: no cover
        XCUITestOptions = None  # type: ignore
    try:
        from appium.options.common import AppiumOptions  # type: ignore
    except Exception:  # pragma: no cover
        AppiumOptions = None  # type: ignore
    APPIM_AVAILABLE = True
except Exception as _e:  # pragma: no cover
    Remote = None  # type: ignore
    XCUITestOptions = None  # type: ignore
    AppiumOptions = None  # type: ignore
    APPIM_AVAILABLE = False
try:
    from selenium.common.exceptions import InvalidSessionIdException  # type: ignore
except Exception:  # pragma: no cover
    InvalidSessionIdException = None  # type: ignore


# In-memory driver registry: (base, sessionId) -> driver
_DRIVERS: Dict[Tuple[str, str], Any] = {}
# 记录每个 base 最近一次用于创建会话的 capabilities，便于自动重建
_LAST_CAPS: Dict[str, Dict[str, Any]] = {}


def _key(base: str, sid: str) -> Tuple[str, str]:
    return (base.rstrip("/"), sid)


class AppiumInvalidSession(RuntimeError):
    """Raised when the upstream Appium session is gone/invalid.

    路由层可据此返回 410，让前端重建会话。
    """
    pass


def invalidate_session(base: str, sid: str) -> None:
    """Remove local driver cache and latest marker if matching.

    清理内存注册表，避免后续继续使用已失效的会话。
    """
    b = base.rstrip("/")
    k = _key(b, sid)
    if k in _DRIVERS:
        try:
            drv = _DRIVERS.pop(k)
            try:
                # 不主动 quit，避免与上游无效会话的二次错误；仅清缓存。
                pass
            except Exception:
                pass
        finally:
            logging.getLogger("wda.web").info(
                f"appium invalidate-session: base={b} sid={sid} cache_cleared=True"
            )
    # 若最新标记指向该 sid，则一并移除
    try:
        if core.APPIUM_LATEST.get(b) == sid:
            del core.APPIUM_LATEST[b]
    except Exception:
        pass


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
            # opts.set_new_command_timeout(0)  # 或 Duration/秒数
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

    # Attempt 2: Fallback to generic AppiumOptions with de-namespaced caps (for broader compatibility)
    if driver is None:
        def _mk_opts_generic() -> Any:
            # 去命名空间（如 appium:udid -> udid），以兼容某些服务端对旧键的容忍
            caps_legacy: Dict[str, Any] = {}
            for k, v in (capabilities or {}).items():
                kk = k
                if isinstance(k, str) and k.startswith("appium:"):
                    kk = k.split(":", 1)[1]
                caps_legacy[kk] = v
            # # 强制确保 newCommandTimeout 存在且为 0（永不超时），除非调用方明确覆盖
            # if "newCommandTimeout" not in caps_legacy:
            #     caps_legacy["newCommandTimeout"] = 0
            if AppiumOptions is None:
                # 理论上 v3 应存在 AppiumOptions；若不存在，直接重抛到外层
                raise RuntimeError("AppiumOptions is not available in this Appium Python client")
            opts = AppiumOptions()
            try:
                opts.load_capabilities(caps_legacy)
            except Exception:
                # 退化逐项设置
                for k, v in caps_legacy.items():
                    try:
                        opts.set_capability(k, v)
                    except Exception:
                        pass
            return Remote(command_executor=b, options=opts)
        try:
            driver = await asyncio.to_thread(_mk_opts_generic)
        except Exception as e2:
            core.logger.error(f"Appium create (fallback options) failed: {e2}")
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
    # 保存最近一次用于该 base 的 capabilities，便于自动重建
    try:
        if isinstance(capabilities, dict):
            _LAST_CAPS[b] = dict(capabilities)
    except Exception:
        pass
    return sid, driver


def get_driver(base: str, sid: str) -> Optional[Any]:
    return _DRIVERS.get(_key(base, sid))


def get_last_caps(base: str) -> Optional[Dict[str, Any]]:
    b = base.rstrip("/")
    return _LAST_CAPS.get(b)


async def exec_mobile(base: str, sid: str, script: str, args: Any) -> Any:
    await ensure_available()
    drv = get_driver(base, sid)
    if drv is None:
        raise RuntimeError("unknown session; create it via /api/appium/create in this backend")

    def _exec() -> Any:
        # Appium Python Client accepts dict for mobile: commands; it wraps as array internally
        try:
            return drv.execute_script(script, args)
        except Exception as e:
            # 识别上游会话失效并清理缓存
            is_invalid = False
            if InvalidSessionIdException is not None and isinstance(e, InvalidSessionIdException):
                is_invalid = True
            else:
                msg = str(e) or e.__class__.__name__
                if "InvalidSessionId" in msg or "A session is either terminated or not started" in msg:
                    is_invalid = True
            if is_invalid:
                invalidate_session(base, sid)
                raise AppiumInvalidSession(
                    "Appium session is invalid or terminated; please recreate the session"
                ) from e
            raise

    return await asyncio.to_thread(_exec)


async def exec_mobile_with_auto_recreate(base: str, sid: str, script: str, args: Any) -> Tuple[Any, Optional[str]]:
    """执行 mobile 命令；若会话失效且可用最近的 capabilities，则自动重建并重试一次。

    返回: (结果, new_session_id or None)
    """
    try:
        res = await exec_mobile(base, sid, script, args)
        return res, None
    except AppiumInvalidSession:
        # 上游确认会话失效，尝试基于最近 capabilities 自动重建
        try:
            core.logger.warning(f"auto-recreate start (invalid): base={base} oldSid={sid} script={script}")
        except Exception:
            pass
        caps = get_last_caps(base)
        if not isinstance(caps, dict) or not caps:
            try:
                core.logger.warning(f"auto-recreate skipped: no cached capabilities for base={base}")
            except Exception:
                pass
            raise
        try:
            new_sid, _drv = await create_session(base, capabilities=caps)
        except Exception as e:
            try:
                core.logger.exception(f"auto-recreate failed: base={base} oldSid={sid} err={e}")
            except Exception:
                pass
            raise AppiumInvalidSession(
                f"Failed to auto-recreate session: {e}"
            ) from e
        try:
            core.logger.info(f"auto-recreate ok: base={base} oldSid={sid} newSid={new_sid}")
        except Exception:
            pass
        res2 = await exec_mobile(base, new_sid, script, args)
        return res2, new_sid
    except RuntimeError as e:
        # 本地未命中 driver 缓存（如后端重启），也尝试重建
        msg = str(e) or e.__class__.__name__
        if "unknown session" in msg.lower():
            # 仅基于缓存能力重建，不复用 latest
            try:
                core.logger.warning(f"auto-recreate start (unknown): base={base} oldSid={sid} script={script}")
            except Exception:
                pass
            caps = get_last_caps(base)
            if not isinstance(caps, dict) or not caps:
                # 统一为会话失效类错误，便于路由返回 410
                try:
                    core.logger.warning(f"auto-recreate skipped: no cached capabilities for base={base}")
                except Exception:
                    pass
                raise AppiumInvalidSession(
                    "Unknown session in backend and no cached capabilities; please recreate the session"
                ) from e
            try:
                new_sid, _drv = await create_session(base, capabilities=caps)
            except Exception as e2:
                try:
                    core.logger.exception(f"auto-recreate failed: base={base} oldSid={sid} err={e2}")
                except Exception:
                    pass
                raise AppiumInvalidSession(
                    f"Failed to auto-recreate session: {e2}"
                ) from e2
            try:
                core.logger.info(f"auto-recreate ok: base={base} oldSid={sid} newSid={new_sid}")
            except Exception:
                pass
            res2 = await exec_mobile(base, new_sid, script, args)
            return res2, new_sid
        raise


async def get_settings(base: str, sid: str) -> Dict[str, Any]:
    await ensure_available()
    drv = get_driver(base, sid)
    if drv is None:
        raise RuntimeError("unknown session; create it via /api/appium/create in this backend")

    def _get() -> Dict[str, Any]:
        try:
            return drv.get_settings()
        except Exception as e:
            is_invalid = False
            if InvalidSessionIdException is not None and isinstance(e, InvalidSessionIdException):
                is_invalid = True
            else:
                msg = str(e) or e.__class__.__name__
                if "InvalidSessionId" in msg or "A session is either terminated or not started" in msg:
                    is_invalid = True
            if is_invalid:
                invalidate_session(base, sid)
                raise AppiumInvalidSession(
                    "Appium session is invalid or terminated; please recreate the session"
                ) from e
            raise

    return await asyncio.to_thread(_get)


async def update_settings(base: str, sid: str, settings: Dict[str, Any]) -> Dict[str, Any]:
    await ensure_available()
    drv = get_driver(base, sid)
    if drv is None:
        raise RuntimeError("unknown session; create it via /api/appium/create in this backend")

    def _upd_and_get() -> Dict[str, Any]:
        try:
            drv.update_settings(settings)
            return drv.get_settings()
        except Exception as e:
            is_invalid = False
            if InvalidSessionIdException is not None and isinstance(e, InvalidSessionIdException):
                is_invalid = True
            else:
                msg = str(e) or e.__class__.__name__
                if "InvalidSessionId" in msg or "A session is either terminated or not started" in msg:
                    is_invalid = True
            if is_invalid:
                invalidate_session(base, sid)
                raise AppiumInvalidSession(
                    "Appium session is invalid or terminated; please recreate the session"
                ) from e
            raise

    return await asyncio.to_thread(_upd_and_get)


def list_sessions(base: str) -> List[str]:
    b = base.rstrip("/")
    res = []
    for (bb, sid) in list(_DRIVERS.keys()):
        if bb == b:
            res.append(sid)
    return res
