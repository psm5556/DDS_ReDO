from __future__ import annotations

import secrets
from datetime import datetime, timezone

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import audit
from ..auth.deps import get_current_user
from ..authz import can_view_share, project_role, require_project, share_is_active, share_targets_user
from ..db import get_db
from ..modeling.acquisition import is_extrapolation
from ..modeling.objectives import Objective
from ..modeling.surfaces import surface
from ..models import AuditLog, BusinessUnit, Department, ModelVersion, Project, Share, ShareViewLog, User
from ..schemas import PredictIn, ShareCreate, ShareOut, SurfaceIn
from ..services.analysis import fitted_model, load_training, resolve, space_of
from ..services.common import project_config
from ..services.sharing import build_payload, training_from_snapshot
from .analysis import predict_payload

router = APIRouter(prefix="/api", tags=["sharing"])


def _target_label(db: Session, s: Share) -> str:
    if s.target_type == "company":
        return "전사"
    if s.target_type == "user":
        u = db.get(User, s.target_id)
        return f"{u.name} ({u.department.name if u and u.department else ''})" if u else "알 수 없음"
    if s.target_type == "department":
        d = db.get(Department, s.target_id)
        return f"{d.name} (부서)" if d else "알 수 없음"
    b = db.get(BusinessUnit, s.target_id)
    return f"{b.name} (사업부)" if b else "알 수 없음"


def _share_out(db: Session, s: Share) -> ShareOut:
    p = db.get(Project, s.project_id)
    u = db.get(User, s.created_by)
    views = db.scalar(select(func.count()).select_from(ShareViewLog).where(ShareViewLog.share_id == s.id)) or 0
    return ShareOut(id=s.id, token=s.token, project_id=s.project_id, project_name=p.name if p else "",
                    target_type=s.target_type, target_id=s.target_id, target_label=_target_label(db, s),
                    permission=s.permission, mode=s.mode, response_key=s.response_key, surrogate=s.surrogate,
                    include_raw=s.include_raw, expires_at=s.expires_at, created_at=s.created_at,
                    created_by=u.name if u else "", revoked_at=s.revoked_at, view_count=views)


@router.get("/projects/{project_id}/shares", response_model=list[ShareOut])
def list_shares(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[ShareOut]:
    p, _ = require_project(db, user, project_id, "owner")
    return [_share_out(db, s) for s in db.scalars(select(Share).where(Share.project_id == p.id)
                                                 .order_by(Share.created_at.desc()))]


@router.post("/projects/{project_id}/shares", response_model=ShareOut)
def create_share(project_id: int, body: ShareCreate, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)) -> ShareOut:
    p, _ = require_project(db, user, project_id, "owner")
    cfg = project_config(p)
    rk, sur = resolve(cfg, body.response_key, body.surrogate)
    if body.target_type == "user" and (db.get(User, body.target_id) is None):
        raise HTTPException(404, "공유 대상 사용자를 찾을 수 없습니다.")
    if body.target_type == "department" and db.get(Department, body.target_id) is None:
        raise HTTPException(404, "부서를 찾을 수 없습니다.")
    if body.target_type == "business_unit" and db.get(BusinessUnit, body.target_id) is None:
        raise HTTPException(404, "사업부를 찾을 수 없습니다.")
    data, _ = load_training(db, p, cfg, rk)
    if data.n_points < 2:
        raise HTTPException(409, "공유할 예측 결과가 없습니다. 먼저 실험 결과를 입력하세요.")
    snapshot: dict = {}
    mv_id = None
    if body.mode == "snapshot":
        payload = build_payload(p, cfg, data, rk, sur, body.include_raw)
        mv = db.scalar(select(ModelVersion).where(ModelVersion.project_id == p.id, ModelVersion.response_key == rk,
                                                  ModelVersion.surrogate == sur,
                                                  ModelVersion.data_hash == data.data_hash()))
        if mv is None:
            mv = ModelVersion(project_id=p.id, response_key=rk, surrogate=sur,
                              surrogate_version=payload["surrogate_version"], data_hash=data.data_hash(),
                              n_points=data.n_points, n_obs=data.n_obs, metrics={}, settings={"seed": 0},
                              data_snapshot=data.to_snapshot(), created_by=user.id)
            db.add(mv)
            db.flush()
        mv_id = mv.id
        snapshot = {"payload": payload, "config": cfg.model_dump(), "data": data.to_snapshot()}
    s = Share(project_id=p.id, token=secrets.token_urlsafe(24), target_type=body.target_type,
              target_id=None if body.target_type == "company" else body.target_id, permission=body.permission,
              mode=body.mode, response_key=rk, surrogate=sur, model_version_id=mv_id, snapshot=snapshot,
              include_raw=body.include_raw, expires_at=body.expires_at, created_by=user.id)
    db.add(s)
    db.flush()
    audit(db, user.id, "share.create", "project", p.id, share=s.id, target=body.target_type, mode=body.mode)
    db.commit()
    return _share_out(db, s)


@router.delete("/projects/{project_id}/shares/{share_id}", response_model=ShareOut)
def revoke_share(project_id: int, share_id: int, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)) -> ShareOut:
    p, _ = require_project(db, user, project_id, "owner")
    s = db.get(Share, share_id)
    if s is None or s.project_id != p.id:
        raise HTTPException(404, "공유를 찾을 수 없습니다.")
    if s.revoked_at is None:
        s.revoked_at = datetime.now(timezone.utc)
        audit(db, user.id, "share.revoke", "project", p.id, share=s.id)
        db.commit()
    return _share_out(db, s)


