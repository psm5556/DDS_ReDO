"""사내 로그인 시스템 연계 어댑터 — 추후 구현.

구현 전 필요한 사양 (CLAUDE.md 12장):
- 인증 방식(SSO 리다이렉트 / 토큰 / 세션), 로그인 페이지 URL과 return_to 파라미터 형식
- 토큰·세션 검증 API, 응답의 사용자 정보 필드(사번, 이름, 이메일, 부서, 사업부, 재직 상태)
- 조직도·사용자 검색 API 유무

연계 흐름(예시)
1) 미인증 사용자 → login_redirect_url()로 사내 로그인 페이지 이동
2) 사내 로그인 완료 후 /api/auth/callback 으로 돌아옴 → 사내 API로 토큰 검증
3) 사용자 프로필을 users 테이블에 동기화(upsert) → session.set_session()으로 앱 세션 발급
4) 매 요청: authenticate()에서 앱 세션 확인 + 주기적으로 사내 재직 상태 확인

사양 없이 추측으로 구현하지 않는다.
"""
from __future__ import annotations

from fastapi import Request, Response
from sqlalchemy.orm import Session

from ..models import User


class CorporateAuthProvider:
    mode = "corporate"

    def login_redirect_url(self, return_to: str) -> str | None:
        raise NotImplementedError("사내 로그인 연계가 아직 구현되지 않았습니다. corporate.py 주석의 사양을 확인하세요.")

    def authenticate(self, request: Request, db: Session) -> User | None:
        raise NotImplementedError("사내 로그인 연계가 아직 구현되지 않았습니다.")

    def logout(self, request: Request, response: Response) -> None:
        raise NotImplementedError

    def search_users(self, db: Session, query: str, limit: int = 20) -> list[User]:
        raise NotImplementedError
