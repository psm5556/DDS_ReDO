"""DDS ReDO — Recipe Design Optimization (산포 인지형 능동학습 DOE) API."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api_docs import apply_api_docs
from .audit import audit_via
from .auth.tokens import bearer_of
from .config import get_settings, validate_settings
from .db import Base, engine
from .routers import analysis, assistant, auth, meta, optimize, projects, runs, sharing

log = logging.getLogger("redo")


@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
    s = get_settings()
    validate_settings(s)
    Base.metadata.create_all(engine)  # 사내 개발 시 Alembic 마이그레이션으로 대체
    from .db import SessionLocal
    from .migrations import migrate_run_codes
    with SessionLocal() as db:
        migrate_run_codes(db)
    if s.env == "dev":
        from .seed import seed_if_empty
        seed_if_empty()
    yield


app = FastAPI(
    title="DDS ReDO API", version="0.2.0", lifespan=lifespan,
    description="산포 인지형 능동학습 DOE 웹앱 API. 모든 API는 로그인 세션 또는 개인 토큰(Authorization: Bearer redo_…)의 "
                "사용자 권한으로 동작한다. 상태를 바꾸는 요청은 세션일 때 X-Requested-With: ReDO 헤더가 필요하다.",
    generate_unique_id_function=lambda route: route.name,  # operationId = 함수 이름 (예: save_results)
)

_s = get_settings()
if _s.env != "prod":
    app.add_middleware(CORSMiddleware, allow_origins=[_s.frontend_origin], allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def csrf_guard(request: Request, call_next):  # type: ignore[no-untyped-def]
    """상태 변경 요청은 커스텀 헤더를 요구한다 (SameSite 쿠키 + 헤더 검사로 CSRF 방어).
    개인 토큰(Bearer) 요청은 쿠키를 쓰지 않으므로 CSRF 대상이 아니다. 대신 감사 로그에 경로(via)를 남긴다."""
    bearer = bearer_of(request) is not None
    if request.url.path.startswith("/api/") and request.method in ("POST", "PUT", "PATCH", "DELETE") and not bearer:
        if request.headers.get("x-requested-with") != "ReDO":
            return JSONResponse({"detail": "잘못된 요청입니다."}, status_code=403)
    tok = audit_via.set("mcp" if request.url.path.startswith("/mcp") else "api") if bearer else None
    try:
        return await call_next(request)
    finally:
        if tok is not None:
            audit_via.reset(tok)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):  # type: ignore[no-untyped-def]
    # 실험 데이터나 인증정보가 노출되지 않도록 내부 오류 내용은 응답에 넣지 않는다
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "서버에서 문제가 발생했습니다. 잠시 후 다시 시도하세요."}, status_code=500)


for r in (auth.router, meta.router, projects.router, runs.router, analysis.router, optimize.router, sharing.router,
          assistant.router, assistant.mcp_router):
    app.include_router(r)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


# 빌드된 프론트엔드(frontend/dist)가 있으면 같은 서버에서 제공 (SPA)
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    _dist_root = _dist.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):  # type: ignore[no-untyped-def]
        f = (_dist_root / path).resolve()
        # dist 밖으로 나가는 경로(../, %2e%2e 등)는 파일로 내주지 않는다
        if path and f.is_file() and f.is_relative_to(_dist_root):
            return FileResponse(f)
        return FileResponse(_dist_root / "index.html")


# 모든 경로를 등록한 뒤 API 설명서(한국어 요약·설명·분류)를 붙인다
apply_api_docs(app)
