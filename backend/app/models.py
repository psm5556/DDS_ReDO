"""DB 모델. CLAUDE.md 4장의 도메인 모델을 따른다.

프로토타입 단순화:
- 인자(Factor)·응답(Response)·프로젝트 설정은 Project.config(JSON)에 저장한다 (schemas.ProjectConfig로 검증).
- 마이그레이션(Alembic)은 사내 개발 시 도입한다. 현재는 create_all 사용.
"""
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class BusinessUnit(Base):
    __tablename__ = "business_units"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(200))


class Department(Base):
    __tablename__ = "departments"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    business_unit_id: Mapped[int] = mapped_column(ForeignKey("business_units.id"))


class User(Base):
    """사내 인증/인사 시스템이 원본이며, 이 테이블은 로그인 시 동기화되는 사본이다."""
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # 사번 등
    name: Mapped[str] = mapped_column(String(100))
    email: Mapped[str | None] = mapped_column(String(200), nullable=True)
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"), nullable=True)
    business_unit_id: Mapped[int | None] = mapped_column(ForeignKey("business_units.id"), nullable=True)
    system_role: Mapped[str] = mapped_column(String(20), default="user")  # user | bu_admin | admin
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    department: Mapped[Department | None] = relationship(lazy="joined")
    business_unit: Mapped[BusinessUnit | None] = relationship(lazy="joined")


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    business_unit_id: Mapped[int | None] = mapped_column(ForeignKey("business_units.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | completed | archived
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    source_project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    owner: Mapped[User] = relationship(foreign_keys=[owner_id], lazy="joined")


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(20))  # editor | runner | viewer (owner는 Project.owner_id)
    user: Mapped[User] = relationship(lazy="joined")


class ProjectFavorite(Base):
    """사용자별 즐겨찾기 (개인 설정, 다른 사람에게 보이지 않음)"""
    __tablename__ = "project_favorites"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DesignBatch(Base):
    __tablename__ = "design_batches"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(20))  # initial | active | manual | confirmation
    surrogate: Mapped[str | None] = mapped_column(String(20), nullable=True)
    surrogate_version: Mapped[str | None] = mapped_column(String(200), nullable=True)
    acquisition: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    seed: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("design_batches.id"), index=True)
    code: Mapped[str] = mapped_column(String(40))  # 사람이 읽는 런 ID (예: 2차-07)
    replicate_no: Mapped[int] = mapped_column(Integer, default=1)
    run_order: Mapped[int] = mapped_column(Integer, default=0)
    is_replicate_of_existing: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="planned")  # planned|running|done|failed|infeasible|excluded
    planned: Mapped[dict[str, float]] = mapped_column(JSON)
    actual: Mapped[dict[str, float]] = mapped_column(JSON)
    fail_reason: Mapped[str] = mapped_column(Text, default="")
    deviation_note: Mapped[str] = mapped_column(Text, default="")
    reason: Mapped[str] = mapped_column(Text, default="")  # 제안 사유 (쉬운 말)
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Measurement(Base):
    """측정값은 덮어쓰지 않는다. 수정 시 새 버전을 만들고 이전 버전의 is_current=False."""
    __tablename__ = "measurements"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), index=True)
    response_key: Mapped[str] = mapped_column(String(40))
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)
    excluded: Mapped[bool] = mapped_column(Boolean, default=False)
    exclude_reason: Mapped[str] = mapped_column(Text, default="")
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ModelVersion(Base):
    __tablename__ = "model_versions"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    response_key: Mapped[str] = mapped_column(String(40))
    surrogate: Mapped[str] = mapped_column(String(20))
    surrogate_version: Mapped[str] = mapped_column(String(200))
    data_hash: Mapped[str] = mapped_column(String(64))
    n_points: Mapped[int] = mapped_column(Integer)
    n_obs: Mapped[int] = mapped_column(Integer)
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    data_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # 재현용 학습 데이터
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Share(Base):
    __tablename__ = "shares"
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    target_type: Mapped[str] = mapped_column(String(20))  # user | department | business_unit | company
    target_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    permission: Mapped[str] = mapped_column(String(20), default="view")  # view | view_simulate
    mode: Mapped[str] = mapped_column(String(20), default="snapshot")  # snapshot | live
    response_key: Mapped[str] = mapped_column(String(40))
    surrogate: Mapped[str] = mapped_column(String(20), default="gp")
    model_version_id: Mapped[int | None] = mapped_column(ForeignKey("model_versions.id"), nullable=True)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    include_raw: Mapped[bool] = mapped_column(Boolean, default=False)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ShareViewLog(Base):
    __tablename__ = "share_view_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    share_id: Mapped[int] = mapped_column(ForeignKey("shares.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    viewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    user: Mapped[User] = relationship(lazy="joined")


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(60))
    entity: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
