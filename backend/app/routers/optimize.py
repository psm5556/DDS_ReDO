"""다목적 레시피 최적화·다음 실험 제안 API (② 능동학습 결과 화면에서 사용)."""
from __future__ import annotations

import time

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth.deps import get_current_user
from ..authz import require_project
from ..config import get_settings
from ..db import get_db
from ..modeling import multi
from ..modeling.acquisition import is_extrapolation
from ..modeling.data import TrainingData
from ..modeling.objectives import Objective
from ..modeling.validation import cross_validate
from ..models import User
from ..schemas import AnalysisIn, PredictIn, ProjectConfig, RecommendIn
from ..services.analysis import analysis_warnings, data_summary, fitted_model, load_training, make_factory, space_of
from ..services.common import project_config

router = APIRouter(prefix="/api/projects/{project_id}", tags=["optimize"])


def _models(db: Session, p, cfg: ProjectConfig, sur: str, mode: str | None = None, validate: bool = False):  # type: ignore[no-untyped-def]
    """응답마다 학습(능동학습의 '모델 적합')하고 진단 정보를 만든다. 데이터가 부족한 응답은 건너뛴다."""
    rms: list[multi.RespModel] = []
    diag: list[dict] = []
    pending = None
    s = get_settings()
    for r in cfg.responses:
        data, pend = load_training(db, p, cfg, r.key)
        if pending is None:
            pending = pend
        info: dict = {"key": r.key, "name": r.name, "unit": r.unit, "weight": r.weight, "data": data_summary(data)}
        if data.n_points < 2:
            info["skipped"] = "결과가 입력된 실험점이 2개 이상 있어야 학습합니다."
            diag.append(info)
            continue
        model = fitted_model(cfg, data, sur)
        obj = Objective.build(r, cfg.settings, mode)
        reliability = model.predict(data.X_pts[:1]).variance_reliability
        cv = cross_validate(data, make_factory(sur), s.loo_max_points) if validate else None
        info.update({
            "criterion": obj.label, "variance_reliability": reliability,
            "validation": {k: cv.get(k) for k in ("available", "rmse", "coverage95", "status")} if cv else None,
            "warnings": analysis_warnings(cfg, data, cv, reliability, sur),
            "tentative": data.n_points < cfg.recommended_initial_points() or bool(cv and cv.get("status") == "warn"),
            "model_version": model.version,
        })
        diag.append(info)
        rms.append(multi.RespModel(r, obj, data, model, r.weight))
    if not rms:
        raise HTTPException(409, "결과가 입력된 실험점이 2개 이상 있어야 학습 결과를 볼 수 있습니다.")
    if all(rm.weight <= 0 for rm in rms):
        for rm in rms:
            rm.weight = 1.0
    return rms, diag, pending


@router.post("/optimize")
def optimize(project_id: int, body: AnalysisIn | None = None, db: Session = Depends(get_db),
             user: User = Depends(get_current_user)) -> dict:
    """능동학습 결과: 응답별 모델 + 다목적 최적 레시피 + 파레토 대안"""
    p, _ = require_project(db, user, project_id)
    cfg = project_config(p)
    sur = (body.surrogate if body else None) or cfg.settings.default_surrogate
    t0 = time.perf_counter()
    rms, diag, pending = _models(db, p, cfg, sur, validate=bool(body is None or body.validate_model))
    res = multi.optimize(space_of(cfg), rms, get_settings().candidate_pool_size)
    tentative = any(d.get("tentative") for d in diag if "skipped" not in d)
    return {
        "surrogate": sur, "responses": diag, "best": res["best"], "alternatives": res["alternatives"],
        "tentative": tentative, "pending_runs": int(len(pending)) if pending is not None else 0,
        "decomposition_is_approximate": sur != "gp", "pool_size": res["pool_size"],
        "elapsed_sec": round(time.perf_counter() - t0, 2),
    }


@router.post("/recommend-multi")
def recommend_multi(project_id: int, body: RecommendIn, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)) -> dict:
    """다목적 다음 실험(추가 DOE) 제안"""
    p, _ = require_project(db, user, project_id, "editor")
    cfg = project_config(p)
    sur = body.surrogate or cfg.settings.default_surrogate
    mode = body.mode or cfg.settings.mode
    t0 = time.perf_counter()
    rms, _diag, pending = _models(db, p, cfg, sur, mode=mode)
    q = min(body.batch_size or cfg.settings.batch_size, get_settings().max_batch_size)
    res = multi.propose(space_of(cfg), rms, pending, make_factory(sur), q, get_settings().candidate_pool_size,
                        body.seed, explore=mode == "explore")
    return {
        "surrogate": sur, "surrogate_version": rms[0].model.version, "mode": mode,
        "objective": "다목적 종합 점수(가중 기하평균 바람직함)" if mode != "explore" else "응답 표면 학습(불확실성 감소)",
        "responses": [{"key": rm.resp.key, "name": rm.resp.name, "weight": rm.weight, "criterion": rm.obj.label} for rm in rms],
        "incumbent": res["incumbent"], "pool_size": res["pool_size"], "notes": res["notes"], "proposals": res["proposals"],
        "elapsed_sec": round(time.perf_counter() - t0, 2), "pending_runs": int(len(pending)),
        "decomposition_is_approximate": sur != "gp",
    }


@router.post("/predict-multi")
def predict_multi(project_id: int, body: PredictIn, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)) -> list[dict]:
    """조건 시뮬레이션: 한 조건에서 모든 응답을 함께 예측하고, 응답별 만족도와 종합 점수(목표 달성)를 낸다."""
    p, _ = require_project(db, user, project_id)
    cfg = project_config(p)
    sur = body.surrogate or cfg.settings.default_surrogate
    rms, _diag, _pending = _models(db, p, cfg, sur)
    sp = space_of(cfg)
    try:
        X = sp.from_dicts(body.points)
    except KeyError:
        raise HTTPException(400, "모든 인자 값을 입력하세요.")
    multi.prepare(rms)
    preds = [rm.model.predict(X) for rm in rms]
    Ds, each = multi.mc_desirability(rms, preds, 0)
    obs = multi._observed(rms)
    extrap = is_extrapolation(sp, TrainingData(sp, obs, np.zeros(len(obs))), X)
    return [{"x": sp.to_dicts(X[i])[0], "desirability": float(Ds[:, i].mean()), "extrapolation": bool(extrap[i]),
             "responses": multi._per_response(rms, preds, i, each)} for i in range(len(X))]
