from typing import Any, Dict, Optional
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from fastapi.encoders import jsonable_encoder

import core
import appium_driver as ad
import httpx

router = APIRouter()


@router.post("/api/appium/settings")
async def api_appium_set(payload: Dict[str, Any]):
    base = (
        (payload.get("base") or core.APPIUM_BASE).rstrip("/")
        if (payload.get("base") or core.APPIUM_BASE)
        else None
    )
    sid = payload.get("sessionId")
    settings = payload.get("settings", {})
    if not base or not sid or not isinstance(settings, dict):
        return JSONResponse(
            {"error": "base, sessionId, settings are required"}, status_code=400
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
                "base": base,
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
async def api_appium_get(base: Optional[str] = None, sessionId: Optional[str] = None):
    b = (base or core.APPIUM_BASE).rstrip("/") if (base or core.APPIUM_BASE) else None
    sid = sessionId
    if not b or not sid:
        return JSONResponse(
            {"error": "query params base and sessionId are required"}, status_code=400
        )
    try:
        res = await ad.get_settings(b, sid)
        return {"value": res}
    except ad.AppiumInvalidSession as e:
        core.logger.warning(f"appium settings GET invalid-session: base={b} sid={sid}")
        return JSONResponse(
            {
                "code": "SESSION_GONE",
                "message": "Appium 会话已失效，请重建会话后重试",
                "base": b,
                "sessionId": sid,
                "recoverable": True,
                "action": "RECREATE_SESSION",
                "error": str(e),
            },
            status_code=410,
        )
    except Exception as e:
        core.logger.exception(f"appium settings GET failed: base={b} sid={sid}")
        return JSONResponse({"error": str(e)}, status_code=502)


@router.get("/api/appium/sessions")
async def api_appium_sessions(base: Optional[str] = None):
    b = (base or core.APPIUM_BASE).rstrip("/") if (base or core.APPIUM_BASE) else None
    if not b:
        return JSONResponse(
            {"error": "query param base is required or set APPIUM_BASE"},
            status_code=400,
        )
    return {"sessions": ad.list_sessions(b)}


@router.post("/api/appium/create")
async def api_appium_create(payload: Dict[str, Any]):
    base = (
        (payload.get("base") or core.APPIUM_BASE).rstrip("/")
        if (payload.get("base") or core.APPIUM_BASE)
        else None
    )
    udid = payload.get("udid")
    wda_port = int(payload.get("wdaLocalPort", 8100))
    mjpeg_port = int(payload.get("mjpegServerPort", 9100))
    bundle_id = payload.get("bundleId")
    no_reset = payload.get("noReset")
    new_cmd_to = payload.get("newCommandTimeout", 0)
    if not base or not udid:
        return JSONResponse({"error": "base and udid are required"}, status_code=400)
    # 基础能力
    caps: Dict[str, Any] = {
        "platformName": "iOS",
        "appium:automationName": "XCUITest",
        "appium:udid": udid,
        "appium:platformVersion": "18.6.2", 
        "appium:wdaLocalPort": wda_port,
        "appium:mjpegServerPort": mjpeg_port,
        # "appium:mjpegScreenshotUrl": "http://127.0.0.1:8090/stream",
        # "appium:newCommandTimeout": int(new_cmd_to) if new_cmd_to is not None else 0,
        # "appium:preventWDAAttachments": True,
    }
    # 后端统一追加的优化型能力（不再由前端传入 extraCaps）
    try:
        settings = {
            "mjpegFixOrientation": False,
            "boundElementsByIndex": True,
            "mjpegServerFramerate": 10,
            "maxTypingFrequency": 60,
            "reduceMotion": False,
            "respectSystemAlerts": False,
            "elementResponseAttributes": "type,label",
            # "screenshotQuality": 3,
            # "mjpegScalingFactor": 17.06161117553711,
            "mjpegScalingFactor": 45,
            "screenshotOrientation": "auto",
            "keyboardPrediction": 0,
            "defaultActiveApplication": "auto",
            "mjpegServerScreenshotQuality": 90,
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
        }
        extraCaps: Dict[str, Any] = {}
        # 把 settings 作为 capabilities 注入（关键：appium:settings[<name>] 这种写法）
        for k, v in settings.items():
            extraCaps[f"appium:settings[{k}]"] = v
        caps.update(extraCaps)
        # caps.update(
        #     {
        #         "appium:mjpegScalingFactor": 17.06161117553711,
        #         "appium:mjpegServerFramerate": 10,
        #         "appium:mjpegServerScreenshotQuality": 75,
        #         "appium:waitForQuiescence": False,
        #         "appium:waitForIdleTimeout": 0,
        #         "appium:wdaEventloopIdleDelay": 0,
        #         "appium:simpleIsVisibleCheck": True,
        #         "appium:disableAutomaticScreenshots": True,
        #         "appium:showXcodeLog": True,
        #         "appium:showIOSLog": False,
        #         "appium:logTimestamps": True,
        #     }
        # )
    except Exception:
        pass
    if bundle_id:
        caps["appium:bundleId"] = bundle_id
    if no_reset is not None:
        caps["appium:noReset"] = bool(no_reset)
    try:
        core.logger.info(caps)
        sid, _driver = await ad.create_session(base, capabilities=caps)
        # 为避免序列化问题，这里不返回 capabilities（某些实现包含不可 JSON 化对象）
        return {"sessionId": sid, "capabilities": None}
    except Exception as e:
        core.logger.exception(f"appium create failed: base={base} udid={udid}")
        return JSONResponse({"error": str(e)}, status_code=502)


@router.get("/api/appium/last-session")
async def api_appium_last_session(base: Optional[str] = None):
    b = (base or core.APPIUM_BASE).rstrip("/") if (base or core.APPIUM_BASE) else None
    if not b:
        return JSONResponse(
            {"error": "query param base is required or set APPIUM_BASE"},
            status_code=400,
        )
    sid = core.APPIUM_LATEST.get(b)
    if not sid:
        return {"sessionId": None, "ok": False}
    if ad.get_driver(b, sid) is not None:
        return {"sessionId": sid, "ok": True}
    try:
        del core.APPIUM_LATEST[b]
    except Exception:
        pass
    return {"sessionId": None, "ok": False}


@router.post("/api/appium/exec-mobile")
async def api_appium_exec_mobile(payload: Dict[str, Any]):
    """代理执行 Appium 的 mobile: 命令。
    请求体示例：
    {
      "base": "http://127.0.0.1:4723",
      "sessionId": "<APPIUM_SESSION_ID>",
      "script": "mobile: swipe",
      "args": { "direction": "down" } | [ ... ]
    }
    """
    b = (
        (payload.get("base") or core.APPIUM_BASE).rstrip("/")
        if (payload.get("base") or core.APPIUM_BASE)
        else None
    )
    sid = payload.get("sessionId")
    script = payload.get("script")
    args = payload.get("args")
    if not b or not sid or not isinstance(script, str):
        return JSONResponse(
            {"error": "base, sessionId, script are required"}, status_code=400
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
        res, new_sid = await ad.exec_mobile_with_auto_recreate(b, sid, script, args_obj)
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
            f"appium exec-mobile invalid-session: base={b} sid={sid} script={script}"
        )
        return JSONResponse(
            {
                "code": "SESSION_GONE",
                "message": "Appium 会话已失效，请重建会话后重试",
                "base": b,
                "sessionId": sid,
                "recoverable": True,
                "action": "RECREATE_SESSION",
                "error": str(e),
            },
            status_code=410,
        )
    except Exception as e:
        core.logger.exception(
            f"appium exec-mobile failed: base={b} sid={sid} script={script}"
        )
        return JSONResponse({"error": str(e)}, status_code=502)


@router.post("/api/appium/actions")
async def api_appium_actions(payload: Dict[str, Any]):
    """下发 W3C Actions（原生 pointer 序列）。
    请求体示例：
    {
      "base": "http://127.0.0.1:4723",
      "sessionId": "<APPIUM_SESSION_ID>",
      "actions": [ { ... } ]
    }
    注：此端点直接调用 Appium /session/{sid}/actions HTTP 接口以避免客户端包装差异。
    """
    b = (
        (payload.get("base") or core.APPIUM_BASE).rstrip("/")
        if (payload.get("base") or core.APPIUM_BASE)
        else None
    )
    sid = payload.get("sessionId")
    actions = payload.get("actions")
    if not b or not sid or not isinstance(actions, list):
        return JSONResponse(
            {"error": "base, sessionId, actions are required"}, status_code=400
        )
    url = f"{b}/session/{sid}/actions"
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
                ad.invalidate_session(b, sid)
            except Exception:
                pass
            core.logger.warning(
                f"appium actions invalid-session: base={b} sid={sid} url={url}"
            )
            return JSONResponse(
                {
                    "code": "SESSION_GONE",
                    "message": "Appium 会话已失效，请重建会话后重试",
                    "base": b,
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
