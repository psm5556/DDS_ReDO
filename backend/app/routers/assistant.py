"""AI 도우미(DDS Conversa) · 개인 토큰 · MCP 엔드포인트."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..assistant import agent
from ..assistant.llm import LLMError
from ..assistant.mcp import handle_message
from ..audit import audit
from ..auth.deps import get_current_user
from ..auth.tokens import new_token, user_from_bearer
from ..config import get_settings
from ..db import get_db
from ..models import ApiToken, AssistantConversation, AssistantMessage, User

router = APIRouter(prefix="/api", tags=["AI 도우미"])
mcp_router = APIRouter(tags=["MCP"])


HISTORY_LIMIT = 30  # LLM에 넘기는 지난 대화 수


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000, description="사용자가 보낸 말")
    conversation_id: int | None = Field(default=None, description="이어 갈 대화. 없으면 새 대화를 만든다")
    project_id: int | None = Field(default=None, description="사용자가 지금 보고 있는 DOE")
    path: str | None = Field(default=None, max_length=200, description="지금 화면 주소")


class ConfirmIn(BaseModel):
    token: str = Field(min_length=10, max_length=8000)
    danger_ack: bool = Field(default=False, description="되돌리기 어려운 작업의 두 번째 확인('정말 실행')")
    message_id: int | None = Field(default=None, description="확인 카드가 있는 대화 메시지 (처리 결과를 대화에 남김)")


class RenameIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class TokenIn(BaseModel):
    name: str = Field(default="MCP", max_length=100)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(t: datetime) -> datetime:
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _conv(db: Session, user: User, cid: int) -> AssistantConversation:
    c = db.get(AssistantConversation, cid)
    if c is None or c.user_id != user.id:  # 다른 사람의 대화는 있는지도 알 수 없게
        raise HTTPException(404, "대화를 찾을 수 없습니다.")
    return c


def _msg_out(m: AssistantMessage) -> dict:
    p = dict(m.pending) if m.pending else None
    expired = bool(p and m.state is None and (_now() - _aware(m.created_at)).total_seconds() > agent.CONFIRM_TTL_SEC)
    return {"id": m.id, "role": m.role, "content": m.content, "pending": p, "state": "expired" if expired else m.state,
            "error": m.error, "created_at": m.created_at}


def _conv_out(db: Session, c: AssistantConversation) -> dict:
    n = db.scalar(select(func.count()).select_from(AssistantMessage).where(AssistantMessage.conversation_id == c.id)) or 0
    return {"id": c.id, "title": c.title, "created_at": c.created_at, "updated_at": c.updated_at, "message_count": n}


@router.get("/assistant/status")
def assistant_status(user: User = Depends(get_current_user)) -> dict:
    return agent.status()


@router.get("/assistant/conversations")
def list_conversations(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    rows = db.scalars(select(AssistantConversation).where(AssistantConversation.user_id == user.id)
                      .order_by(AssistantConversation.updated_at.desc()).limit(200))
    return [_conv_out(db, c) for c in rows]


@router.get("/assistant/conversations/{conversation_id}")
def get_conversation(conversation_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    c = _conv(db, user, conversation_id)
    msgs = db.scalars(select(AssistantMessage).where(AssistantMessage.conversation_id == c.id).order_by(AssistantMessage.id))
    return {"conversation": _conv_out(db, c), "messages": [_msg_out(m) for m in msgs]}


@router.patch("/assistant/conversations/{conversation_id}")
def rename_conversation(conversation_id: int, body: RenameIn, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)) -> dict:
    c = _conv(db, user, conversation_id)
    c.title = body.title.strip()[:120]
    db.commit()
    return _conv_out(db, c)


@router.delete("/assistant/conversations/{conversation_id}")
def delete_conversation(conversation_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    c = _conv(db, user, conversation_id)
    db.execute(delete(AssistantMessage).where(AssistantMessage.conversation_id == c.id))
    db.delete(c)
    db.commit()
    return {"ok": True}


@router.post("/assistant/chat")
def assistant_chat(body: ChatIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    if not get_settings().llm_enabled:
        raise HTTPException(503, "사내 LLM 연결 정보가 등록되지 않았습니다. 관리자에게 문의하세요.")
    text = body.message.strip()
    if body.conversation_id is not None:
        c = _conv(db, user, body.conversation_id)
    else:
        c = AssistantConversation(user_id=user.id, title=(text.splitlines()[0] if text else "새 대화")[:40])
        db.add(c)
        db.flush()
    # 지난 대화(서버에 저장된 것)를 문맥으로. 오류 메시지는 빼고.
    past = list(db.scalars(select(AssistantMessage).where(AssistantMessage.conversation_id == c.id, AssistantMessage.error.is_(False))
                           .order_by(AssistantMessage.id.desc()).limit(HISTORY_LIMIT)))[::-1]
    um = AssistantMessage(conversation_id=c.id, role="user", content=text)
    db.add(um)
    c.updated_at = _now()
    db.commit()  # 사용자의 말은 먼저 저장 (도구 오류로 되돌려져도 남도록)
    history = [{"role": m.role, "content": m.content} for m in past] + [{"role": "user", "content": text}]
    ui: list = []
    try:
        res = agent.run_chat(db, user, history, body.project_id, body.path)
        am = AssistantMessage(conversation_id=c.id, role="assistant", content=res["reply"], pending=res.get("pending"))
        ui = res.get("ui_actions", [])
    except LLMError as e:
        db.rollback()
        am = AssistantMessage(conversation_id=c.id, role="assistant", content=str(e), error=True)
    db.add(am)
    c = _conv(db, user, c.id)  # 오류로 되돌렸어도 다시 읽는다
    c.updated_at = _now()
    db.commit()
    return {"conversation": _conv_out(db, c), "messages": [_msg_out(um), _msg_out(am)], "ui_actions": ui}


def _own_message(db: Session, user: User, message_id: int) -> AssistantMessage:
    m = db.get(AssistantMessage, message_id)
    if m is None:
        raise HTTPException(404, "메시지를 찾을 수 없습니다.")
    _conv(db, user, m.conversation_id)
    return m


@router.post("/assistant/messages/{message_id}/cancel")
def cancel_pending(message_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    m = _own_message(db, user, message_id)
    if m.pending and m.state is None:
        m.state = "cancelled"
        db.commit()
    return _msg_out(m)


@router.post("/assistant/confirm")
def assistant_confirm(body: ConfirmIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    card = _own_message(db, user, body.message_id) if body.message_id else None
    if card is not None and card.state is not None:
        raise HTTPException(400, "이미 처리한 확인 카드입니다.")
    try:
        res = agent.confirm(db, user, body.token, body.danger_ack)
    except agent.ConfirmError as e:
        raise HTTPException(400, str(e)) from e
    if res["status"] != "ok":
        if card is not None:
            card = db.get(AssistantMessage, card.id)
            card.state = "error"  # type: ignore[union-attr]
            db.add(AssistantMessage(conversation_id=card.conversation_id, role="assistant",  # type: ignore[union-attr]
                                    content=res.get("message", "실행하지 못했습니다."), error=True))
            db.commit()
        raise HTTPException(422, res.get("message", "실행하지 못했습니다."))
    data = res["data"]
    out: dict = {"ok": True, "data": data, "ui_actions": [data["ui_action"]] if isinstance(data, dict) and data.get("ui_action") else []}
    if card is not None:
        card = db.get(AssistantMessage, card.id)
        card.state = "done"  # type: ignore[union-attr]
        done = AssistantMessage(conversation_id=card.conversation_id, role="assistant",  # type: ignore[union-attr]
                                content=f"✓ 실행했습니다: {(card.pending or {}).get('title', '')}")  # type: ignore[union-attr]
        db.add(done)
        conv = db.get(AssistantConversation, card.conversation_id)  # type: ignore[union-attr]
        conv.updated_at = _now()  # type: ignore[union-attr]
        db.commit()
        out["card"] = _msg_out(card)  # type: ignore[arg-type]
        out["message"] = _msg_out(done)
    return out


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
    if not get_settings().mcp_enabled:
        raise HTTPException(403, "앱 밖 AI(MCP) 연결이 꺼져 있습니다.")
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
