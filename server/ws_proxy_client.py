import asyncio
import contextlib
import json
import os
import uuid
from typing import Any, Dict, Optional

import websockets

import core

MESSAGE_ROUTES = {
    "device.info": {"method": "GET", "path": "/api/device-info"},
    "appium.session.create": {"method": "POST", "path": "/api/appium/create"},
    "appium.settings.apply": {"method": "POST", "path": "/api/appium/settings"},
    "appium.settings.fetch": {"method": "GET", "path": "/api/appium/settings"},
    "discovery.devices.list": {"method": "GET", "path": "/api/discovery/devices"},
    "appium.exec.mobile": {"method": "POST", "path": "/api/appium/exec-mobile"},
    "appium.actions.execute": {"method": "POST", "path": "/api/appium/actions"},
}

BACKEND_HTTP_BASE = (os.environ.get("WS_BACKEND_HTTP_BASE") or "http://127.0.0.1:7070").rstrip("/")


DEFAULT_WS_URL = os.environ.get("WS_PROXY_URL") or os.environ.get("WS_URL") or "ws://127.0.0.1:8765"
PING_INTERVAL = float(os.environ.get("WS_PROXY_PING_INTERVAL", "30"))
PING_TIMEOUT = float(os.environ.get("WS_PROXY_PING_TIMEOUT", "10"))
RECONNECT_BASE = float(os.environ.get("WS_PROXY_RECONNECT_BASE", "1.5"))
RECONNECT_MAX = float(os.environ.get("WS_PROXY_RECONNECT_MAX", "20"))

if PING_INTERVAL <= 0:
    PING_INTERVAL = 30.0
if PING_TIMEOUT <= 0:
    PING_TIMEOUT = 10.0
if RECONNECT_BASE <= 0:
    RECONNECT_BASE = 1.5
if RECONNECT_MAX < RECONNECT_BASE:
    RECONNECT_MAX = max(RECONNECT_BASE, 5.0)


