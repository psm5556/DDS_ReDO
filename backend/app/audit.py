from contextvars import ContextVar
from typing import Any

from sqlalchemy.orm import Session

from .models import AuditLog

# 이 요청이 사람이 화면에서 한 것이 아니라 AI 도우미(assistant)·MCP 클라이언트(mcp)·개인 토큰 API(api)를 통한 것이면 표시한다.
# 감사 로그 detail.via 에 남아, 나중에 "누가 무엇을 통해" 바꿨는지 구분할 수 있다.
audit_via: ContextVar[str | None] = ContextVar("audit_via", default=None)


def audit(db: Session, user_id: int | None, action: str, entity: str, entity_id: int | None = None,
          **detail: Any) -> None:
    """감사 로그 기록. 커밋은 호출 측에서 한다. 민감정보(측정값 원문 등)는 detail에 넣지 않는다."""
    via = audit_via.get()
    if via and "via" not in detail:
        detail["via"] = via
    db.add(AuditLog(user_id=user_id, action=action, entity=entity, entity_id=entity_id, detail=detail))
