"""개발/테스트 전용 Mock 인증. 운영(prod)에서는 config.validate_settings가 기동을 거부한다."""
from __future__ import annotations

from fastapi import Request, Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..models import User
from .session import clear_session, read_session


class MockAuthProvider:
    mode = "mock"

    def login_redirect_url(self, return_to: str) -> str | None:
        return None

    def authenticate(self, request: Request, db: Session) -> User | None:
        uk = read_session(request)
        if not uk:
            return None
        user = db.scalar(select(User).where(User.user_key == uk))
        if user is None or not user.active:
            return None
        return user

    def logout(self, request: Request, response: Response) -> None:
        clear_session(response)

    def search_users(self, db: Session, query: str, limit: int = 20) -> list[User]:
        q = f"%{query.strip()}%"
        stmt = select(User).where(User.active.is_(True))
        if query.strip():
            stmt = stmt.where(or_(User.name.like(q), User.user_key.like(q), User.email.like(q)))
        return list(db.scalars(stmt.order_by(User.name).limit(limit)))
