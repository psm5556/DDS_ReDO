"""합성 벤치마크 (CLAUDE.md 6.3절-1): 무작위 탐색 vs 능동학습(GP / TabPFN).

이분산 잡음을 넣은 테스트 함수에서 '강건 목표(규격 만족 확률)'의 regret을 실험 수에 따라 비교한다.
TabPFN은 서버에서 REDO_TABPFN_ENABLED=true, REDO_TABPFN_MODEL_PATH 설정 시에만 포함된다.

  python -m scripts.benchmark --seeds 5 --iters 6 --batch 4
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np
from scipy.stats import norm

from app.modeling.acquisition import best_recipe, propose_batch
from app.modeling.data import TrainingData
from app.modeling.design import initial_design, space_filling
from app.modeling.objectives import Objective
from app.modeling.space import Space
from app.modeling.surrogates.registry import create_surrogate, surrogate_catalog
from app.schemas import FactorDef, ProjectSettings, ResponseDef

SP = Space((FactorDef(key="x1", name="x1", low=0, high=1, step=0.01),
            FactorDef(key="x2", name="x2", low=0, high=1, step=0.01),
            FactorDef(key="x3", name="x3", low=0, high=1, step=0.01)))
RESP = ResponseDef(key="y", name="y", goal="target", target=10.0, lsl=8.5, usl=11.5)


def truth(X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mu = 6 + 8 * X[:, 0] + 3 * np.sin(4 * X[:, 1]) - 2 * X[:, 2] ** 2
    sd = 0.2 + 1.6 * X[:, 1] ** 2 + 0.6 * (1 - X[:, 2])
    return mu, sd


def true_score(X: np.ndarray) -> np.ndarray:
    mu, sd = truth(X)
    return norm.cdf((RESP.usl - mu) / sd) - norm.cdf((RESP.lsl - mu) / sd)


def run(method: str, seed: int, iters: int, batch: int) -> list[float]:
    rng = np.random.default_rng(seed)
    obj = Objective.build(RESP, ProjectSettings(mode="robust", robust_objective="spec_prob"))
    runs = initial_design(SP, 10, "sobol", 0.3, 3, seed=seed)
    X = SP.from_dicts([r.x for r in runs])
    mu, sd = truth(X)
    y = mu + sd * rng.standard_normal(len(X))
    grid = space_filling(SP, 4000, "sobol", seed=999)
    best_possible = float(true_score(grid).max())
    regrets = []
    for it in range(iters + 1):
        data = TrainingData(SP, X, y)
        if method == "random":
            # 무작위 탐색의 추천: 관측된 실험점 중 경험적 점수가 가장 좋은 점
            emp = [np.mean(np.abs(data.y_mean[i] - RESP.target)) for i in range(data.n_points)]
            rec = data.X_pts[int(np.argmin(emp))]
        else:
            model = create_surrogate(method)
            model.fit(data, seed=seed)
            rec = SP.from_dicts([best_recipe(SP, data, model, obj, 1500, seed)["x"]])[0]
        regrets.append(best_possible - float(true_score(rec[None, :])[0]))
        if it == iters:
            break
        if method == "random":
            Xn = SP.snap(SP.from_unit(rng.random((batch, SP.d))))
        else:
            res = propose_batch(SP, data, np.empty((0, SP.d)), lambda: create_surrogate(method), obj, batch, 1500, seed)
            Xn = SP.from_dicts([p.x for p in res.proposals])
        m2, s2 = truth(Xn)
        X = np.vstack([X, Xn])
        y = np.concatenate([y, m2 + s2 * rng.standard_normal(len(Xn))])
    return regrets


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=5)
    ap.add_argument("--iters", type=int, default=6)
    ap.add_argument("--batch", type=int, default=4)
    a = ap.parse_args()
    methods = ["random", "gp"] + (["tabpfn"] if any(c["name"] == "tabpfn" and c["available"]
                                                     for c in surrogate_catalog()) else [])
    out = {}
    for m in methods:
        t0 = time.perf_counter()
        R = np.array([run(m, s, a.iters, a.batch) for s in range(a.seeds)])
        out[m] = {"mean_regret_by_iter": R.mean(0).round(4).tolist(), "sec": round(time.perf_counter() - t0, 1)}
        print(m, out[m])
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