class WebSocketProxyClient:
    def __init__(self, url: str) -> None:
        self.url = url
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._ws: Optional[websockets.WebSocketClientProtocol] = None

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run_loop(), name="ws-proxy-client")

    async def stop(self) -> None:
        self._stop.set()
        ws = self._ws
        self._ws = None
        if ws is not None:
            try:
                await ws.close(code=1000, reason="shutdown")
            except Exception:
                pass
        if self._task:
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            except Exception:
                core.logger.exception("ws-proxy-client task terminated with error during shutdown")
            finally:
                self._task = None

    async def _run_loop(self) -> None:
        backoff = RECONNECT_BASE
        while not self._stop.is_set():
            try:
                core.logger.info("Connecting to WS proxy %s", self.url)
                async with websockets.connect(
                    self.url,
                    ping_interval=None,  # we send custom ping frames
                    ping_timeout=PING_TIMEOUT,
                    close_timeout=5,
                    max_queue=None,
                ) as ws:
                    self._ws = ws
                    backoff = RECONNECT_BASE
                    ping_task = asyncio.create_task(self._ping_loop(ws), name="ws-proxy-ping")
                    try:
                        await self._on_open(ws)
                        await self._listen(ws)
                    finally:
                        ping_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await ping_task
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                core.logger.warning("WS proxy connection failed: %s: %s", type(exc).__name__, exc)
            finally:
                self._ws = None

            if self._stop.is_set():
                break

            wait_time = min(backoff, RECONNECT_MAX)
            core.logger.info("Reconnecting to WS proxy in %.1fs", wait_time)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=wait_time)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 1.5, RECONNECT_MAX)

        core.logger.info("WS proxy client loop terminated")

    async def _on_open(self, ws: websockets.WebSocketClientProtocol) -> None:
        hello = {
            "id": f"backend-hello-{uuid.uuid4().hex}",
            "type": "system.hello",
            "payload": {
                "role": "backend",
                "version": "1.0",
            },
        }
        try:
            await ws.send(json.dumps(hello))
        except Exception:
            core.logger.warning("Failed to send hello to WS proxy", exc_info=True)

    async def _ping_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        try:
            while not self._stop.is_set() and not _is_connection_closed(ws):
                await asyncio.sleep(PING_INTERVAL)
                if _is_connection_closed(ws):
                    break
                msg = {
                    "id": f"backend-ping-{uuid.uuid4().hex}",
                    "type": "system.ping",
                }
                try:
                    await ws.send(json.dumps(msg))
                except Exception:
                    core.logger.debug("WS proxy ping failed", exc_info=True)
                    break
        except asyncio.CancelledError:
            pass

    async def _listen(self, ws: websockets.WebSocketClientProtocol) -> None:
        async for raw in ws:
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                core.logger.debug("WS proxy received non-JSON message: %s", raw)
                continue

            msg_type = message.get("type")
            msg_id = message.get("id")
            if msg_type == "system.welcome":
                core.logger.info("WS proxy connected: %s", message.get("data"))
            elif msg_type == "system.pong":
                core.logger.debug("WS proxy pong: %s", msg_id)
            elif msg_type == "system.hello":
                if message.get("ok"):
                    core.logger.info("WS proxy handshake acknowledged: %s", message.get("data"))
                else:
                    core.logger.warning("WS proxy handshake failed: %s", message.get("error"))
            elif isinstance(msg_type, str) and msg_type.startswith("system."):
                core.logger.debug("WS proxy system message: %s", message)
            else:
                asyncio.create_task(self._handle_proxy_request(ws, message), name=f"ws-proxy-handle-{msg_id}")

    async def _handle_proxy_request(self, ws: websockets.WebSocketClientProtocol, message: Dict[str, Any]) -> None:
        msg_id = message.get("id")
        msg_type = message.get("type")
        payload = message.get("payload")

        route = MESSAGE_ROUTES.get(msg_type)
        if route is None:
            await self._send(ws, {
                "id": msg_id,
                "type": msg_type,
                "ok": False,
                "error": {
                    "code": "unknown_type",
                    "message": f"Unsupported message type: {msg_type}",
                },
            })
            return

        method = route["method"].upper()
        path = route["path"]
        url = path if path.startswith("http") else f"{BACKEND_HTTP_BASE}{path}"

        client = await core.get_http_client()
        try:
            if method == "GET":
                params = payload if isinstance(payload, dict) else {}
                resp = await client.request(method, url, params=params)
            else:
                if isinstance(payload, (dict, list)):
                    json_body = payload
                else:
                    json_body = payload if payload is not None else {}
                resp = await client.request(method, url, json=json_body)
        except Exception as exc:  # noqa: BLE001
            await self._send(ws, {
                "id": msg_id,
                "type": msg_type,
                "ok": False,
                "error": {
                    "code": "http_request_error",
                    "message": str(exc),
                },
            })
            return

        try:
            body = resp.json()
        except ValueError:
            body = resp.text

        response = {
            "id": msg_id,
            "type": msg_type,
            "ok": resp.is_success,
            "status": resp.status_code,
        }
        if resp.is_success:
            response["data"] = body
        else:
            response["error"] = body

        await self._send(ws, response)

    async def _send(self, ws: websockets.WebSocketClientProtocol, message: Dict[str, Any]) -> None:
        try:
            await ws.send(json.dumps(message))
        except Exception:
            core.logger.debug("Failed to send WS response", exc_info=True)


_client = WebSocketProxyClient(DEFAULT_WS_URL)


def _is_connection_closed(ws: websockets.WebSocketClientProtocol) -> bool:
    closed_flag = getattr(ws, "closed", None)
    if isinstance(closed_flag, bool):
        return closed_flag
    close_code = getattr(ws, "close_code", None)
    return close_code is not None


async def start() -> None:
    await _client.start()


async def stop() -> None:
    await _client.stop()
