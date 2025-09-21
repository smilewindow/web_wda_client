import asyncio
import contextlib
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import urlencode, urlparse

import core


FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
RTMP_BASE = os.environ.get(
    "RTMP_PUSH_BASE", "rtmp://82.157.94.134:1935/iphone").rstrip("/")
RTMP_USER = os.environ.get("RTMP_PUSH_USER", "encoder")
RTMP_PASS = os.environ.get("RTMP_PUSH_PASS", "s3cret")
ENABLE_PUSH = os.environ.get("ENABLE_STREAM_PUSH", "true").lower() in {
    "1", "true", "yes", "y"}


_STREAM_READER_LIMIT = 4 * 1024 * 1024  # 4MB
_STREAM_READ_CHUNK = 64 * 1024
_STREAM_LOG_MAX_SEGMENT = 512 * 1024


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

    log_path = _prepare_ffmpeg_log_path(udid, session_id)
    if log_path:
        core.logger.info("ffmpeg log file: %s", log_path)

    # cmd = [
    #     FFMPEG_BIN,
    #     # 取消输入缓冲，降低整体延迟。
    #     "-fflags", "nobuffer",
    #     # 启用低延迟处理模式。
    #     "-flags", "low_delay",
    #     # 使用系统时钟作为时间戳，保持实时性。
    #     "-use_wallclock_as_timestamps", "1",
    #     # 读取超时设置为 60 秒。
    #     "-rw_timeout", "60000000",
    #     # 打开断线重连开关。
    #     "-reconnect", "1",
    #     "-reconnect_at_eof", "1",
    #     # 针对流媒体与网络错误启用重连。
    #     "-reconnect_streamed", "1",
    #     "-reconnect_on_network_error", "1",
    #     # 重连最大间隔 5 秒。
    #     "-reconnect_delay_max", "5",
    #     # 指定输入为 MJPEG。
    #     "-f", "mjpeg",
    #     # MJPEG 输入地址。
    #     "-i", input_url,
    #     # 缩放至 540 宽、限制 15fps、转换为 4:2:0。
    #     "-vf", "scale=1280:-2,fps=24:round=down,format=yuv420p",
    #     # 保留原始时间戳，避免补帧。
    #     "-vsync", "passthrough",
    #     # 保持帧率直通模式。
    #     "-fps_mode", "passthrough",
    #     # 使用 Apple 硬件 H.264 编码，低延迟。
    #     "-c:v", "h264_videotoolbox",
    #     # 告知编码器以实时模式运行。
    #     "-realtime", "1",
    #     # 使用 baseline profile，提高兼容性。
    #     "-profile:v", "high",
    #     # GOP 长度 15 帧（约 1 秒）。
    #     "-g", "24",
    #     # 目标码率 900kbps。
    #     "-b:v", "900k",
    #     # 峰值码率同样限制在 900kbps。
    #     "-maxrate", "900k",
    #     # VBV 缓冲区 300kb，降低延迟。
    #     "-bufsize", "300k",
    #     # RTMP 采用直播模式并缩小缓冲。
    #     "-rtmp_live", "live",
    #     "-rtmp_buffer", "100",
    #     # 禁止写入时长和文件大小元数据。
    #     "-flvflags", "no_duration_filesize",
    #     # 以 FLV 输出到指定 RTMP。
    #     "-f", "flv",
    #     output_url,
    # ]

    cmd = [
        FFMPEG_BIN,
        "-fflags", "nobuffer",
        "-use_wallclock_as_timestamps", "1",
        "-f", "mjpeg",
        "-i", input_url,
        # MJPEG 全范围 -> 电视范围，先做色域与缩放
        "-sws_flags", "lanczos+accurate_rnd+full_chroma_int",
        "-vf", "fps=25,scale=720:-2,scale=in_range=pc:out_range=tv,format=yuv420p",

        "-c:v", "libx264",
        "-preset", "veryfast",        # CPU 紧张可试 ultrafast；足够则换 fast/medium 提质
        "-tune", "zerolatency",
        "-profile:v", "high",
        "-g", "50",                   # 25fps -> 2s 一个 GOP
        "-x264-params", "bframes=0:keyint=50:min-keyint=50",
        "-crf", "18",
        # 标注 BT.709，很多播放器更稳
        "-color_range", "tv",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-colorspace", "bt709",

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
                limit=_STREAM_READER_LIMIT,
            )
        except FileNotFoundError:
            core.logger.error("ffmpeg executable not found: %s", FFMPEG_BIN)
            return "ffmpeg not found"
        except Exception as exc:  # noqa: BLE001
            core.logger.exception("Failed to start ffmpeg for %s", udid)
            return str(exc)

        reader_task = asyncio.create_task(
            _pump_logs(udid, proc, log_path),
            name=f"ffmpeg-log-{udid}",
        )
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


