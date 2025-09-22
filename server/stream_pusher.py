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
        # 取消输入缓冲，降低整体延迟
        "-fflags", "nobuffer",
        # 使用系统时钟作为时间戳，保持实时性
        "-use_wallclock_as_timestamps", "1",
        # 读取超时设置为 10 秒
        "-rw_timeout", "10000000",  # 10 second timeout
        # 打开断线重连开关
        "-reconnect", "1",
        # 针对流媒体与网络错误启用重连
        "-reconnect_streamed", "1",
        # 指定输入为 MJPEG
        "-f", "mjpeg",
        # MJPEG 输入地址
        "-i", input_url,
        # 使用高质量缩放算法和完整色度处理
        "-sws_flags", "lanczos+accurate_rnd+full_chroma_int",
        # 视频滤镜：限制25fps、缩放至720宽、PC转TV色彩范围、转换为YUV420格式
        "-vf", "fps=25,scale=720:-2,scale=in_range=pc:out_range=tv,format=yuv420p",
        # 使用软件H.264编码器
        "-c:v", "libx264",
        # 编码预设：速度优先，牺牲一定画质换取低延迟
        "-preset", "veryfast",
        # 零延迟调优：优化编码参数以降低延迟
        "-tune", "zerolatency",
        # 使用High配置文件，提高压缩效率
        "-profile:v", "high",
        # GOP长度50帧（约2秒）
        "-g", "50",
        # x264编码器参数：关闭B帧、固定GOP长度
        "-x264-params", "bframes=0:keyint=50:min-keyint=50",
        # 质量因子18，高质量设置（数值越低质量越好）
        "-crf", "18",
        # 色彩范围：TV范围（16-235）
        "-color_range", "tv",
        # 色彩原色：BT.709标准
        "-color_primaries", "bt709",
        # 色彩传输特性：BT.709伽马曲线
        "-color_trc", "bt709",
        # 色彩空间：BT.709
        "-colorspace", "bt709",
        # RTMP采用直播模式
        "-rtmp_live", "live",
        # RTMP缓冲区大小100ms，降低延迟
        "-rtmp_buffer", "100",
        # 禁止写入时长和文件大小元数据
        "-flvflags", "no_duration_filesize",
        # 输出格式为FLV
        "-f", "flv",
        # RTMP输出地址
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
            _pump_logs(udid, proc),
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
        # Log the full command for debugging
        core.logger.debug("ffmpeg command: %s", " ".join(cmd))
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
) -> None:

    async def _read(stream, prefix):
        if stream is None:
            return
        buffer = bytearray()

        def _emit(raw: bytes, *, truncated: bool = False) -> None:
            text = raw.decode(errors="ignore").rstrip()
            if truncated:
                text = f"{text} [truncated]"
            core.logger.debug("[ffmpeg %s %s] %s", udid, prefix, text)

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
            core.logger.error("ffmpeg process exited with code %d for udid=%s", return_code, udid)
        else:
            core.logger.info("ffmpeg process completed successfully for udid=%s", udid)
    except asyncio.CancelledError:
        core.logger.debug("ffmpeg log pump cancelled for udid=%s", udid)
        raise
    except Exception:
        core.logger.exception("Error in ffmpeg log pump for udid=%s", udid)
    finally:
        pass


def _build_mjpeg_url(base_url: str, port: int) -> str:
    parsed = urlparse(base_url)
    host = parsed.hostname or "127.0.0.1"
    scheme = parsed.scheme or "http"
    return f"{scheme}://{host}:{port}"



