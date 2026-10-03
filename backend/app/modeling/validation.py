"""모델 검증 (CLAUDE.md 5.6절): 실험점 단위 LOO(또는 K-fold) 교차검증.

실험점 평균 ȳ_i 에 대한 예측구간: μ ± 1.96·sqrt(epistemic + σ²/n_i)
"""
from __future__ import annotations

from collections.abc import Callable

import numpy as np
from scipy.stats import norm

from .data import TrainingData
from .surrogates.base import SurrogateModel


def _crps_gauss(y: np.ndarray, mu: np.ndarray, sd: np.ndarray) -> np.ndarray:
    z = (y - mu) / sd
    return sd * (z * (2 * norm.cdf(z) - 1) + 2 * norm.pdf(z) - 1 / np.sqrt(np.pi))


def cross_validate(data: TrainingData, make_model: Callable[[], SurrogateModel], max_points: int = 40,
                   seed: int = 0) -> dict:
    P = data.n_points
    if P < 4:
        return {"available": False, "message": "검증하려면 서로 다른 실험점이 4개 이상 필요합니다."}
    if P <= max_points:
        folds = [{p} for p in range(P)]
        method = "LOO"
    else:
        rng = np.random.default_rng(seed)
        perm = rng.permutation(P)
        folds = [set(perm[k::10].tolist()) for k in range(10)]
        method = "10-fold"
    mu = np.empty(P)
    sd = np.empty(P)
    for fold in folds:
        train = data.without_points(fold)
        if train.n_points < 2:
            continue
        m = make_model()
        m.fit(train, seed=seed, fast=True)
        idx = sorted(fold)
        pr = m.predict(data.X_pts[idx])
        mu[idx] = pr.mean
        sd[idx] = np.sqrt(pr.epistemic_var + pr.aleatoric_var / data.n[idx])
    y = data.y_mean
    resid = y - mu
    z = resid / np.maximum(sd, 1e-12)
    cover = float(np.mean(np.abs(z) <= 1.96))
    rmse = float(np.sqrt(np.mean(resid ** 2)))
    y_sd = float(np.std(y)) or 1.0
    status = "ok"
    msgs: list[str] = []
    if cover < 0.8:
        status = "warn"
        msgs.append("예측 구간이 실제 결과를 충분히 포함하지 못합니다 (구간이 너무 좁음). 추천의 신뢰도가 낮습니다.")
    elif cover > 0.995 and P >= 10:
        msgs.append("예측 구간이 다소 넓게 잡혀 있습니다 (보수적).")
    if rmse > 0.8 * y_sd:
        status = "warn"
        msgs.append("예측 오차가 응답의 변동 폭에 비해 큽니다. 실험을 더 추가하거나 인자 범위를 확인하세요.")
    return {
        "available": True, "method": method, "n_points": P,
        "rmse": rmse, "rmse_relative": rmse / y_sd, "coverage95": cover,
        "crps": float(np.mean(_crps_gauss(y, mu, np.maximum(sd, 1e-12)))),
        "std_residuals": [float(v) for v in z], "observed": [float(v) for v in y],
        "predicted": [float(v) for v in mu], "status": status, "messages": msgs,
    }
