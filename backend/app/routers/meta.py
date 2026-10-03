from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth.deps import get_auth_provider, get_current_user
from ..db import get_db
from ..modeling.surrogates.registry import surrogate_catalog
from ..authz import accessible_project_ids_stmt, project_role
from ..models import BusinessUnit, DesignBatch, Department, Project, Run, User
from ..services.common import project_config
from ..schemas import OrgUnitOut, UserOut
from ..services.common import user_out

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/surrogates")
def surrogates(user: User = Depends(get_current_user)) -> list[dict]:
    return surrogate_catalog()


@router.get("/users/search", response_model=list[UserOut])
def search_users(q: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[UserOut]:
    return [user_out(u) for u in get_auth_provider().search_users(db, q, 20)]


@router.get("/org-units", response_model=list[OrgUnitOut])
def org_units(q: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[OrgUnitOut]:
    like = f"%{q.strip()}%"
    out = [OrgUnitOut(type="business_unit", id=b.id, name=b.name)
           for b in db.scalars(select(BusinessUnit).where(BusinessUnit.name.like(like)).order_by(BusinessUnit.name))]
    for d in db.scalars(select(Department).where(Department.name.like(like)).order_by(Department.name)):
        bu = db.get(BusinessUnit, d.business_unit_id)
        out.append(OrgUnitOut(type="department", id=d.id, name=f"{d.name} ({bu.name if bu else ''})"))
    return out[:30]


@router.get("/me/open-runs")
def my_open_runs(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    """오늘 할 실험: 내가 결과를 입력할 수 있는 프로젝트의 미완료 런 (CLAUDE.md 7.2절 홈)."""
    from .runs import _run_out
    from ..services.results import current_measurements
    ids = list(db.scalars(accessible_project_ids_stmt(user)))
    out: list[dict] = []
    for p in db.scalars(select(Project).where(Project.id.in_(ids), Project.status == "active")):
        role = project_role(db, user, p)
        if role not in ("owner", "editor", "runner"):
            continue
        runs = list(db.scalars(select(Run).where(Run.project_id == p.id, Run.status.in_(["planned", "running"]))))
        if not runs:
            continue
        seq = {b.id: b.seq for b in db.scalars(select(DesignBatch).where(DesignBatch.project_id == p.id))}
        runs.sort(key=lambda r: (r.assignee_id != user.id, seq.get(r.batch_id, 0), r.run_order))
        cfg = project_config(p)
        meas = current_measurements(db, [r.id for r in runs])
        for r in runs:
            out.append({"project_id": p.id, "project_name": p.name, "my_role": role,
                        "assigned_to_me": r.assignee_id == user.id,
                        "factors": [f.model_dump() for f in cfg.factors],
                        "run": _run_out(r, seq.get(r.batch_id, 0), cfg, meas).model_dump(mode="json")})
    return out[:100]
