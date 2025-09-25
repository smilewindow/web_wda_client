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
_FFMPEG_LOG_LEVEL = os.environ.get("FFMPEG_LOG_LEVEL", "info").lower()


_STREAM_READER_LIMIT = 4 * 1024 * 1024  # 4MB
_STREAM_READ_CHUNK = 64 * 1024
_STREAM_LOG_MAX_SEGMENT = 512 * 1024


class _StreamState:
    __slots__ = ("process", "task")

    def __init__(self, process: asyncio.subprocess.Process, task: asyncio.Task):
        self.process = process
        self.task = task


def _build_ffmpeg_log_flags() -> list[str]:
    """构建FFmpeg日志级别标志"""
    log_flags = []

    # 添加详细的日志级别
    if _FFMPEG_LOG_LEVEL in {"debug", "trace", "verbose"}:
        log_flags.extend(["-loglevel", _FFMPEG_LOG_LEVEL])
        log_flags.extend(["-v", _FFMPEG_LOG_LEVEL])

    # 对于trace级别，添加更详细的调试信息
    if _FFMPEG_LOG_LEVEL in {"trace", "verbose"}:
        log_flags.extend(["-report"])  # 生成报告文件
        log_flags.extend(["-stats"])   # 显示编码统计
        log_flags.extend(["-benchmark"])  # 性能基准测试

    # 添加硬件加速调试信息
    if _FFMPEG_LOG_LEVEL in {"debug", "trace"}:
        log_flags.extend(["-hwaccels"])  # 显示可用的硬件加速器
        log_flags.extend(["-filters"])  # 显示可用滤镜

    return log_flags


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

    log_flags = _build_ffmpeg_log_flags()

    cmd = [
        FFMPEG_BIN,
        "-hide_banner",
        # "-loglevel", "warning",
        "-fflags", "+nobuffer+genpts",
        "-use_wallclock_as_timestamps", "1",
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_on_network_error", "1",
        "-reconnect_delay_max", "5",
        "-rw_timeout", "60000000",
        "-seekable", "0",
        "-thread_queue_size", "1024",
        "-f", "mjpeg",
        "-i", input_url,
        "-init_hw_device", "videotoolbox=vt",
        "-filter_hw_device", "vt",
        "-vf", "fps=25,scale=iw:ih:in_range=pc:out_range=tv,format=nv12,hwupload,scale_vt=720:1560",
        "-c:v", "h264_videotoolbox",
        "-profile:v", "main",
        "-realtime", "1",
        "-b:v", "2500k",
        "-maxrate", "3000k",
        "-bufsize", "5000k",
        "-g", "50",
        "-color_range", "tv",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-colorspace", "bt709",
        "-rtmp_live", "live",
        "-rtmp_buffer", "100",
        "-flvflags", "no_duration_filesize",
        "-an",
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
            core.logger.error("\033[1;31m💥 FFMPEG 可执行文件未找到\033[0m | 路径: %s", FFMPEG_BIN)
            return "ffmpeg not found"
        except Exception as exc:  # noqa: BLE001
            core.logger.exception("\033[1;31m💥 FFMPEG 启动失败\033[0m | 设备: %s | 错误: %s", udid, str(exc))
            return str(exc)

        reader_task = asyncio.create_task(
            _pump_logs(udid, proc),
            name=f"ffmpeg-log-{udid}",
        )
        _STREAMS[udid] = _StreamState(proc, reader_task)

        # 推流启动日志 - 使用醒目的颜色和完整信息
        core.logger.info(
            "\033[1;36m🚀 FFMPEG 推流启动\033[0m | 设备: %s | 会话: %s | 输入: %s | 输出: %s | PID: %s",
            udid,
            session_id,
            input_url,
            output_url,
            proc.pid,
        )

        # 记录推流关键参数
        core.logger.info(
            "\033[1;36m📊 FFMPEG 推流参数\033[0m | 目标分辨率: 720x? | 帧率: 25 | 码率: 2500k | 硬件加速: 开启 | 调试级别: %s",
            _FFMPEG_LOG_LEVEL.upper()
        )

        # 如果启用了详细调试，显示额外信息
        if _FFMPEG_LOG_LEVEL in {"debug", "trace", "verbose"}:
            core.logger.info(
                "\033[1;33m🔍 FFMPEG 调试模式已启用\033[0m | 日志级别: %s | 将显示详细的编码和硬件加速信息",
                _FFMPEG_LOG_LEVEL.upper()
            )

        # Log the full command - 使用INFO级别确保始终显示
        core.logger.info("\033[1;36m🔧 FFMPEG 完整命令\033[0m | %s", " ".join(cmd))
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
    core.logger.info("\033[1;33m⏹️  FFMPEG 推流停止\033[0m | 设备: %s", udid)


async def _pump_logs(
    udid: str,
    proc: asyncio.subprocess.Process,
) -> None:

    # FFmpeg日志消息过滤模式
    ERROR_PATTERNS = [
        b"error", b"Error", b"ERROR",
        b"failed", b"Failed", b"FAILED",
        b"invalid", b"Invalid", b"INVALID",
        b"timeout", b"Timeout", b"TIMEOUT",
        b"connection", b"Connection", b"CONNECTION",
        b"not found", b"Not found", b"NOT FOUND",
        b"permission", b"Permission", b"PERMISSION",
        b"cannot", b"Cannot", b"CANNOT",
        b"unable", b"Unable", b"UNABLE",
        b"broken", b"Broken", b"BROKEN",
        b"corrupt", b"Corrupt", b"CORRUPT",
    ]

    WARNING_PATTERNS = [
        b"warning", b"Warning", b"WARNING",
        b"deprecated", b"Deprecated", b"DEPRECATED",
        b"unknown", b"Unknown", b"UNKNOWN",
    ]

    INFO_PATTERNS = [
        b"Stream #", b"frame=", b"fps=", b"q=", b"size=", b"time=", b"bitrate=",
        b"starting", b"Starting", b"STARTING",
        b"stopped", b"Stopped", b"STOPPED",
        b"initialized", b"Initialized", b"INITIALIZED",
        b"Encoder:", b"decoder", b"Detected",
        b"Input #", b"Output #",
        b"Successfully", b"Completed", b"Finished",
        b"Connected", b"Streaming", b"Recording",
        b"Using cpu capabilities", b"libx264", b"h264_videotoolbox",
        b"Selected hardware acceleration", b"Hardware acceleration",
    ]

    def _should_log_as_error(line: bytes) -> bool:
        return any(pattern in line for pattern in ERROR_PATTERNS)

    def _should_log_as_warning(line: bytes) -> bool:
        return any(pattern in line for pattern in WARNING_PATTERNS)

    def _should_log_as_info(line: bytes) -> bool:
        return any(pattern in line for pattern in INFO_PATTERNS)

    async def _read(stream, prefix):
        if stream is None:
            return
        buffer = bytearray()

        def _emit(raw: bytes, *, truncated: bool = False) -> None:
            text = raw.decode(errors="ignore").rstrip()
            if truncated:
                text = f"{text} [truncated]"

            # 根据内容决定日志级别和格式
            if _should_log_as_error(raw):
                core.logger.error("\033[1;31mFFMPEG\033[0m [%s %s] %s", udid, prefix, text)
            elif _should_log_as_warning(raw):
                core.logger.warning("\033[1;33mFFMPEG\033[0m [%s %s] %s", udid, prefix, text)
            elif _should_log_as_info(raw):
                core.logger.info("\033[1;36mFFMPEG\033[0m [%s %s] %s", udid, prefix, text)
            # 其他日志只在调试模式下输出
            elif core.logger.isEnabledFor(10):  # DEBUG level
                core.logger.debug("\033[1;90mFFMPEG\033[0m [%s %s] %s", udid, prefix, text)

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
        return_code = await proc.wait()
        if return_code != 0:
            core.logger.error("\033[1;31m💥 FFMPEG 进程异常退出\033[0m | 设备: %s | 退出码: %d", udid, return_code)
        else:
            core.logger.info("\033[1;32m✅ FFMPEG 进程正常完成\033[0m | 设备: %s", udid)
    except asyncio.CancelledError:
        core.logger.debug("\033[1;90mFFMPEG\033[0m 日志泵已取消 | 设备: %s", udid)
        raise
    except Exception:
        core.logger.exception("\033[1;31m💥 FFMPEG 日志泵异常\033[0m | 设备: %s", udid)
    finally:
        pass


def _build_mjpeg_url(base_url: str, port: int) -> str:
    parsed = urlparse(base_url)
    host = parsed.hostname or "127.0.0.1"
    scheme = parsed.scheme or "http"
    return f"{scheme}://{host}:{port}"
