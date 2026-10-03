from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from ..audit import audit
from ..auth.deps import get_current_user
from ..authz import require_project
from ..config import get_settings
from ..db import get_db
from ..models import AuditLog, Project, ProjectFavorite, ProjectMember, Run, User
from ..schemas import (MemberIn, MemberOut, ProjectConfig, ProjectCreate, ProjectDetail, ProjectSummary, ProjectUpdate,
                       TransferIn)
from ..services.common import project_config, project_summary, user_out

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _detail(db: Session, p: Project, role: str, user_id: int | None = None) -> ProjectDetail:
    s = project_summary(db, p, role, user_id)
    cfg = project_config(p)
    warns = []
    if p.deleted_at:
        days = get_settings().trash_retention_days
        warns.append(f"휴지통에 있는 프로젝트입니다. 삭제 후 {days}일 동안 복구할 수 있습니다.")
    return ProjectDetail(**s.model_dump(), config=cfg, warnings=warns)


@router.get("", response_model=list[ProjectSummary])
def list_projects(scope: str = "mine", q: str = "", status: str = "", db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)) -> list[ProjectSummary]:
    stmt = select(Project)
    if scope == "mine":
        stmt = stmt.where(Project.owner_id == user.id, Project.deleted_at.is_(None))
    elif scope == "member":
        ids = select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
        stmt = stmt.where(Project.id.in_(ids), Project.deleted_at.is_(None))
    elif scope == "trash":
        stmt = stmt.where(Project.owner_id == user.id, Project.deleted_at.is_not(None))
    else:
        raise HTTPException(400, "scope는 mine | member | trash 중 하나입니다.")
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Project.name.like(like), Project.description.like(like)))
    if status:
        stmt = stmt.where(Project.status == status)
    out = []
    for p in db.scalars(stmt.order_by(Project.updated_at.desc())):
        role = "owner" if p.owner_id == user.id else (
            db.scalar(select(ProjectMember.role).where(ProjectMember.project_id == p.id,
                                                       ProjectMember.user_id == user.id)) or "viewer")
        out.append(project_summary(db, p, role, user.id))
    return out


@router.post("", response_model=ProjectDetail)
def create_project(body: ProjectCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)) -> ProjectDetail:
    p = Project(name=body.name, description=body.description, tags=body.tags, owner_id=user.id,
                business_unit_id=user.business_unit_id, config=body.config.model_dump())
    db.add(p)
    db.flush()
    audit(db, user.id, "project.create", "project", p.id)
    db.commit()
    return _detail(db, p, "owner", user.id)


@router.get("/{project_id}", response_model=ProjectDetail)
def get_project(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ProjectDetail:
    p, role = require_project(db, user, project_id, allow_deleted=True)
    return _detail(db, p, role, user.id)


@router.patch("/{project_id}", response_model=ProjectDetail)
def update_project(project_id: int, body: ProjectUpdate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)) -> ProjectDetail:
    p, role = require_project(db, user, project_id, "editor")
    changes: dict = {}
    if body.name is not None:
        p.name = body.name
        changes["name"] = body.name
    if body.description is not None:
        p.description = body.description
    if body.tags is not None:
        p.tags = body.tags
    if body.status is not None:
        p.status = body.status
        changes["status"] = body.status
    if body.config is not None:
        old = ProjectConfig.model_validate(p.config)
        new = body.config
        has_runs = db.scalar(select(Run.id).where(Run.project_id == p.id).limit(1)) is not None
        if has_runs:
            old_f = {f.key for f in old.factors}
            new_f = {f.key for f in new.factors}
            old_r = {r.key for r in old.responses}
            if not old_f <= new_f:
                raise HTTPException(409, "실험 데이터가 있는 프로젝트에서는 인자를 삭제할 수 없습니다. 새 DOE로 복제해서 시작하세요.")
            if not old_r <= {r.key for r in new.responses}:
                raise HTTPException(409, "실험 데이터가 있는 응답은 삭제할 수 없습니다.")
            added = [f for f in new.factors if f.key in new_f - old_f]
            missing = [f.name for f in added if f.key not in body.new_factor_values]
            if missing:
                raise HTTPException(422, f"새 인자 '{', '.join(missing)}'의 기존 실험 값(그동안 고정해 둔 값)을 입력하세요.")
            fill: dict[str, float] = {}
            for f in added:
                v = float(body.new_factor_values[f.key])
                if not (f.low <= v <= f.high):
                    raise HTTPException(422, f"'{f.name}'의 기존 실험 값 {v:g}이(가) 범위({f.low:g}~{f.high:g}) 밖입니다.")
                fill[f.key] = v
            if fill:
                # 기존 런에는 새 인자를 그동안 고정해 둔 값으로 채워 학습 데이터에서 빠지지 않게 한다
                for run in db.scalars(select(Run).where(Run.project_id == p.id)):
                    run.planned = {**run.planned, **fill}
                    if run.actual:
                        run.actual = {**run.actual, **fill}
                changes["added_factors"] = fill
        p.config = new.model_dump()
        changes["config"] = True
        changes["reason"] = body.change_reason
    audit(db, user.id, "project.update", "project", p.id, **changes)
    db.commit()
    return _detail(db, p, role, user.id)


