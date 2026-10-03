"""예측 페이지 공유 (CLAUDE.md 8.4절): 스냅샷 생성(미리 계산), 실시간 계산."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np

from ..modeling.data import TrainingData
from ..modeling.objectives import Objective
from ..modeling.surfaces import main_effects, surface
from ..models import Project
from ..schemas import ProjectConfig
from .analysis import analyze, fitted_model, space_of


def training_from_snapshot(cfg: ProjectConfig, snap: dict) -> TrainingData:
    sp = space_of(cfg)
    X = np.array(snap["X"], dtype=float).reshape(-1, sp.d)
    return TrainingData(sp, X, np.array(snap["y"], dtype=float))


def build_payload(project: Project, cfg: ProjectConfig, data: TrainingData, response_key: str, surrogate: str,
                  include_raw: bool) -> dict:
    res = analyze(cfg, data, response_key, surrogate, validate=True)
    model = fitted_model(cfg, data, surrogate)
    sp = space_of(cfg)
    obj = Objective.build(cfg.response(response_key), cfg.settings)
    best_x = res["best"]["x"]
    surf = None
    if sp.d >= 2:
        surf = surface(sp, model, data, obj, sp.keys[0], sp.keys[1], best_x, 30)
        if not include_raw:
            surf["points"] = [{"x": pt["x"], "y": pt["y"]} for pt in surf["points"]]  # 위치만, 결과값 숨김
    effects = main_effects(sp, model, best_x)
    validation = res.get("validation") or {}
    payload = {
        "project": {"name": project.name, "description": project.description, "owner": project.owner.name,
                    "owner_department": project.owner.department.name if project.owner.department else None},
        "factors": [f.model_dump() for f in cfg.factors],
        "response": cfg.response(response_key).model_dump(),
        "surrogate": surrogate, "surrogate_version": res["surrogate_version"],
        "objective": res["objective"], "best": res["best"], "best_is_tentative": res["best_is_tentative"],
        "data": res["data"], "variance_reliability": res["variance_reliability"],
        "decomposition_is_approximate": res["decomposition_is_approximate"],
        "validation": {k: validation.get(k) for k in ("available", "method", "rmse", "coverage95", "status", "messages")},
        "warnings": res["warnings"], "surface": surf, "effects": effects,
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "raw": None,
    }
    if include_raw:
        payload["raw"] = {"keys": sp.keys, "X": data.X_obs.tolist(), "y": data.y_obs.tolist()}
    return payload
