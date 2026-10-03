"""DB 데이터 ↔ 모델링 연결, 적합 모델 캐시."""
from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict

import numpy as np
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..modeling.acquisition import best_recipe
from ..modeling.data import TrainingData
from ..modeling.objectives import Objective
from ..modeling.space import Space
from ..modeling.surrogates.base import SurrogateModel, SurrogateUnavailable
from ..modeling.surrogates.registry import create_surrogate
from ..modeling.validation import cross_validate
from ..models import Measurement, Project, Run
from ..schemas import ProjectConfig

_CACHE: OrderedDict[str, SurrogateModel] = OrderedDict()
_LOCK = threading.Lock()
_MAX = 48


def space_of(cfg: ProjectConfig) -> Space:
    return Space(tuple(cfg.factors))


def resolve(cfg: ProjectConfig, response_key: str | None, surrogate: str | None) -> tuple[str, str]:
    rk = response_key or cfg.settings.primary_response or cfg.responses[0].key
    try:
        cfg.response(rk)
    except KeyError:
        raise HTTPException(400, "응답 키가 올바르지 않습니다.")
    return rk, surrogate or cfg.settings.default_surrogate


def load_training(db: Session, project: Project, cfg: ProjectConfig, response_key: str) -> tuple[TrainingData, np.ndarray]:
    sp = space_of(cfg)
    runs = list(db.scalars(select(Run).where(Run.project_id == project.id)))
    run_ids = [r.id for r in runs if r.status == "done"]
    meas = {}
    if run_ids:
        for m in db.scalars(select(Measurement).where(Measurement.run_id.in_(run_ids),
                                                      Measurement.response_key == response_key,
                                                      Measurement.is_current.is_(True))):
            meas[m.run_id] = m
    X, y, pending = [], [], []
    for r in runs:
        src = r.actual or r.planned
        if any(k not in src for k in sp.keys):
            continue
        if r.status == "done":
            m = meas.get(r.id)
            if m is None or m.value is None or m.excluded:
                continue
            X.append([float(src[k]) for k in sp.keys])
            y.append(float(m.value))
        elif r.status in ("planned", "running"):
            pending.append([float(r.planned[k]) for k in sp.keys])
    data = TrainingData(sp, np.array(X, dtype=float).reshape(-1, sp.d), np.array(y, dtype=float))
    return data, np.array(pending, dtype=float).reshape(-1, sp.d)


def _cfg_hash(cfg: ProjectConfig) -> str:
    return hashlib.sha256(json.dumps([f.model_dump() for f in cfg.factors], sort_keys=True).encode()).hexdigest()[:16]


def fitted_model(cfg: ProjectConfig, data: TrainingData, surrogate: str, seed: int = 0) -> SurrogateModel:
    if data.n_points < 2:
        raise HTTPException(409, "결과가 입력된 실험점이 2개 이상 있어야 분석할 수 있습니다.")
    key = f"{surrogate}|{_cfg_hash(cfg)}|{data.data_hash()}|{seed}"
    with _LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    try:
        model = create_surrogate(surrogate)
        model.fit(data, seed=seed)
    except SurrogateUnavailable as e:
        raise HTTPException(409, f"선택한 모델을 사용할 수 없습니다: {e}")
    with _LOCK:
        _CACHE[key] = model
        while len(_CACHE) > _MAX:
            _CACHE.popitem(last=False)
    return model


def make_factory(surrogate: str):  # type: ignore[no-untyped-def]
    def f() -> SurrogateModel:
        return create_surrogate(surrogate)
    return f


def data_summary(data: TrainingData) -> dict:
    return {"n_points": data.n_points, "n_obs": data.n_obs, "n_replicated_points": data.n_replicated_points}


def analysis_warnings(cfg: ProjectConfig, data: TrainingData, cv: dict | None, reliability: str,
                      surrogate: str) -> list[str]:
    w: list[str] = []
    need = cfg.recommended_initial_points()
    if data.n_points < need:
        w.append(f"실험점이 {data.n_points}개로 권장 수({need}개)보다 적습니다. 최적 레시피는 '후보'로만 보세요.")
    if reliability == "none":
        w.append("반복 측정이 없어 산포를 추정할 수 없습니다. 같은 조건을 2~3회 반복한 실험을 추가하세요.")
    elif reliability == "low":
        w.append("반복 측정한 조건이 적어 산포 예측의 신뢰도가 낮습니다.")
    if cv and cv.get("available") and cv.get("status") == "warn":
        w.extend(cv.get("messages", []))
    if surrogate == "tabpfn":
        w.append("TabPFN 결과는 평가용입니다. 불확실성 분해(산포/모델 불확실성)는 근사값입니다.")
    return w


def analyze(cfg: ProjectConfig, data: TrainingData, response_key: str, surrogate: str, validate: bool,
            seed: int = 0) -> dict:
    s = get_settings()
    model = fitted_model(cfg, data, surrogate, seed)
    resp = cfg.response(response_key)
    obj = Objective.build(resp, cfg.settings)
    best = best_recipe(space_of(cfg), data, model, obj, s.candidate_pool_size, seed)
    cv = cross_validate(data, make_factory(surrogate), s.loo_max_points, seed) if validate else None
    reliability = model.predict(data.X_pts[:1]).variance_reliability
    tentative = data.n_points < cfg.recommended_initial_points() or bool(cv and cv.get("status") == "warn")
    return {
        "response_key": response_key, "surrogate": surrogate, "surrogate_version": model.version,
        "data": data_summary(data), "objective": obj.label, "objective_kind": obj.kind,
        "best": best, "best_is_tentative": tentative, "validation": cv,
        "variance_reliability": reliability, "decomposition_is_approximate": surrogate != "gp",
        "warnings": analysis_warnings(cfg, data, cv, reliability, surrogate),
        "data_hash": data.data_hash(),
    }
