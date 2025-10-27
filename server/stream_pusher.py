import asyncio
import contextlib
import os
from typing import Dict, Optional
from urllib.parse import urlencode, urlparse

import core


FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")
RTMP_BASE = os.environ.get(
    "RTMP_PUSH_BASE", "rtmp://127.0.0.1:1935").rstrip("/")
RTMP_USER = os.environ.get("RTMP_PUSH_USER", "encoder")
RTMP_PASS = os.environ.get("RTMP_PUSH_PASS", "s3cret")
ENABLE_PUSH = os.environ.get("ENABLE_STREAM_PUSH", "true").lower() in {
    "1", "true", "yes", "y"}
_FFMPEG_LOG_LEVEL = os.environ.get("FFMPEG_LOG_LEVEL", "info").lower()
_STREAM_MODE = os.environ.get("STREAM_PUSH_MODE", "mjpeg").strip().lower()
if _STREAM_MODE not in {"idb", "mjpeg"}:
    _STREAM_MODE = "idb"
IDB_BIN = os.environ.get("IDB_BIN", "idb")


_STREAM_READER_LIMIT = 4 * 1024 * 1024  # 4MB
_STREAM_READ_CHUNK = 64 * 1024
_STREAM_LOG_MAX_SEGMENT = 512 * 1024


class _StreamState:
    __slots__ = ("processes", "tasks")

    def __init__(self, processes: list[asyncio.subprocess.Process], tasks: list[asyncio.Task]):
        self.processes = processes
        self.tasks = tasks


def _build_ffmpeg_log_flags() -> list[str]:
    """构建FFmpeg日志级别标志"""
    log_flags: list[str] = []

    if _FFMPEG_LOG_LEVEL:
        log_flags.extend(["-loglevel", _FFMPEG_LOG_LEVEL])
        if _FFMPEG_LOG_LEVEL in {"debug", "trace", "verbose"}:
            log_flags.extend(["-v", _FFMPEG_LOG_LEVEL])

    if _FFMPEG_LOG_LEVEL in {"trace", "verbose"}:
        log_flags.extend(["-report", "-stats", "-benchmark"])

    return log_flags


_STREAMS: Dict[str, _StreamState] = {}
_LOCK = asyncio.Lock()


def _build_output_url(udid: str, session_id: str) -> tuple[str, str]:
    """生成推流输出地址及脱敏版本"""
    output_url = f"{RTMP_BASE}/iphone/{udid}"
    credentials = {"user": RTMP_USER, "pass": RTMP_PASS}
    if credentials["user"] or credentials["pass"]:
        query = urlencode(credentials)
        output_url = output_url + ("&" if "?" in output_url else "?") + query

    sanitized_output = output_url.split("?", 1)[0]
    if "?" in output_url:
        sanitized_output = f"{sanitized_output}?***"
    return output_url, sanitized_output


def current_mode() -> str:
    return _STREAM_MODE


def is_idb_mode() -> bool:
    return _STREAM_MODE == "idb"


async def start_stream(
    udid: str,
    session_id: str,
    base_url: str,
    mjpeg_port: int,
    *,
    mode: Optional[str] = None,
) -> Optional[str]:
    if not ENABLE_PUSH:
        core.logger.info("Stream push disabled; skip launch")
        return None

    selected_mode = (mode or _STREAM_MODE or "").strip().lower() or "idb"
    if selected_mode not in {"idb", "mjpeg"}:
        selected_mode = "idb"

    output_url, sanitized_output_url = _build_output_url(udid, session_id)

    if selected_mode == "idb":
        return await _start_stream_with_idb(
            udid=udid,
            session_id=session_id,
            output_url=output_url,
            sanitized_output=sanitized_output_url,
        )

    return await _start_stream_with_mjpeg(
        udid=udid,
        session_id=session_id,
        base_url=base_url,
        mjpeg_port=mjpeg_port,
        output_url=output_url,
        sanitized_output=sanitized_output_url,
    )


