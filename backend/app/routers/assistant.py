"""AI 도우미(DDS Conversa) · 개인 토큰 · MCP 엔드포인트."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..assistant import agent
from ..assistant.llm import LLMError
from ..assistant.mcp import handle_message
from ..audit import audit
from ..auth.deps import get_current_user
from ..auth.tokens import new_token, user_from_bearer
from ..config import get_settings
from ..db import get_db
from ..models import ApiToken, User

router = APIRouter(prefix="/api", tags=["AI 도우미"])
mcp_router = APIRouter(tags=["MCP"])


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class ChatIn(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=60)
    project_id: int | None = Field(default=None, description="사용자가 지금 보고 있는 DOE")
    path: str | None = Field(default=None, max_length=200, description="지금 화면 주소")


class ConfirmIn(BaseModel):
    token: str = Field(min_length=10, max_length=8000)
    danger_ack: bool = Field(default=False, description="되돌리기 어려운 작업의 두 번째 확인('정말 실행')")


class TokenIn(BaseModel):
    name: str = Field(default="MCP", max_length=100)


@router.get("/assistant/status")
def assistant_status(user: User = Depends(get_current_user)) -> dict:
    return agent.status()


@router.post("/assistant/chat")
def assistant_chat(body: ChatIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    if not get_settings().llm_enabled:
        raise HTTPException(503, "사내 LLM 연결 정보가 등록되지 않았습니다. 관리자에게 문의하세요.")
    try:
        return agent.run_chat(db, user, [m.model_dump() for m in body.messages], body.project_id, body.path)
    except LLMError as e:
        raise HTTPException(502, str(e)) from e


@router.post("/assistant/confirm")
def assistant_confirm(body: ConfirmIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    try:
        res = agent.confirm(db, user, body.token, body.danger_ack)
    except agent.ConfirmError as e:
        raise HTTPException(400, str(e)) from e
    if res["status"] != "ok":
        raise HTTPException(422, res.get("message", "실행하지 못했습니다."))
    data = res["data"]
    return {"ok": True, "data": data, "ui_actions": [data["ui_action"]] if isinstance(data, dict) and data.get("ui_action") else []}


# ---------------- 개인 토큰 (MCP 연결용)
def _token_out(t: ApiToken) -> dict:
    return {"id": t.id, "name": t.name, "prefix": t.prefix + "…", "created_at": t.created_at, "last_used_at": t.last_used_at,
            "revoked": t.revoked_at is not None}


@router.get("/me/tokens")
def list_tokens(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    rows = db.scalars(select(ApiToken).where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None)).order_by(ApiToken.id.desc()))
    return [_token_out(t) for t in rows]


@router.post("/me/tokens")
def create_token(body: TokenIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    t, raw = new_token(db, user, body.name)
    audit(db, user.id, "token.create", "user", user.id, name=t.name, prefix=t.prefix)
    db.commit()
    return {**_token_out(t), "token": raw, "notice": "이 토큰은 지금 한 번만 보여 드립니다. 안전한 곳에 보관하세요."}


@router.delete("/me/tokens/{token_id}")
def revoke_token(token_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    t = db.get(ApiToken, token_id)
    if t is None or t.user_id != user.id or t.revoked_at is not None:
        raise HTTPException(404, "토큰을 찾을 수 없습니다.")
    t.revoked_at = datetime.now(timezone.utc)
    audit(db, user.id, "token.revoke", "user", user.id, prefix=t.prefix)
    db.commit()
    return {"ok": True}


# ---------------- MCP (POST /mcp, JSON-RPC 2.0)
def _mcp_user(request: Request, db: Session) -> User | None:
    return user_from_bearer(request, db)


@mcp_router.post("/mcp", include_in_schema=False)
def mcp_endpoint(request: Request, payload: Any = Body(...), db: Session = Depends(get_db)) -> Response:
    if not get_settings().mcp_enabled:
        return JSONResponse({"detail": "MCP가 꺼져 있습니다."}, status_code=404)
    user = _mcp_user(request, db)
    if user is None:
        return JSONResponse({"detail": "개인 토큰이 필요합니다 (Authorization: Bearer redo_…)."}, status_code=401,
                            headers={"WWW-Authenticate": 'Bearer realm="dds-redo"'})
    msgs = payload if isinstance(payload, list) else [payload]
    out = [r for r in (handle_message(db, user, m) for m in msgs) if r is not None]
    if not out:
        return Response(status_code=202)  # 알림만 받은 경우
    return JSONResponse(out if isinstance(payload, list) else out[0])


@mcp_router.get("/mcp", include_in_schema=False)
def mcp_get() -> Response:
    # 서버가 먼저 보내는 스트림(SSE)은 제공하지 않는다 (Streamable HTTP 규약상 405로 알림)
    return Response(status_code=405, headers={"Allow": "POST"})


@mcp_router.delete("/mcp", include_in_schema=False)
def mcp_delete() -> Response:
    return Response(status_code=200)
