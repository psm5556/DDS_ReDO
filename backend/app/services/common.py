from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import DesignBatch, Project, Run, User
from ..schemas import ProjectConfig, ProjectSummary, UserOut


def user_out(u: User) -> UserOut:
    return UserOut(id=u.id, user_key=u.user_key, name=u.name, email=u.email,
                   department=u.department.name if u.department else None, department_id=u.department_id,
                   business_unit=u.business_unit.name if u.business_unit else None,
                   business_unit_id=u.business_unit_id, system_role=u.system_role)


def project_config(p: Project) -> ProjectConfig:
    return ProjectConfig.model_validate(p.config)


def run_counts(db: Session, project_id: int) -> tuple[int, int, int, int]:
    rows = db.execute(select(Run.status, func.count()).where(Run.project_id == project_id).group_by(Run.status)).all()
    by = {s: c for s, c in rows}
    total = sum(by.values())
    done = by.get("done", 0)
    open_ = by.get("planned", 0) + by.get("running", 0)
    batches = db.scalar(select(func.count()).select_from(DesignBatch).where(DesignBatch.project_id == project_id)) or 0
    return total, done, open_, batches


def project_summary(db: Session, p: Project, role: str) -> ProjectSummary:
    total, done, open_, batches = run_counts(db, p.id)
    bu = p.owner.business_unit.name if p.owner and p.owner.business_unit else None
    return ProjectSummary(id=p.id, name=p.name, description=p.description, status=p.status, tags=p.tags or [],
                          owner=user_out(p.owner), business_unit=bu, my_role=role, runs_total=total, runs_done=done,
                          runs_open=open_, batches=batches, updated_at=p.updated_at, deleted_at=p.deleted_at,
                          primary_response=(p.config.get("settings") or {}).get("primary_response"))
