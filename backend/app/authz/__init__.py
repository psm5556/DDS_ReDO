"""권한 정책 (CLAUDE.md 8.3절). 모든 API는 이 모듈을 통해 권한을 확인한다.

- 접근 권한이 없는 프로젝트는 존재 자체를 알 수 없도록 404로 응답한다.
- 프론트엔드의 버튼 숨김은 편의일 뿐이며 보안은 서버에서 보장한다.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..models import Project, ProjectMember, Share, User

ROLE_RANK = {"viewer": 1, "runner": 2, "editor": 3, "owner": 4}
ROLE_LABEL = {"owner": "소유자", "editor": "편집자", "runner": "실험자", "viewer": "열람자"}


def project_role(db: Session, user: User, project: Project) -> str | None:
    if project.owner_id == user.id:
        return "owner"
    if project.deleted_at is not None:
        return None
    m = db.scalar(select(ProjectMember).where(ProjectMember.project_id == project.id,
                                              ProjectMember.user_id == user.id))
    return m.role if m else None


def require_project(db: Session, user: User, project_id: int, min_role: str = "viewer",
                    allow_deleted: bool = False) -> tuple[Project, str]:
    project = db.get(Project, project_id)
    not_found = HTTPException(404, "프로젝트를 찾을 수 없거나 접근 권한이 없습니다.")
    if project is None:
        raise not_found
    role = project_role(db, user, project)
    if role is None:
        raise not_found
    if project.deleted_at is not None and not allow_deleted:
        raise not_found
    if ROLE_RANK[role] < ROLE_RANK[min_role]:
        raise HTTPException(403, f"이 작업은 {ROLE_LABEL[min_role]} 이상만 할 수 있습니다.")
    return project, role


def accessible_project_ids_stmt(user: User):  # type: ignore[no-untyped-def]
    member_ids = select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)
    return select(Project.id).where(Project.deleted_at.is_(None),
                                    or_(Project.owner_id == user.id, Project.id.in_(member_ids)))


def share_is_active(share: Share) -> bool:
    if share.revoked_at is not None:
        return False
    if share.expires_at is not None:
        exp = share.expires_at if share.expires_at.tzinfo else share.expires_at.replace(tzinfo=timezone.utc)
        if exp <= datetime.now(timezone.utc):
            return False
    return True


def share_targets_user(share: Share, user: User) -> bool:
    if share.target_type == "company":
        return True
    if share.target_type == "user":
        return share.target_id == user.id
    if share.target_type == "department":
        return user.department_id is not None and share.target_id == user.department_id
    if share.target_type == "business_unit":
        return user.business_unit_id is not None and share.target_id == user.business_unit_id
    return False


def can_view_share(db: Session, user: User, share: Share) -> bool:
    project = db.get(Project, share.project_id)
    if project is None or project.deleted_at is not None or not user.active:
        return False
    role = project_role(db, user, project)
    if role is not None:  # 프로젝트 멤버는 공유 상태와 관계없이 열람 가능
        return True
    return share_is_active(share) and share_targets_user(share, user)
