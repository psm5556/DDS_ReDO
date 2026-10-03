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


@lru_cache
def get_auth_provider() -> AuthProvider:
    return MockAuthProvider() if get_settings().auth_mode == "mock" else CorporateAuthProvider()


def optional_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    return get_auth_provider().authenticate(request, db)


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = get_auth_provider().authenticate(request, db)
    if user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    now = datetime.now(timezone.utc)
    last = user.last_login_at
    if last is None or (now - (last if last.tzinfo else last.replace(tzinfo=timezone.utc))).total_seconds() > 300:
        user.last_login_at = now
        db.commit()
    return user
