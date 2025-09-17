import asyncio
import contextlib
import os
from typing import Dict, Optional
from urllib.parse import urlencode, urlparse

import core


FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
RTMP_BASE = os.environ.get("RTMP_PUSH_BASE", "rtmp://82.157.94.134:1935/iphone").rstrip("/")
RTMP_USER = os.environ.get("RTMP_PUSH_USER", "encoder")
RTMP_PASS = os.environ.get("RTMP_PUSH_PASS", "s3cret")
ENABLE_PUSH = os.environ.get("ENABLE_STREAM_PUSH", "true").lower() in {"1", "true", "yes", "y"}


class _StreamState:
    __slots__ = ("process", "task")

    def __init__(self, process: asyncio.subprocess.Process, task: asyncio.Task):
        self.process = process
        self.task = task


_STREAMS: Dict[str, _StreamState] = {}
_LOCK = asyncio.Lock()


async def start_stream(udid: str, session_id: str, base_url: str, mjpeg_port: int) -> Optional[str]:
    if not ENABLE_PUSH:
        core.logger.info("Stream push disabled; skip ffmpeg launch")
        return None

    input_url = _build_mjpeg_url(base_url, mjpeg_port)
    output_url = f"{RTMP_BASE}/{udid}/{session_id}"
    credentials = {"user": RTMP_USER, "pass": RTMP_PASS}
    # 允许通过置空用户名/密码来跳过追加凭证
    if credentials["user"] or credentials["pass"]:
        query = urlencode(credentials)
        output_url = output_url + ("&" if "?" in output_url else "?") + query

    cmd = [
        FFMPEG_BIN,
        "-fflags", "nobuffer",
        "-flags", "low_delay",
        "-use_wallclock_as_timestamps", "1",
        "-rw_timeout", "15000000",
        "-reconnect", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_streamed", "1",
        "-reconnect_on_network_error", "1",
        "-reconnect_delay_max", "5",
        "-f", "mjpeg",
        "-r", "15",
        "-i", input_url,
        "-vf", "fps=15,scale=540:-2,format=yuv420p",
        "-c:v", "h264_videotoolbox",
        "-profile:v", "baseline",
        "-g", "30",
        "-b:v", "900k",
        "-maxrate", "950k",
        "-bufsize", "1900k",
        "-f", "flv",
        output_url,
    ]

    async with _LOCK:
        await _stop_stream_unlocked(udid)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            core.logger.error("ffmpeg executable not found: %s", FFMPEG_BIN)
            return "ffmpeg not found"
        except Exception as exc:  # noqa: BLE001
            core.logger.exception("Failed to start ffmpeg for %s", udid)
            return str(exc)

        reader_task = asyncio.create_task(_pump_logs(udid, proc), name=f"ffmpeg-log-{udid}")
        _STREAMS[udid] = _StreamState(proc, reader_task)
        core.logger.info(
            "Started ffmpeg push for udid=%s session=%s input=%s output=%s pid=%s",
            udid,
            session_id,
            input_url,
            output_url,
            proc.pid,
        )
    return None


async def stop_stream(udid: str) -> None:
    async with _LOCK:
        await _stop_stream_unlocked(udid)


async def stop_all() -> None:
    async with _LOCK:
        keys = list(_STREAMS.keys())
    for udid in keys:
        await stop_stream(udid)


async def _stop_stream_unlocked(udid: str) -> None:
    state = _STREAMS.pop(udid, None)
    if not state:
        return
    proc = state.process
    task = state.task
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    if proc.returncode is None:
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(proc.wait(), timeout=3)
    core.logger.info("Stopped ffmpeg push for udid=%s", udid)


async def _pump_logs(udid: str, proc: asyncio.subprocess.Process) -> None:
    async def _read(stream, prefix):
        if stream is None:
            return
        while True:
            line = await stream.readline()
            if not line:
                break
            core.logger.debug("[ffmpeg %s %s] %s", udid, prefix, line.decode(errors="ignore").rstrip())

    await asyncio.gather(_read(proc.stdout, "stdout"), _read(proc.stderr, "stderr"))
    await proc.wait()


def _build_mjpeg_url(base_url: str, port: int) -> str:
    parsed = urlparse(base_url)
    host = parsed.hostname or "127.0.0.1"
    scheme = parsed.scheme or "http"
    return f"{scheme}://{host}:{port}"
