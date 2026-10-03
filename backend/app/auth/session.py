"""앱 세션 쿠키 (서명된 쿠키, HttpOnly). 사내 인증 연계 후에도 앱 세션은 이 방식으로 유지할 수 있다."""
from __future__ import annotations

from fastapi import Request, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from ..config import get_settings


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(get_settings().secret_key, salt="redo-session")


def set_session(response: Response, user_key: str) -> None:
    s = get_settings()
    response.set_cookie(
        s.session_cookie, _serializer().dumps({"uk": user_key}), max_age=s.session_max_age_sec,
        httponly=True, samesite="lax", secure=s.env == "prod", path="/",
    )


def clear_session(response: Response) -> None:
    response.delete_cookie(get_settings().session_cookie, path="/")


def read_session(request: Request) -> str | None:
    s = get_settings()
    raw = request.cookies.get(s.session_cookie)
    if not raw:
        return None
    try:
        data = _serializer().loads(raw, max_age=s.session_max_age_sec)
    except (BadSignature, SignatureExpired):
        return None
    uk = data.get("uk") if isinstance(data, dict) else None
    return uk if isinstance(uk, str) else None