@router.get("/projects/{project_id}/shares/{share_id}/views")
def share_views(project_id: int, share_id: int, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)) -> list[dict]:
    p, _ = require_project(db, user, project_id, "owner")
    s = db.get(Share, share_id)
    if s is None or s.project_id != p.id:
        raise HTTPException(404, "공유를 찾을 수 없습니다.")
    logs = db.scalars(select(ShareViewLog).where(ShareViewLog.share_id == s.id)
                      .order_by(ShareViewLog.viewed_at.desc()).limit(200))
    return [{"user": v.user.name, "department": v.user.department.name if v.user.department else None,
             "viewed_at": v.viewed_at} for v in logs]


@router.get("/projects/{project_id}/access-requests")
def access_requests(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    p, _ = require_project(db, user, project_id, "owner")
    rows = db.scalars(select(AuditLog).where(AuditLog.action == "share.access_request", AuditLog.entity == "project",
                                             AuditLog.entity_id == p.id).order_by(AuditLog.created_at.desc()).limit(50))
    out = []
    for a in rows:
        u = db.get(User, a.user_id) if a.user_id else None
        if u:
            out.append({"user_id": u.id, "user": u.name, "department": u.department.name if u.department else None,
                        "message": a.detail.get("message", ""), "at": a.created_at})
    return out


@router.get("/shares/received", response_model=list[ShareOut])
def received(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[ShareOut]:
    out = []
    for s in db.scalars(select(Share).where(Share.revoked_at.is_(None)).order_by(Share.created_at.desc())):
        p = db.get(Project, s.project_id)
        if p is None or p.deleted_at is not None or p.owner_id == user.id:
            continue
        if share_is_active(s) and share_targets_user(s, user):
            out.append(_share_out(db, s))
    return out


def _load_share(db: Session, token: str, user: User) -> tuple[Share, Project]:
    s = db.scalar(select(Share).where(Share.token == token))
    if s is None:
        raise HTTPException(404, "공유 링크를 찾을 수 없습니다.")
    if not can_view_share(db, user, s):
        p = db.get(Project, s.project_id)
        if s.revoked_at is not None or not share_is_active(s):
            raise HTTPException(410, {"code": "expired", "message": "공유가 철회되었거나 만료되었습니다."})
        raise HTTPException(403, {"code": "forbidden", "message": "접근 권한이 없습니다. 소유자에게 접근을 요청하세요.",
                                  "can_request": p is not None and p.deleted_at is None})
    return s, db.get(Project, s.project_id)  # type: ignore[return-value]


@router.get("/shared/{token}")
def view_shared(token: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    s, p = _load_share(db, token, user)
    if s.mode == "snapshot":
        payload = s.snapshot["payload"]
    else:
        cfg = project_config(p)
        data, _ = load_training(db, p, cfg, s.response_key)
        if data.n_points < 2:
            raise HTTPException(409, "현재 표시할 예측 결과가 없습니다.")
        payload = build_payload(p, cfg, data, s.response_key, s.surrogate, s.include_raw)
    db.add(ShareViewLog(share_id=s.id, user_id=user.id))
    db.commit()
    is_member = project_role(db, user, p) is not None
    return {"share": {"mode": s.mode, "permission": s.permission, "created_at": s.created_at,
                      "expires_at": s.expires_at, "include_raw": s.include_raw, "project_id": p.id if is_member else None},
            **payload}


def _shared_model(db: Session, s: Share, p: Project):  # type: ignore[no-untyped-def]
    if s.mode == "snapshot":
        from ..schemas import ProjectConfig
        cfg = ProjectConfig.model_validate(s.snapshot["config"])
        data = training_from_snapshot(cfg, s.snapshot["data"])
    else:
        cfg = project_config(p)
        data, _ = load_training(db, p, cfg, s.response_key)
    return cfg, data, fitted_model(cfg, data, s.surrogate)


@router.post("/shared/{token}/predict")
def shared_predict(token: str, body: PredictIn, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)) -> list[dict]:
    s, p = _load_share(db, token, user)
    if s.permission != "view_simulate":
        raise HTTPException(403, "이 공유에서는 조건 시뮬레이션을 사용할 수 없습니다.")
    cfg, data, model = _shared_model(db, s, p)
    sp = space_of(cfg)
    try:
        X = sp.from_dicts(body.points)
    except KeyError:
        raise HTTPException(400, "모든 인자 값을 입력하세요.")
    out = predict_payload(cfg, model, X, s.response_key)
    for o, e in zip(out, is_extrapolation(sp, data, X)):
        o["extrapolation"] = bool(e)
    return out


@router.post("/shared/{token}/surface")
def shared_surface(token: str, body: SurfaceIn, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)) -> dict:
    s, p = _load_share(db, token, user)
    if s.permission != "view_simulate":
        raise HTTPException(403, "이 공유에서는 단면 변경을 사용할 수 없습니다.")
    cfg, data, model = _shared_model(db, s, p)
    obj = Objective.build(cfg.response(s.response_key), cfg.settings)
    out = surface(space_of(cfg), model, data, obj, body.x_factor, body.y_factor, body.fixed, body.resolution)
    if not s.include_raw:
        out["points"] = [{"x": pt["x"], "y": pt["y"]} for pt in out["points"]]
    return out


@router.post("/shared/{token}/request-access")
def request_access(token: str, body: dict | None = None, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)) -> dict:
    s = db.scalar(select(Share).where(Share.token == token))
    if s is None:
        raise HTTPException(404, "공유 링크를 찾을 수 없습니다.")
    msg = str((body or {}).get("message", ""))[:500]
    audit(db, user.id, "share.access_request", "project", s.project_id, share=s.id, message=msg)
    db.commit()
    return {"ok": True, "message": "소유자에게 접근 요청을 보냈습니다."}
