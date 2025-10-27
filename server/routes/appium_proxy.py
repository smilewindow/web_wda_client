import asyncio
import os
from typing import Any, Dict, Optional
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from fastapi.encoders import jsonable_encoder

import core
import appium_driver as ad
import httpx
import stream_pusher

router = APIRouter()


async def _restart_stream_async(
    *,
    udid: str,
    session_id: str,
    base_url: str,
    mjpeg_port: int,
) -> None:
    return
    core.logger.info(
        "Starting stream push for udid=%s sid=%s",
        udid,
        session_id,
    )
    try:
        push_error = await stream_pusher.start_stream(
            udid,
            session_id,
            base_url,
            mjpeg_port,
            mode="mjpeg",
        )
        if push_error:
            core.logger.error(
                "Failed to start stream push for udid=%s sid=%s: %s",
                udid,
                session_id,
                push_error,
            )
    except Exception:
        core.logger.exception(
            "Unexpected error when starting stream push: udid=%s sid=%s",
            udid,
            session_id,
        )


def _parse_float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except Exception:
        return default


@router.post("/api/appium/settings")
async def api_appium_set(payload: Dict[str, Any]):
    base = core.APPIUM_BASE
    sid = payload.get("sessionId")
    settings = payload.get("settings", {})
    if not sid or not isinstance(settings, dict):
        return JSONResponse(
            {"error": "sessionId and settings are required"}, status_code=400
        )
    try:
        res = await ad.update_settings(base, sid, settings)  # dict of settings
        return {"value": res}
    except ad.AppiumInvalidSession as e:
        # 会话失效：清缓存后提示前端重建会话
        core.logger.warning(
            f"appium settings POST invalid-session: base={base} sid={sid}"
        )
        return JSONResponse(
            {
                "code": "SESSION_GONE",
                "message": "Appium 会话已失效，请重建会话后重试",
                "sessionId": sid,
                "recoverable": True,
                "action": "RECREATE_SESSION",
                "error": str(e),
            },
            status_code=410,
        )
    except Exception as e:
        core.logger.exception(
            f"appium settings POST failed: base={base} sid={sid} settings_keys={list(settings.keys())}"
        )
        return JSONResponse({"error": str(e)}, status_code=502)


@router.get("/api/appium/settings")
async def api_appium_get(sessionId: Optional[str] = None):
    base = core.APPIUM_BASE
    sid = sessionId
    if not sid:
        return JSONResponse(
            {"error": "query param sessionId is required"}, status_code=400
        )
    try:
        res = await ad.get_settings(base, sid)
        return {"value": res}
    except ad.AppiumInvalidSession as e:
        core.logger.warning(
            f"appium settings GET invalid-session: base={base} sid={sid}"
        )
        return JSONResponse(
            {
                "code": "SESSION_GONE",
                "message": "Appium 会话已失效，请重建会话后重试",
                "sessionId": sid,
                "recoverable": True,
                "action": "RECREATE_SESSION",
                "error": str(e),
            },
            status_code=410,
        )
    except Exception as e:
        core.logger.exception(f"appium settings GET failed: base={base} sid={sid}")
        return JSONResponse({"error": str(e)}, status_code=502)


@router.get("/api/appium/sessions")
async def api_appium_sessions():
    base = core.APPIUM_BASE
    return {"sessions": ad.list_sessions(base)}


PRESET_CHOICES = ("1080p", "720p", "480p", "360p")
DEFAULT_PRESET = "720p"


def _normalize_preset(raw: Any) -> str:
    if not raw:
        return DEFAULT_PRESET
    preset = str(raw).strip()
    if preset in PRESET_CHOICES:
        return preset
    return DEFAULT_PRESET


