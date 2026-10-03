"""인증 어댑터 인터페이스 (CLAUDE.md 8.1절).

앱 내부 코드는 이 인터페이스와 models.User만 사용하며, 사내 로그인 API 형식에 직접 의존하지 않는다.
사내 로그인 연계 시 corporate.py의 CorporateAuthProvider만 구현하면 된다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from fastapi import Request, Response
from sqlalchemy.orm import Session

from ..models import User


@dataclass
class UserProfile:
    user_key: str
    name: str
    email: str | None
    department_code: str | None
    department_name: str | None
    business_unit_code: str | None
    business_unit_name: str | None
    active: bool = True


class AuthProvider(Protocol):
    mode: str

    def login_redirect_url(self, return_to: str) -> str | None:
        """사내 로그인 페이지 URL. Mock이면 None (앱 내 개발용 로그인 화면 사용)."""
        ...

    def authenticate(self, request: Request, db: Session) -> User | None:
        """요청의 세션/토큰을 검증하고 사용자를 반환. 비활성 사용자는 None."""
        ...

    def logout(self, request: Request, response: Response) -> None: ...

    def search_users(self, db: Session, query: str, limit: int = 20) -> list[User]:
        """공유·멤버 초대 대상 검색."""
        ...
