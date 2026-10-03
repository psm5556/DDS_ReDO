from __future__ import annotations

import time
from dataclasses import asdict

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import audit
from ..auth.deps import get_current_user
from ..authz import require_project
from ..config import get_settings
from ..db import get_db
from ..modeling.acquisition import propose_batch
from ..modeling.objectives import Objective
from ..modeling.surfaces import main_effects, surface
from ..modeling.surrogates.base import SurrogateUnavailable
from ..modeling.surrogates.registry import surrogate_catalog
from ..models import ModelVersion, User
from ..schemas import AcceptProposalIn, AnalysisIn, BatchOut, CompareIn, PredictIn, RecommendIn, SurfaceIn
from ..services.analysis import analyze, fitted_model, load_training, make_factory, resolve, space_of
from ..services.common import project_config
from .runs import _batch_out, create_batch

router = APIRouter(prefix="/api/projects/{project_id}", tags=["analysis"])


def predict_payload(cfg, model, X: np.ndarray, response_key: str) -> list[dict]:  # type: ignore[no-untyped-def]
    resp = cfg.response(response_key)
    sp = space_of(cfg)
    pr = model.predict(X)
    lo, hi = pr.mean_interval()
    has_spec = resp.lsl is not None or resp.usl is not None
    prob = pr.spec_probability(resp.lsl, resp.usl) if has_spec else None
    total_sd = np.sqrt(pr.total_var)
    out = []
    for i in range(len(X)):
        out.append({
            "x": sp.to_dicts(X[i])[0], "mean": float(pr.mean[i]), "mean_lo": float(lo[i]), "mean_hi": float(hi[i]),
            "sigma": float(pr.sigma[i]), "sigma_lo": float(np.sqrt(pr.aleatoric_var_lo[i])),
            "sigma_hi": float(np.sqrt(pr.aleatoric_var_hi[i])), "epistemic_sd": float(np.sqrt(pr.epistemic_var[i])),
            "obs_lo": float(pr.mean[i] - 1.96 * total_sd[i]), "obs_hi": float(pr.mean[i] + 1.96 * total_sd[i]),
            "spec_prob": None if prob is None else float(prob[i]),
        })
    return out


@router.post("/analysis")
def run_analysis(project_id: int, body: AnalysisIn, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)) -> dict:
    p, _ = require_project(db, user, project_id)
    cfg = project_config(p)
    rk, sur = resolve(cfg, body.response_key, body.surrogate)
    data, pending = load_training(db, p, cfg, rk)
    t0 = time.perf_counter()
    res = analyze(cfg, data, rk, sur, body.validate_model)
    res["elapsed_sec"] = round(time.perf_counter() - t0, 2)
    res["pending_runs"] = int(len(pending))
    exists = db.scalar(select(ModelVersion.id).where(ModelVersion.project_id == p.id, ModelVersion.response_key == rk,
                                                     ModelVersion.surrogate == sur,
                                                     ModelVersion.data_hash == res["data_hash"]))
    if exists is None:
        mv = ModelVersion(project_id=p.id, response_key=rk, surrogate=sur, surrogate_version=res["surrogate_version"],
                          data_hash=res["data_hash"], n_points=data.n_points, n_obs=data.n_obs,
                          metrics={k: v for k, v in (res["validation"] or {}).items()
                                   if k in ("rmse", "coverage95", "crps", "method", "status")},
                          settings={"seed": 0}, data_snapshot=data.to_snapshot(), created_by=user.id)
        db.add(mv)
        db.flush()
        res["model_version_id"] = mv.id
        db.commit()
    else:
        res["model_version_id"] = exists
    return res


@router.post("/surface")
def get_surface(project_id: int, body: SurfaceIn, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)) -> dict:
    p, _ = require_project(db, user, project_id)
    cfg = project_config(p)
    rk, sur = resolve(cfg, body.response_key, body.surrogate)
    keys = [f.key for f in cfg.factors]
    if body.x_factor not in keys or body.y_factor not in keys or body.x_factor == body.y_factor:
        raise HTTPException(400, "서로 다른 두 인자를 선택하세요.")
    data, _ = load_training(db, p, cfg, rk)
    model = fitted_model(cfg, data, sur)
    obj = Objective.build(cfg.response(rk), cfg.settings)
    return surface(space_of(cfg), model, data, obj, body.x_factor, body.y_factor, body.fixed, body.resolution)


@router.post("/effects")
def get_effects(project_id: int, body: PredictIn | None = None, response_key: str | None = None,
                surrogate: str | None = None, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)) -> list[dict]:
    p, _ = require_project(db, user, project_id)
    cfg = project_config(p)
    rk, sur = resolve(cfg, response_key, surrogate)
    data, _ = load_training(db, p, cfg, rk)
    model = fitted_model(cfg, data, sur)
    fixed = body.points[0] if body and body.points else {}
    return main_effects(space_of(cfg), model, fixed)