async def _start_stream_with_mjpeg(
    *,
    udid: str,
    session_id: str,
    base_url: str,
    mjpeg_port: int,
    output_url: str,
    sanitized_output: str,
) -> Optional[str]:
    input_url = _build_mjpeg_url(base_url, mjpeg_port)
    log_flags = _build_ffmpeg_log_flags()
    cmd = [
        FFMPEG_BIN,
        *log_flags,
        "-fflags",
        "nobuffer",
        "-use_wallclock_as_timestamps",
        "1",
        "-rw_timeout",
        "10000000",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-f",
        "mjpeg",
        "-i",
        input_url,
        "-sws_flags",
        "lanczos+accurate_rnd+full_chroma_int",
        "-vf",
        "fps=30,scale=720:-2,scale=in_range=pc:out_range=tv,format=yuv420p", # 720p, 30fps, yuv420p
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "high",
        "-g",
        "60", # keyframe every 2 seconds at 30fps
        "-x264-params",
        "bframes=0:keyint=50:min-keyint=50",
        "-crf",
        "18",
        "-color_range",
        "tv",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-rtmp_live",
        "live",
        "-rtmp_buffer",
        "100",
        "-flvflags",
        "no_duration_filesize",
        "-f",
        "flv",
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

        ffmpeg_task = asyncio.create_task(
            _pump_logs(udid, proc),
            name=f"ffmpeg-log-{udid}",
        )
        _STREAMS[udid] = _StreamState([proc], [ffmpeg_task])

        core.logger.info(
            "\033[1;36m🚀 FFMPEG 推流启动\033[0m | 设备: %s | 会话: %s | 输入: %s | 输出: %s | PID: %s",
            udid,
            session_id,
            input_url,
            output_url,
            proc.pid,
        )

        core.logger.info(
            "\033[1;36m📊 FFMPEG 推流参数\033[0m | 输出: 720p | 帧率: 30 | 编码器: libx264 | 码控: CRF18 | 硬件加速: 关闭 | 调试级别: %s",
            _FFMPEG_LOG_LEVEL.upper(),
        )

        if _FFMPEG_LOG_LEVEL in {"debug", "trace", "verbose"}:
            core.logger.info(
                "\033[1;33m🔍 FFMPEG 调试模式已启用\033[0m | 日志级别: %s | 将显示详细的编码和硬件加速信息",
                _FFMPEG_LOG_LEVEL.upper(),
            )

        sanitized_cmd = cmd.copy()
        sanitized_cmd[-1] = sanitized_output
        core.logger.info("\033[1;36m🔧 FFMPEG 完整命令\033[0m | %s", " ".join(sanitized_cmd))

    return None


async def _start_stream_with_idb(
    *,
    udid: str,
    session_id: str,
    output_url: str,
    sanitized_output: str,
) -> Optional[str]:
    log_flags = _build_ffmpeg_log_flags()
    idb_cmd = [
        IDB_BIN,
        "video-stream",
        "--udid",
        udid,
        "--fps",
        "30",
        "--format",
        "h264",
        "--compression-quality",
        "0.1",
    ]

    ffmpeg_cmd = [
        FFMPEG_BIN,
        *log_flags,
        "-hide_banner",
        "-fflags",
        "+genpts+nobuffer",
        "-r",
        "30",
        "-f",
        "h264",
        "-i",
        "pipe:0",
        "-c:v",
        "copy",
        "-bsf:v",
        "dump_extra",
        "-an",
        "-flvflags",
        "no_duration_filesize",
        "-flush_packets",
        "1",
        "-f",
        "flv",
        output_url,
    ]

    async with _LOCK:
        await _stop_stream_unlocked(udid)

        try:
            idb_proc = await asyncio.create_subprocess_exec(
                *idb_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=_STREAM_READER_LIMIT,
            )
        except FileNotFoundError:
            core.logger.error("\033[1;31m💥 IDB 可执行文件未找到\033[0m | 路径: %s", IDB_BIN)
            return "idb not found"
        except Exception as exc:  # noqa: BLE001
            core.logger.exception("\033[1;31m💥 IDB 视频流启动失败\033[0m | 设备: %s | 错误: %s", udid, str(exc))
            return str(exc)

        try:
            ffmpeg_proc = await asyncio.create_subprocess_exec(
                *ffmpeg_cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=_STREAM_READER_LIMIT,
            )
        except FileNotFoundError:
            await _terminate_process(idb_proc)
            core.logger.error("\033[1;31m💥 FFMPEG 可执行文件未找到\033[0m | 路径: %s", FFMPEG_BIN)
            return "ffmpeg not found"
        except Exception as exc:  # noqa: BLE001
            await _terminate_process(idb_proc)
            core.logger.exception("\033[1;31m💥 FFMPEG 启动失败\033[0m | 设备: %s | 错误: %s", udid, str(exc))
            return str(exc)

        pipe_task = asyncio.create_task(
            _pipe_stream(udid, idb_proc.stdout, ffmpeg_proc.stdin),
            name=f"idb-forward-{udid}",
        )
        idb_log_task = asyncio.create_task(
            _pump_idb_logs(udid, idb_proc),
            name=f"idb-log-{udid}",
        )
        ffmpeg_log_task = asyncio.create_task(
            _pump_logs(udid, ffmpeg_proc),
            name=f"ffmpeg-log-{udid}",
        )

        _STREAMS[udid] = _StreamState(
            [idb_proc, ffmpeg_proc],
            [pipe_task, idb_log_task, ffmpeg_log_task],
        )

        core.logger.info(
            "\033[1;36m🚀 IDB 推流启动\033[0m | 设备: %s | 会话: %s | 输出: %s | IDB PID: %s | FFMPEG PID: %s",
            udid,
            session_id,
            output_url,
            idb_proc.pid,
            ffmpeg_proc.pid,
        )

        core.logger.info(
            "\033[1;36m📊 IDB 推流参数\033[0m | 帧率: 30 | 编码器: copy | 调试级别: %s",
            _FFMPEG_LOG_LEVEL.upper(),
        )

        sanitized_ffmpeg_cmd = ffmpeg_cmd.copy()
        sanitized_ffmpeg_cmd[-1] = sanitized_output
        core.logger.info("\033[1;36m🔧 IDB 命令\033[0m | %s", " ".join(idb_cmd))
        core.logger.info("\033[1;36m🔧 FFMPEG 完整命令\033[0m | %s", " ".join(sanitized_ffmpeg_cmd))

    return None


async def _terminate_process(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return

    if proc.stdin is not None:
        try:
            proc.stdin.close()
            await proc.stdin.wait_closed()
        except AttributeError:
            pass
        except Exception:
            pass

    try:
        proc.terminate()
    except ProcessLookupError:
        return

    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            return
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(proc.wait(), timeout=3)


async def _pipe_stream(
    udid: str,
    source: Optional[asyncio.StreamReader],
    target: Optional[asyncio.StreamWriter],
) -> None:
    if source is None or target is None:
        return

    try:
        while True:
            chunk = await source.read(_STREAM_READ_CHUNK)
            if not chunk:
                break
            try:
                target.write(chunk)
                await target.drain()
            except (BrokenPipeError, ConnectionResetError):
                core.logger.warning("\033[1;33mPIPE\033[0m [%s] 输出管道断开", udid)
                break
            except RuntimeError as exc:
                message = str(exc).lower()
                if "closed" in message or "invalid state" in message:
                    core.logger.warning("\033[1;33mPIPE\033[0m [%s] 目标通道已关闭", udid)
                    break
                raise
    except asyncio.CancelledError:
        raise
    except BrokenPipeError:
        core.logger.warning("\033[1;33mPIPE\033[0m [%s] 输出管道断开", udid)
    except Exception:
        core.logger.exception("\033[1;31mPIPE\033[0m [%s] 数据转发异常", udid)
    finally:
        try:
            target.close()
        except Exception:
            pass
        with contextlib.suppress(Exception):
            await target.wait_closed()


async def _pump_idb_logs(udid: str, proc: asyncio.subprocess.Process) -> None:
    stream = proc.stderr
    if stream is None:
        await proc.wait()
        return

    try:
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode(errors="ignore").rstrip()
            if not text:
                continue
            core.logger.info("\033[1;35mIDB\033[0m [%s stderr] %s", udid, text)

        return_code = await proc.wait()
        if return_code != 0:
            core.logger.error(
                "\033[1;31m💥 IDB 进程异常退出\033[0m | 设备: %s | 退出码: %d",
                udid,
                return_code,
            )
        else:
            core.logger.info("\033[1;32m✅ IDB 进程正常结束\033[0m | 设备: %s", udid)
    except asyncio.CancelledError:
        core.logger.debug("\033[1;90mIDB\033[0m 日志泵已取消 | 设备: %s", udid)
        raise
    except Exception:
        core.logger.exception("\033[1;31m💥 IDB 日志泵异常\033[0m | 设备: %s", udid)


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
    tasks = [task for task in state.tasks if task is not None]
    processes = [proc for proc in state.processes if proc is not None]

    for task in tasks:
        task.cancel()

    for proc in processes:
        await _terminate_process(proc)

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    core.logger.info("\033[1;33m⏹️  推流停止\033[0m | 设备: %s", udid)


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
