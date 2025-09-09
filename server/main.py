import time
import json

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

import core
from routes.appium_proxy import router as appium_router
from routes.stream import router as stream_router
from routes.misc import router as misc_router


app = FastAPI(title="WDA-Web Console", version="1.0")


# 由 CORSMiddleware 处理预检；无需手动声明 OPTIONS 路由


@app.on_event("shutdown")
async def _shutdown_shared_http():
    # Ensure shared httpx client is closed gracefully
    try:
        await core.shutdown_http_client()
    except Exception:
        pass


@app.middleware("http")
async def access_log(request: Request, call_next):
    # Colors for readability in dev logs
    C_RESET = "\x1b[0m"; C_PATH = "\x1b[36m"; C_PARAM = "\x1b[35m"; C_OK = "\x1b[32m"; C_ERR = "\x1b[31m"; C_REQ = "\x1b[33m"; C_RESP = "\x1b[34m"
    start = time.perf_counter()
    method = request.method
    path = request.url.path
    params = {}
    try:
        if request.query_params:
            params["query"] = dict(request.query_params)
        body_bytes = await request.body()
        if body_bytes:
            try:
                params["body"] = json.loads(body_bytes)
            except Exception:
                params["body_text"] = body_bytes.decode("utf-8", errors="ignore")[:800]
    except Exception:
        pass

    try:
        raw = json.dumps(params, ensure_ascii=False)
        colored = f"{C_PARAM}{raw}{C_RESET}"
        core.logger.info(f"{C_REQ}REQ{C_RESET} {method} {C_PATH}{path}{C_RESET} params={colored}")
    except Exception:
        core.logger.info(f"{C_REQ}REQ{C_RESET} {method} {C_PATH}{path}{C_RESET}")
    try:
        response = await call_next(request)
        dur_ms = (time.perf_counter() - start) * 1000
        code = response.status_code
        c = C_OK if code < 400 else C_ERR

        # 仅对 /api/* 打印响应体，且跳过流式/二进制/大内容
        LOG_LIMIT = 2048  # 默认截断长度（字节近似，按 utf-8 解码）
        should_log_body = path.startswith('/api/')

        if should_log_body:
            # 跳过 StreamingResponse（如 /stream 等）
            if isinstance(response, StreamingResponse):
                core.logger.info(f"{C_RESP}RESP{C_RESET} {method} {C_PATH}{path}{C_RESET} -> {c}{code}{C_RESET} {dur_ms:.1f}ms")
                return response

            # 基于 Content-Type 与 Content-Length 粗略筛选
            ct = (response.headers.get('content-type') or '').lower()
            cl = response.headers.get('content-length')
            try:
                cl_num = int(cl) if cl is not None else None
            except Exception:
                cl_num = None

            is_textual = (
                ('application/json' in ct) or ('+json' in ct) or ct.startswith('text/') or not ct
            )
            looks_binary = (
                ct.startswith('image/') or ct.startswith('video/') or ct.startswith('audio/') or 'octet-stream' in ct
            )

            if (not is_textual) or looks_binary or (cl_num is not None and cl_num > 262144):  # >256KB 视为大内容
                core.logger.info(f"{C_RESP}RESP{C_RESET} {method} {C_PATH}{path}{C_RESET} -> {c}{code}{C_RESET} {dur_ms:.1f}ms")
                return response

            # 优先直接读取 response.body（若可用，不会消耗流）
            try:
                b = getattr(response, 'body', None)
            except Exception:
                b = None

            if isinstance(b, (bytes, bytearray)):
                txt = b.decode('utf-8', errors='ignore')
                snip = txt if len(txt) <= LOG_LIMIT else (txt[:LOG_LIMIT] + '…')
                core.logger.info(f"{C_RESP}RESP{C_RESET} {method} {C_PATH}{path}{C_RESET} -> {c}{code}{C_RESET} {dur_ms:.1f}ms body={snip}")
                return response

            # 回退：消费 body_iterator 捕获内容后重建 Response，确保不影响返回
            try:
                body_bytes = b''
                async for chunk in response.body_iterator:
                    if chunk:
                        body_bytes += chunk
                # 重建响应，保留关键信息（避免固定 Content-Length 以便框架自动计算）
                headers = dict(response.headers)
                headers.pop('content-length', None)
                new_resp = Response(
                    content=body_bytes,
                    status_code=response.status_code,
                    headers=headers,
                    media_type=response.media_type,
                    background=response.background,
                )
                txt = body_bytes.decode('utf-8', errors='ignore')
                snip = txt if len(txt) <= LOG_LIMIT else (txt[:LOG_LIMIT] + '…')
                core.logger.info(f"{C_RESP}RESP{C_RESET} {method} {C_PATH}{path}{C_RESET} -> {c}{code}{C_RESET} {dur_ms:.1f}ms body={snip}")
                return new_resp
            except Exception:
                # 捕获失败则回落到无 body 日志
                core.logger.info(f"{C_RESP}RESP{C_RESET} {method} {C_PATH}{path}{C_RESET} -> {c}{code}{C_RESET} {dur_ms:.1f}ms")
                return response

        # 非 /api/* 或其它情况：不打印 body
        core.logger.info(f"{C_RESP}RESP{C_RESET} {method} {C_PATH}{path}{C_RESET} -> {c}{code}{C_RESET} {dur_ms:.1f}ms")
        return response
    except Exception as e:
        dur_ms = (time.perf_counter() - start) * 1000
        core.logger.error(f"{C_RESP}RESP{C_RESET} {method} {C_PATH}{path}{C_RESET} -> {C_ERR}ERR{C_RESET} {dur_ms:.1f}ms msg={str(e)}")
        raise


# Mount routers (Appium and MJPEG stream only)
app.include_router(appium_router)
app.include_router(stream_router)
app.include_router(misc_router)

# 最后添加 CORS，使其成为最外层中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=86400,
)