@router.post("/{project_id}/duplicate", response_model=ProjectDetail)
def duplicate(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ProjectDetail:
    p, _ = require_project(db, user, project_id, "viewer")
    n = Project(name=f"{p.name} (복제)", description=p.description, tags=list(p.tags or []), owner_id=user.id,
                business_unit_id=user.business_unit_id, config=p.config, source_project_id=p.id)
    db.add(n)
    db.flush()
    audit(db, user.id, "project.duplicate", "project", n.id, source=p.id)
    db.commit()
    return _detail(db, n, "owner", user.id)


@router.delete("/{project_id}")
def soft_delete(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    p, _ = require_project(db, user, project_id, "owner")
    p.deleted_at = datetime.now(timezone.utc)
    audit(db, user.id, "project.delete", "project", p.id)
    db.commit()
    return {"ok": True, "restorable_until": (p.deleted_at + timedelta(days=get_settings().trash_retention_days))}


@router.post("/{project_id}/restore", response_model=ProjectDetail)
def restore(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ProjectDetail:
    p, role = require_project(db, user, project_id, "owner", allow_deleted=True)
    p.deleted_at = None
    audit(db, user.id, "project.restore", "project", p.id)
    db.commit()
    return _detail(db, p, role, user.id)


# ---------- 멤버 ----------
@router.get("/{project_id}/members", response_model=list[MemberOut])
def members(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[MemberOut]:
    p, _ = require_project(db, user, project_id)
    out = [MemberOut(user=user_out(p.owner), role="owner")]
    for m in db.scalars(select(ProjectMember).where(ProjectMember.project_id == p.id)):
        out.append(MemberOut(user=user_out(m.user), role=m.role))
    return out


@router.post("/{project_id}/members", response_model=list[MemberOut])
def add_member(project_id: int, body: MemberIn, db: Session = Depends(get_db),
               user: User = Depends(get_current_user)) -> list[MemberOut]:
    p, _ = require_project(db, user, project_id, "owner")
    target = db.get(User, body.user_id)
    if target is None or not target.active:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    if target.id == p.owner_id:
        raise HTTPException(400, "소유자는 이미 모든 권한을 가지고 있습니다.")
    m = db.scalar(select(ProjectMember).where(ProjectMember.project_id == p.id, ProjectMember.user_id == target.id))
    if m:
        m.role = body.role
    else:
        db.add(ProjectMember(project_id=p.id, user_id=target.id, role=body.role))
    audit(db, user.id, "member.set", "project", p.id, member=target.id, role=body.role)
    db.commit()
    return members(project_id, db, user)


@router.delete("/{project_id}/members/{user_id}", response_model=list[MemberOut])
def remove_member(project_id: int, user_id: int, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)) -> list[MemberOut]:
    p, _ = require_project(db, user, project_id, "owner")
    db.execute(delete(ProjectMember).where(ProjectMember.project_id == p.id, ProjectMember.user_id == user_id))
    db.execute(delete(ProjectFavorite).where(ProjectFavorite.project_id == p.id, ProjectFavorite.user_id == user_id))
    audit(db, user.id, "member.remove", "project", p.id, member=user_id)
    db.commit()
    return members(project_id, db, user)


@router.post("/{project_id}/transfer", response_model=ProjectDetail)
def transfer(project_id: int, body: TransferIn, db: Session = Depends(get_db),
             user: User = Depends(get_current_user)) -> ProjectDetail:
    p = db.get(Project, project_id)
    is_bu_admin = (user.system_role in ("bu_admin", "admin") and p is not None
                   and p.business_unit_id == user.business_unit_id and not p.owner.active)
    if not is_bu_admin:
        p, _ = require_project(db, user, project_id, "owner")
    assert p is not None
    target = db.get(User, body.new_owner_id)
    if target is None or not target.active:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    old_owner = p.owner_id
    p.owner_id = target.id
    db.execute(delete(ProjectMember).where(ProjectMember.project_id == p.id, ProjectMember.user_id == target.id))
    if old_owner != target.id and db.get(User, old_owner) and db.get(User, old_owner).active:  # type: ignore[union-attr]
        db.add(ProjectMember(project_id=p.id, user_id=old_owner, role="editor"))
    audit(db, user.id, "project.transfer", "project", p.id, frm=old_owner, to=target.id)
    db.commit()
    db.refresh(p)
    role = "owner" if p.owner_id == user.id else "editor"
    return _detail(db, p, role, user.id)


@router.get("/{project_id}/audit")
def audit_log(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    p, _ = require_project(db, user, project_id, "editor")
    rows = db.scalars(select(AuditLog).where(AuditLog.entity == "project", AuditLog.entity_id == p.id)
                      .order_by(AuditLog.created_at.desc()).limit(200))
    out = []
    for a in rows:
        u = db.get(User, a.user_id) if a.user_id else None
        out.append({"action": a.action, "user": u.name if u else None, "detail": a.detail, "at": a.created_at})
    return out


@router.put("/{project_id}/favorite")
def add_favorite(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    p, _ = require_project(db, user, project_id)
    if db.scalar(select(ProjectFavorite.id).where(ProjectFavorite.project_id == p.id,
                                                  ProjectFavorite.user_id == user.id)) is None:
        db.add(ProjectFavorite(project_id=p.id, user_id=user.id))
        db.commit()
    return {"favorite": True}


@router.delete("/{project_id}/favorite")
def remove_favorite(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    p, _ = require_project(db, user, project_id)
    db.execute(delete(ProjectFavorite).where(ProjectFavorite.project_id == p.id, ProjectFavorite.user_id == user.id))
    db.commit()
    return {"favorite": False}
