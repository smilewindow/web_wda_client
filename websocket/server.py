import asyncio
import json
import logging
import os
import signal
import uuid
from typing import Any, Dict, Optional

from websockets.exceptions import ConnectionClosed
from websockets.server import WebSocketServerProtocol, serve


WS_HOST = os.getenv("WS_HOST", "0.0.0.0")
WS_PORT = int(os.getenv("WS_PORT", "8765"))


MESSAGE_ROUTES: Dict[str, Dict[str, Any]] = {
    "device.info": {"method": "GET", "path": "/api/device-info"},
    "appium.session.create": {"method": "POST", "path": "/api/appium/create"},
    "appium.settings.apply": {"method": "POST", "path": "/api/appium/settings"},
    "appium.settings.fetch": {"method": "GET", "path": "/api/appium/settings"},
    "discovery.devices.list": {"method": "GET", "path": "/api/discovery/devices"},
    "appium.exec.mobile": {"method": "POST", "path": "/api/appium/exec-mobile"},
    "appium.actions.execute": {"method": "POST", "path": "/api/appium/actions"},
    # Reserved: future front-end /api/tap calls could map to appium.tap.execute
}


CONNECTED: Dict[WebSocketServerProtocol, Dict[str, Any]] = {}
BACKEND_CONN: Optional[WebSocketServerProtocol] = None
PENDING: Dict[str, WebSocketServerProtocol] = {}


class _ColorFormatter(logging.Formatter):
    """为不同日志级别添加 ANSI 颜色。"""

    _LEVEL_COLORS = {
        logging.DEBUG: "\033[37m",   # 灰白
        logging.INFO: "\033[36m",    # 青色
        logging.WARNING: "\033[33m", # 黄色
        logging.ERROR: "\033[31m",   # 红色
        logging.CRITICAL: "\033[41m",  # 红底
    }
    _RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        message = super().format(record)
        color = self._LEVEL_COLORS.get(record.levelno, "")
        if color and message:
            return f"{color}{message}{self._RESET}"
        return message


def _configure_logging() -> None:
    log_format = "[%(asctime)s] %(levelname)s %(name)s: %(message)s"
    handler = logging.StreamHandler()
    stream = getattr(handler, "stream", None)
    if stream and hasattr(stream, "isatty") and stream.isatty():
        handler.setFormatter(_ColorFormatter(log_format))
    else:
        handler.setFormatter(logging.Formatter(log_format))

    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    root_logger.handlers = [handler]


async def proxy_to_backend(front_ws: WebSocketServerProtocol, message: Dict[str, Any]) -> None:
    msg_id = message.get("id")
    msg_type = message.get("type")
    if BACKEND_CONN is None:
        await send_json(front_ws, {
            "id": msg_id,
            "type": msg_type,
            "ok": False,
            "error": {
                "code": "backend_unavailable",
                "message": "Backend is not connected",
            },
        })
        return
    try:
        route = MESSAGE_ROUTES[msg_type]
    except KeyError:
        await send_json(front_ws, {
            "id": msg_id,
            "type": msg_type,
            "ok": False,
            "error": {
                "code": "unknown_type",
                "message": f"Unsupported message type: {msg_type}",
            },
        })
        return

    PENDING[msg_id] = front_ws
    try:
        await BACKEND_CONN.send(json.dumps(message))
    except Exception as exc:  # noqa: BLE001
        logging.warning("Failed to forward request %s to backend: %s", msg_id, exc)
        PENDING.pop(msg_id, None)
        await send_json(front_ws, {
            "id": msg_id,
            "type": msg_type,
            "ok": False,
            "error": {
                "code": "backend_send_failed",
                "message": str(exc),
            },
        })


async def send_json(ws: WebSocketServerProtocol, data: Dict[str, Any]) -> None:
    try:
        await ws.send(json.dumps(data))
    except ConnectionClosed:
        logging.debug("Skip send: connection already closed")


