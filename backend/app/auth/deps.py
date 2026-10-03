from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import User
from .base import AuthProvider
from .corporate import CorporateAuthProvider
from .mock import MockAuthProvider
from .tokens import bearer_of, user_from_bearer


@lru_cache
def get_auth_provider() -> AuthProvider:
    return MockAuthProvider() if get_settings().auth_mode == "mock" else CorporateAuthProvider()


def _authenticate(request: Request, db: Session) -> User | None:
    # 개인 토큰(Bearer)이 있으면 그것만 본다 — 잘못된 토큰이면 세션이 있어도 거부
    if bearer_of(request):
        return user_from_bearer(request, db)
    return get_auth_provider().authenticate(request, db)


def optional_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    return _authenticate(request, db)


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = _authenticate(request, db)
    if user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    now = datetime.now(timezone.utc)
    last = user.last_login_at
    if last is None or (now - (last if last.tzinfo else last.replace(tzinfo=timezone.utc))).total_seconds() > 300:
        user.last_login_at = now
        db.commit()
    return user