@router.post("/api/appium/create")
async def api_appium_create(payload: Dict[str, Any]):
    base = core.APPIUM_BASE
    udid = payload.get("udid")
    os_version_raw = payload.get("osVersion")
    wda_port = int(payload.get("wdaLocalPort", 8100))
    mjpeg_port = int(payload.get("mjpegServerPort", 9100))
    bundle_id = payload.get("bundleId")
    no_reset = payload.get("noReset")
    new_cmd_to = payload.get("newCommandTimeout", 0)
    rtmp_stream_preset = _normalize_preset(payload.get("rtmpStreamVideoPreset"))
    if not udid:
        return JSONResponse({"error": "udid is required"}, status_code=400)
    # 基础能力（按推荐默认值；旧项保留为注释便于回滚/对照）
    caps: Dict[str, Any] = {
        "platformName": "iOS",
        "appium:automationName": "XCUITest",
        "appium:udid": udid,
        "appium:wdaLocalPort": wda_port,
        "appium:mjpegServerPort": mjpeg_port,
        # "appium:prebuiltWDAPath": "/Users/xuyuqin/Desktop/WebDriverAgentRunner_ios_17-Runner.app",
        # "appium:prebuiltWDAPath": "/Users/xuyuqin/Desktop/WebDriverAgentRunner-Runner.app",
        # "appium:usePreinstalledWDA": True,
        # "appium:updatedWDABundleId": "net.xuyuqin.WebDriverAgentRunner",
        # "appium:useNewWDA": True,
        "appium:wdaLaunchTimeout": 30000,
        "appium:wdaStartupRetries": 2,
        "appium:wdaStartupRetryInterval": 5000,
        "appium:showXcodeLog": True,
        # 让会话永不超时：默认 0（可被前端/调用方通过 newCommandTimeout 覆盖）
        "appium:newCommandTimeout": int(new_cmd_to) if new_cmd_to is not None else 0,
    }
    if isinstance(os_version_raw, (str, int, float)):
        os_version = str(os_version_raw).strip()
    else:
        os_version = ""
    if os_version:
        caps["appium:platformVersion"] = os_version
    # 后端统一追加的优化型能力（不再由前端传入 extraCaps）
    try:
        settings = {
            "mjpegFixOrientation": False,
            "boundElementsByIndex": True,
            "maxTypingFrequency": 60,
            "respectSystemAlerts": False,
            "elementResponseAttributes": "type,label",
            "screenshotOrientation": "auto",
            "keyboardPrediction": 0,
            "defaultActiveApplication": "auto",
            "mjpegServerScreenshotQuality": 1,
            "mjpegServerFramerate": 15, # idb时设置成1
            "mjpegScalingFactor": 100,
            # "mjpegServerEnableScaling": True,
            # "mjpegServerScreenshotScale": 0.5,
            # "mjpegServerScreenshotSize": "720x1560",
            "limitXPathContextScope": True,
            "autoClickAlertSelector": "",
            "keyboardAutocorrection": 0,
            "useFirstMatch": True,
            "defaultAlertAction": "",
            "shouldUseCompactResponses": True,
            "dismissAlertButtonSelector": "",
            "activeAppDetectionPoint": "64.00,64.00",
            "useClearTextShortcut": True,
            "snapshotMaxDepth": 0,
            "waitForIdleTimeout": 0,
            "includeNonModalElements": False,
            "acceptAlertButtonSelector": "",
            "animationCoolOffTimeout": 0,
            "rtmpStreamEnabled": True, # 开启 RTMP 推流功能
            # "rtmpStreamUrl": "rtmp://encoder:s3cret@192.168.124.2:1935/phone/00008101-00061D481E61001E/e5bdaae0-63af-4eb5-86b1-33e9e57d4edb",
            "rtmpStreamUrl": stream_pusher.RTMP_BASE, # RTMP 推流地址
            "rtmpStreamVideoPreset": rtmp_stream_preset,
            "backendBaseUrl": core.BACKEND_BASE_LAN,
        }
        core.logger.info(f"backendBaseUrl: {core.BACKEND_BASE_LAN}")
        extraCaps: Dict[str, Any] = {}
        # 把 settings 作为 capabilities 注入（关键：appium:settings[<name>] 这种写法）
        for k, v in settings.items():
            extraCaps[f"appium:settings[{k}]"] = v
        caps.update(extraCaps)
    except Exception:
        pass
    if bundle_id:
        caps["appium:bundleId"] = bundle_id
    if no_reset is not None:
        caps["appium:noReset"] = bool(no_reset)
    try:
        core.logger.info(caps)
        sid, _driver = await ad.create_session(base, capabilities=caps)
        asyncio.create_task(
            _restart_stream_async(
                udid=udid,
                session_id=sid,
                base_url=base,
                mjpeg_port=mjpeg_port,
            )
        )
        core.logger.info(
            "Scheduled stream restart for udid=%s sid=%s",
            udid,
            sid,
        )
        # 为避免序列化问题，这里不返回 capabilities（某些实现包含不可 JSON 化对象）
        return {"sessionId": sid, "capabilities": None}
    except Exception as e:
        core.logger.exception(f"appium create failed: base={base} udid={udid}")
        return JSONResponse({"error": str(e)}, status_code=502)


@router.get("/api/appium/last-session")
async def api_appium_last_session():
    base = core.APPIUM_BASE
    sid = core.APPIUM_LATEST.get(base)
    if not sid:
        return {"sessionId": None, "ok": False}
    if ad.get_driver(base, sid) is not None:
        return {"sessionId": sid, "ok": True}
    try:
        del core.APPIUM_LATEST[base]
    except Exception:
        pass
    return {"sessionId": None, "ok": False}


