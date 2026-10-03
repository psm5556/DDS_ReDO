"""개인 접근 토큰 (MCP 클라이언트·사내 시스템용).

- 토큰은 'redo_' + 무작위 43자. 원문은 만들 때 한 번만 돌려주고 DB에는 SHA-256만 저장한다.
- 요청에 `Authorization: Bearer redo_…` 가 있으면 그 토큰 주인으로 인증한다 (세션 쿠키와 같은 권한 검사를 거친다).
- 폐기한 토큰, 비활성(퇴사·휴직) 사용자의 토큰은 바로 거부된다.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ApiToken, User

PREFIX = "redo_"


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def new_token(db: Session, user: User, name: str) -> tuple[ApiToken, str]:
    raw = PREFIX + secrets.token_urlsafe(32)
    t = ApiToken(user_id=user.id, name=name.strip()[:100] or "MCP", token_hash=hash_token(raw), prefix=raw[:12])
    db.add(t)
    db.flush()
    return t, raw


def bearer_of(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    if h[:7].lower() == "bearer " and h[7:].strip().startswith(PREFIX):
        return h[7:].strip()
    return None


def user_from_bearer(request: Request, db: Session) -> User | None:
    raw = bearer_of(request)
    if not raw:
        return None
    t = db.scalar(select(ApiToken).where(ApiToken.token_hash == hash_token(raw)))
    if t is None or t.revoked_at is not None:
        return None
    user = db.get(User, t.user_id)
    if user is None or not user.active:
        return None
    now = datetime.now(timezone.utc)
    last = t.last_used_at
    if last is None or (now - (last if last.tzinfo else last.replace(tzinfo=timezone.utc))).total_seconds() > 60:
        t.last_used_at = now
        db.commit()
    return user