async def handle_message(ws: WebSocketServerProtocol, raw: str) -> None:
    client_info = CONNECTED.get(ws, {})
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        await send_json(ws, {
            "type": "system.error",
            "ok": False,
            "error": {
                "code": "invalid_json",
                "message": "Message must be valid JSON",
            },
        })
        return

    msg_type = msg.get("type")
    msg_id = msg.get("id")
    payload = msg.get("payload")

    if not isinstance(msg_type, str):
        await send_json(ws, {
            "id": msg_id,
            "type": "system.error",
            "ok": False,
            "error": {
                "code": "missing_type",
                "message": "Message must include string field 'type'",
            },
        })
        return

    role = client_info.get("role", "unknown")

    if msg_type == "system.hello":
        declared_role: Optional[str] = None
        if isinstance(payload, dict):
            raw_role = payload.get("role")
            if raw_role is not None:
                declared_role = str(raw_role)
        if declared_role is None and isinstance(msg_id, str) and msg_id.startswith("backend-hello-"):
            declared_role = "backend"

        role = declared_role or role or "unknown"
        client_info["role"] = role
        if role == "backend":
            global BACKEND_CONN
            BACKEND_CONN = ws
            logging.info("Backend registered: %s", client_info.get("id"))
        else:
            logging.info("Frontend registered: %s (role=%s)", client_info.get("id"), role)
        await send_json(ws, {
            "id": msg_id,
            "type": "system.hello",
            "ok": True,
            "data": {
                "clientId": client_info.get("id"),
                "role": role,
            },
        })
        return

    if msg_type == "system.ping":
        await send_json(ws, {
            "id": msg_id,
            "type": "system.pong",
            "ok": True,
        })
        return

    role = client_info.get("role")

    if role != "backend" and not msg_type.startswith("system."):
        logging.info(
            "收到前端消息[%s] role=%s type=%s id=%s payload=%s",
            client_info.get("id", "unknown"),
            role or "unknown",
            msg_type,
            msg_id,
            payload,
        )

    if role == "backend":
        await handle_backend_response(ws, msg)
    else:
        await proxy_to_backend(ws, msg)


async def handle_backend_response(ws: WebSocketServerProtocol, message: Dict[str, Any]) -> None:
    msg_id = message.get("id")
    msg_type = message.get("type")
    if msg_type == "system.pong":
        logging.debug("backend pong %s", msg_id)
        return
    if msg_id is None:
        logging.debug("backend message without id: %s", message)
        return
    front_ws = PENDING.pop(msg_id, None)
    if front_ws is None:
        logging.debug("No pending request for id %s", msg_id)
        return
    await send_json(front_ws, message)


async def client_handler(ws: WebSocketServerProtocol) -> None:
    client_id = str(uuid.uuid4())
    CONNECTED[ws] = {"id": client_id, "role": "unknown"}
    logging.info("Client connected: %s", client_id)
    await send_json(ws, {
        "type": "system.welcome",
        "ok": True,
        "data": {"clientId": client_id},
    })

    try:
        async for raw in ws:
            await handle_message(ws, raw)
    except ConnectionClosed:
        pass
    finally:
        info = CONNECTED.pop(ws, {})
        role = info.get("role")
        if role == "backend":
            global BACKEND_CONN
            if BACKEND_CONN is ws:
                BACKEND_CONN = None
                logging.warning("Backend disconnected")
                # fail all pending requests
                pending_items = list(PENDING.items())
                PENDING.clear()
                for req_id, front_ws in pending_items:
                    await send_json(front_ws, {
                        "id": req_id,
                        "type": "system.error",
                        "ok": False,
                        "error": {
                            "code": "backend_disconnected",
                            "message": "Backend connection lost",
                        },
                    })
                # inform remaining frontends so they can clean up local state
                for client_ws, client_info in list(CONNECTED.items()):
                    if client_info.get("role") == "backend":
                        continue
                    await send_json(client_ws, {
                        "type": "system.backend.disconnected",
                        "ok": False,
                        "error": {
                            "code": "backend_disconnected",
                            "message": "Backend connection lost",
                        },
                    })
        else:
            # remove pending entries associated with this frontend
            to_remove = [rid for rid, fw in PENDING.items() if fw is ws]
            for rid in to_remove:
                PENDING.pop(rid, None)
        logging.info("Client disconnected: %s", client_id)


async def run_server() -> None:
    _configure_logging()
    async with serve(client_handler, WS_HOST, WS_PORT):
        logging.info(
            "WebSocket proxy started on ws://%s:%s",
            WS_HOST,
            WS_PORT,
        )

        stop_event = asyncio.Event()

        def _handle_stop(*_args: Any) -> None:
            stop_event.set()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _handle_stop)
            except NotImplementedError:
                # Signal handlers may be unsupported (e.g. on Windows)
                pass

        await stop_event.wait()


def main() -> None:
    try:
        asyncio.run(run_server())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