@router.get("/api/appium/session-id")
async def api_appium_session_id(udid: Optional[str] = None):
    base = core.APPIUM_BASE
    if not udid or not isinstance(udid, str):
        return JSONResponse({"error": "query param udid is required"}, status_code=400)
    udid_clean = udid.strip()
    if not udid_clean:
        return JSONResponse({"error": "query param udid is required"}, status_code=400)
    sid = ad.get_session_by_udid(base, udid_clean)
    if not sid:
        return JSONResponse(
            {
                "error": "Appium session not found for udid",
                "udid": udid_clean,
                "sessionId": None,
            },
            status_code=404,
        )
    return {"sessionId": sid, "udid": udid_clean}


@router.post("/api/appium/exec-mobile")
async def api_appium_exec_mobile(payload: Dict[str, Any]):
    """代理执行 Appium 的 mobile: 命令。
    请求体示例：
    {
      "sessionId": "<APPIUM_SESSION_ID>",
      "script": "mobile: swipe",
      "args": { "direction": "down" } | [ ... ]
    }
    """
    base = core.APPIUM_BASE
    sid = payload.get("sessionId")
    script = payload.get("script")
    args = payload.get("args")
    if not sid or not isinstance(script, str):
        return JSONResponse(
            {"error": "sessionId and script are required"}, status_code=400
        )
    if isinstance(args, list):
        args_arr = args
    elif isinstance(args, dict) or args is None:
        args_arr = [args or {}]
    else:
        return JSONResponse(
            {"error": "args must be an object or array"}, status_code=400
        )

    try:
        # Appium Python Client通常接受dict作为 args；若收到数组，仅取首个元素作为参数对象
        if isinstance(args_arr, list):
            args_obj = args_arr[0] if args_arr else {}
        else:
            args_obj = args_arr
        res, new_sid = await ad.exec_mobile_with_auto_recreate(
            base, sid, script, args_obj
        )
        try:
            enc = jsonable_encoder(res)
        except Exception:
            enc = str(res)
        body = {"value": enc}
        if new_sid:
            body.update({"sessionId": new_sid, "recreated": True})
        return body
    except ad.AppiumInvalidSession as e:
        core.logger.warning(
            f"appium exec-mobile invalid-session: base={base} sid={sid} script={script}"
        )
        return JSONResponse(
            {
                "code": "SESSION_GONE",
                "message": "Appium 会话已失效，请重建会话后重试",
                "sessionId": sid,
                "recoverable": True,
                "action": "RECREATE_SESSION",
                "error": str(e),
            },
            status_code=410,
        )
    except Exception as e:
        core.logger.exception(
            f"appium exec-mobile failed: base={base} sid={sid} script={script}"
        )
        return JSONResponse({"error": str(e)}, status_code=502)


@router.post("/api/appium/actions")
async def api_appium_actions(payload: Dict[str, Any]):
    """下发 W3C Actions（原生 pointer 序列）。
    请求体示例：
    {
      "sessionId": "<APPIUM_SESSION_ID>",
      "actions": [ { ... } ]
    }
    注：此端点直接调用 Appium /session/{sid}/actions HTTP 接口以避免客户端包装差异。
    """
    base = core.APPIUM_BASE
    sid = payload.get("sessionId")
    actions = payload.get("actions")
    if not sid or not isinstance(actions, list):
        return JSONResponse(
            {"error": "sessionId and actions are required"}, status_code=400
        )
    url = f"{base}/session/{sid}/actions"
    client = await core.get_http_client()
    try:
        r = await client.post(url, json={"actions": actions}, timeout=30)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        resp = getattr(e, "response", None)
        body_text = getattr(resp, "text", "") if resp is not None else ""
        # 检测会话失效关键词
        invalid = False
        text_l = (body_text or "").lower()
        if (
            "invalid session id" in text_l
            or "a session is either terminated or not started" in text_l
        ):
            invalid = True
        else:
            # 尝试解析 JSON 以提高判断准确度
            try:
                js = resp.json() if resp is not None else None
            except Exception:
                js = None
            if isinstance(js, dict):
                val = js.get("value") if isinstance(js.get("value"), dict) else js
                err = (val or {}).get("error") or (val or {}).get("message")
                if isinstance(err, str) and (
                    "invalid session id" in err.lower()
                    or "invalidsessionid" in err.lower()
                ):
                    invalid = True
        if invalid:
            try:
                # 清理本地缓存，避免后续继续使用失效会话
                ad.invalidate_session(base, sid)
            except Exception:
                pass
            core.logger.warning(
                f"appium actions invalid-session: base={base} sid={sid} url={url}"
            )
            return JSONResponse(
                {
                    "code": "SESSION_GONE",
                    "message": "Appium 会话已失效，请重建会话后重试",
                    "sessionId": sid,
                    "recoverable": True,
                    "action": "RECREATE_SESSION",
                    "error": str(e),
                    "body": body_text,
                },
                status_code=410,
            )
        core.logger.exception(f"appium actions failed: url={url} err={e}")
        return JSONResponse({"error": str(e), "body": body_text}, status_code=502)
