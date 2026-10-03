"""가벼운 데이터 이전 (Alembic 도입 전, 앱 시작 시 한 번 실행되어도 안전하게 반복 가능)."""
from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Run

_OLD_CODE = re.compile(r"^B(\d+)-(\d+)$")


def migrate_run_codes(db: Session) -> int:
    """예전 런 ID 'B2-07' → '2차-07'"""
    n = 0
    for run in db.scalars(select(Run).where(Run.code.like("B%-%"))):
        m = _OLD_CODE.match(run.code)
        if m:
            run.code = f"{int(m.group(1))}차-{m.group(2)}"
            n += 1
    if n:
        db.commit()
    return n