@router.post("/predict")
def predict(project_id: int, body: PredictIn, db: Session = Depends(get_db),
            user: User = Depends(get_current_user)) -> list[dict]:
    p, _ = require_project(db, user, project_id)
    cfg = project_config(p)
    rk, sur = resolve(cfg, body.response_key, body.surrogate)
    sp = space_of(cfg)
    try:
        X = sp.from_dicts(body.points)
    except KeyError:
        raise HTTPException(400, "모든 인자 값을 입력하세요.")
    data, _ = load_training(db, p, cfg, rk)
    model = fitted_model(cfg, data, sur)
    out = predict_payload(cfg, model, X, rk)
    from ..modeling.acquisition import is_extrapolation
    ex = is_extrapolation(sp, data, X)
    for o, e in zip(out, ex):
        o["extrapolation"] = bool(e)
    return out


@router.post("/recommend")
def recommend(project_id: int, body: RecommendIn, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)) -> dict:
    p, _ = require_project(db, user, project_id, "editor")
    cfg = project_config(p)
    rk, sur = resolve(cfg, body.response_key, body.surrogate)
    data, pending = load_training(db, p, cfg, rk)
    if data.n_points < 2:
        raise HTTPException(409, "결과가 입력된 실험점이 2개 이상 있어야 다음 실험을 제안할 수 있습니다.")
    obj = Objective.build(cfg.response(rk), cfg.settings, body.mode, body.robust_objective, body.k_sigma)
    q = min(body.batch_size or cfg.settings.batch_size, get_settings().max_batch_size)
    t0 = time.perf_counter()
    try:
        res = propose_batch(space_of(cfg), data, pending, make_factory(sur), obj, q,
                            get_settings().candidate_pool_size, body.seed)
    except SurrogateUnavailable as e:
        raise HTTPException(409, f"선택한 모델을 사용할 수 없습니다: {e}")
    model = fitted_model(cfg, data, sur)
    return {
        "response_key": rk, "surrogate": sur, "surrogate_version": model.version, "objective": res.objective,
        "mode": obj.mode, "objective_kind": obj.kind, "incumbent": res.incumbent, "pool_size": res.pool_size,
        "notes": res.notes, "proposals": [asdict(pp) for pp in res.proposals],
        "elapsed_sec": round(time.perf_counter() - t0, 2), "pending_runs": int(len(pending)),
        "decomposition_is_approximate": sur != "gp",
    }


@router.post("/batches/accept", response_model=BatchOut)
def accept(project_id: int, body: AcceptProposalIn, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)) -> BatchOut:
    p, _ = require_project(db, user, project_id, "editor")
    cfg = project_config(p)
    keys = [f.key for f in cfg.factors]
    pts = []
    for pr in body.proposals:
        x = pr.get("x") or {}
        if any(k not in x for k in keys):
            raise HTTPException(400, "제안점에 인자 값이 빠져 있습니다.")
        pts.append({"x": x, "kind": pr.get("kind", "new"), "reason": pr.get("reason", "")})
    b = create_batch(db, user, p, cfg, "active", pts, body.surrogate, body.surrogate_version, body.acquisition,
                     note=body.note or "능동학습 제안")
    db.commit()
    return _batch_out(db, b)


@router.post("/compare")
def compare(project_id: int, body: CompareIn, db: Session = Depends(get_db),
            user: User = Depends(get_current_user)) -> dict:
    """GP vs TabPFN 비교 (전문가 모드, CLAUDE.md 6.4절). 사용 불가 모델은 사유를 함께 반환."""
    p, _ = require_project(db, user, project_id)
    cfg = project_config(p)
    rk, _ = resolve(cfg, body.response_key, None)
    data, _ = load_training(db, p, cfg, rk)
    out = {"response_key": rk, "models": []}
    for c in surrogate_catalog():
        item = {"name": c["name"], "label": c["label"], "available": c["available"], "status": c["status"]}
        if c["available"]:
            t0 = time.perf_counter()
            try:
                item["result"] = analyze(cfg, data, rk, c["name"], True)
            except HTTPException as e:
                item["available"] = False
                item["status"] = str(e.detail)
            item["elapsed_sec"] = round(time.perf_counter() - t0, 2)
        out["models"].append(item)
    audit(db, user.id, "model.compare", "project", p.id, response=rk)
    db.commit()
    return out


@router.get("/model-versions")
def model_versions(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    p, _ = require_project(db, user, project_id)
    rows = db.scalars(select(ModelVersion).where(ModelVersion.project_id == p.id)
                      .order_by(ModelVersion.created_at.desc()).limit(50))
    return [{"id": m.id, "response_key": m.response_key, "surrogate": m.surrogate,
             "surrogate_version": m.surrogate_version, "n_points": m.n_points, "n_obs": m.n_obs, "metrics": m.metrics,
             "created_at": m.created_at} for m in rows]
