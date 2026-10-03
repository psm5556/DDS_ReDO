from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import audit
from ..auth.deps import get_auth_provider, get_current_user, optional_user
from ..auth.session import set_session
from ..config import get_settings
from ..db import get_db
from ..models import User
from ..schemas import UserOut
from ..services.common import user_out

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/config")
def auth_config() -> dict:
    s = get_settings()
    return {"auth_mode": s.auth_mode, "env": s.env}


@router.get("/me", response_model=UserOut | None)
def me(user: User | None = Depends(optional_user)) -> UserOut | None:
    return user_out(user) if user else None


@router.get("/login-url")
def login_url(return_to: str = "/") -> dict:
    return {"url": get_auth_provider().login_redirect_url(return_to)}


# ----- 개발 전용 Mock 로그인 -----
def _require_mock() -> None:
    if get_settings().auth_mode != "mock":
        raise HTTPException(404)


@router.get("/mock-users", response_model=list[UserOut], dependencies=[Depends(_require_mock)])
def mock_users(db: Session = Depends(get_db)) -> list[UserOut]:
    return [user_out(u) for u in db.scalars(select(User).where(User.active.is_(True)).order_by(User.id))]


class MockLoginIn(BaseModel):
    user_key: str


@router.post("/mock-login", response_model=UserOut, dependencies=[Depends(_require_mock)])
def mock_login(body: MockLoginIn, response: Response, db: Session = Depends(get_db)) -> UserOut:
    u = db.scalar(select(User).where(User.user_key == body.user_key, User.active.is_(True)))
    if u is None:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    set_session(response, u.user_key)
    audit(db, u.id, "auth.login", "user", u.id, mode="mock")
    db.commit()
    return user_out(u)


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)) -> dict:
    get_auth_provider().logout(request, response)
    audit(db, user.id, "auth.logout", "user", user.id)
    db.commit()
    return {"ok": True}
