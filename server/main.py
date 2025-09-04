import time
import json

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

import core
from routes.control import router as control_router
from routes.appium_proxy import router as appium_router


app = FastAPI(title="WDA-Web Console", version="1.0")

# CORS: 允许前端 http://localhost:8080 访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=86400,
)


@app.options("/{path:path}")
async def _cors_preflight_passthrough(path: str) -> Response:
    # Some environments/browsers can be picky with CORS preflight; return 204 and
    # let CORSMiddleware attach the appropriate headers.
    return Response(status_code=204)


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
        core.logger.info(f"{C_RESP}RESP{C_RESET} {method} {C_PATH}{path}{C_RESET} -> {c}{code}{C_RESET} {dur_ms:.1f}ms")
        return response
    except Exception as e:
        dur_ms = (time.perf_counter() - start) * 1000
        core.logger.error(f"{C_RESP}RESP{C_RESET} {method} {C_PATH}{path}{C_RESET} -> {C_ERR}ERR{C_RESET} {dur_ms:.1f}ms msg={str(e)}")
        raise


# Mount routers
app.include_router(control_router)
app.include_router(appium_router)
