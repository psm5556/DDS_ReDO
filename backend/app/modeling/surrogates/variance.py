"""산포(σ²) 모델 공통 유틸: 반복 측정의 표본분산을 log 스케일로 다룬다 (CLAUDE.md 5.3절)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.special import digamma, polygamma

from ..data import TrainingData


@dataclass
class LogVarTargets:
    X_unit: np.ndarray   # 반복이 있는 실험점 (정규화 좌표)
    z: np.ndarray        # 편향 보정된 log(s²)
    noise: np.ndarray    # log(s²) 추정 분산 = trigamma((n-1)/2) ≈ 2/(n-1)


def log_var_targets(data: TrainingData, X_unit_pts: np.ndarray) -> LogVarTargets:
    m = (data.n_real >= 2) & np.isfinite(data.s2) & (data.s2 > 0)
    df = data.n_real[m] - 1.0
    # E[log s²] = log σ² + ψ(df/2) - log(df/2)  → 편향 보정
    z = np.log(data.s2[m]) - (digamma(df / 2.0) - np.log(df / 2.0))
    noise = polygamma(1, df / 2.0)
    return LogVarTargets(X_unit_pts[m], z, noise)


def pooled_log_var(data: TrainingData) -> tuple[float, float] | None:
    """반복점이 적을 때: 합동분산(pooled variance)의 log 값과 그 표준편차."""
    m = (data.n_real >= 2) & np.isfinite(data.s2)
    if not np.any(m):
        return None
    df = data.n_real[m] - 1.0
    s2p = float(np.sum(df * data.s2[m]) / np.sum(df))
    if s2p <= 0:
        s2p = 1e-12
    dft = float(np.sum(df))
    z = np.log(s2p) - (digamma(dft / 2.0) - np.log(dft / 2.0))
    return float(z), float(np.sqrt(polygamma(1, dft / 2.0)))


def variance_reliability(data: TrainingData) -> str:
    r = data.n_replicated_points
    if r == 0:
        return "none"
    if r < max(3, data.space.d + 1):
        return "low"
    return "ok"
