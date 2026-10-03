from typing import Any

from sqlalchemy.orm import Session

from .models import AuditLog


def audit(db: Session, user_id: int | None, action: str, entity: str, entity_id: int | None = None,
          **detail: Any) -> None:
    """감사 로그 기록. 커밋은 호출 측에서 한다. 민감정보(측정값 원문 등)는 detail에 넣지 않는다."""
    db.add(AuditLog(user_id=user_id, action=action, entity=entity, entity_id=entity_id, detail=detail))