async def _pump_logs(
    udid: str,
    proc: asyncio.subprocess.Process,
    log_path: Optional[Path] = None,
) -> None:
    log_file = None
    if log_path:
        try:
            log_file = log_path.open("a", encoding="utf-8", buffering=1)
        except OSError:
            core.logger.exception(
                "Failed to open ffmpeg log file %s", log_path)
            log_file = None

    async def _read(stream, prefix):
        nonlocal log_file
        if stream is None:
            return
        buffer = bytearray()

        def _emit(raw: bytes, *, truncated: bool = False) -> None:
            text = raw.decode(errors="ignore").rstrip()
            if truncated:
                text = f"{text} [truncated]"
            core.logger.debug("[ffmpeg %s %s] %s", udid, prefix, text)
            if log_file:
                log_file.write(
                    f"{datetime.now().isoformat()} [{prefix}] {text}\n")

        while True:
            chunk = await stream.read(_STREAM_READ_CHUNK)
            if not chunk:
                if buffer:
                    _emit(bytes(buffer))
                break
            buffer.extend(chunk)

            while True:
                newline_index = buffer.find(b"\n")
                if newline_index == -1:
                    if len(buffer) >= _STREAM_LOG_MAX_SEGMENT:
                        segment = bytes(buffer[:_STREAM_LOG_MAX_SEGMENT])
                        del buffer[:_STREAM_LOG_MAX_SEGMENT]
                        _emit(segment, truncated=True)
                    break

                line = bytes(buffer[:newline_index])
                del buffer[: newline_index + 1]
                _emit(line)

    try:
        await asyncio.gather(_read(proc.stdout, "stdout"), _read(proc.stderr, "stderr"))
        await proc.wait()
    finally:
        if log_file:
            log_file.close()


def _build_mjpeg_url(base_url: str, port: int) -> str:
    parsed = urlparse(base_url)
    host = parsed.hostname or "127.0.0.1"
    scheme = parsed.scheme or "http"
    return f"{scheme}://{host}:{port}"


def _prepare_ffmpeg_log_path(udid: str, session_id: str) -> Optional[Path]:
    base_dir = os.environ.get("FFMPEG_LOG_DIR")
    if base_dir:
        log_dir = Path(base_dir).expanduser()
    else:
        log_dir = Path(__file__).resolve().parent / "logs" / "ffmpeg"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        core.logger.exception(
            "Failed to ensure ffmpeg log directory %s", log_dir)
        return None

    safe_udid = _sanitize_for_filename(udid) or "unknown_udid"
    safe_session = _sanitize_for_filename(session_id) or "unknown_session"
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return log_dir / f"{safe_udid}-{safe_session}-{timestamp}.log"


def _sanitize_for_filename(value: Optional[str]) -> str:
    if not value:
        return ""
    cleaned = [
        ch if ch.isalnum() or ch in {"-", "_", "."} else "_"
        for ch in value
    ]
    return "".join(cleaned).strip("_")
