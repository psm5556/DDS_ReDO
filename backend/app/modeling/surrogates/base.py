"""대리모델 공통 인터페이스 (CLAUDE.md 5.2절).

획득함수·시각화·검증 코드는 이 인터페이스에만 의존한다.
모든 값은 응답의 원래 단위로 반환한다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np
from scipy.stats import norm

from ..data import TrainingData


class SurrogateUnavailable(RuntimeError):
    """설치·설정·라이선스 등의 이유로 대리모델을 사용할 수 없음."""


@dataclass
class Capabilities:
    differentiable: bool
    native_categorical: bool
    max_train_samples: int
    decomposition_exact: bool


@dataclass
class Prediction:
    mean: np.ndarray            # 평균 응답 μ(x)
    epistemic_var: np.ndarray   # 모델 불확실성 (평균의 불확실성)
    aleatoric_var: np.ndarray   # 산포 σ²(x) (중앙값 추정)
    aleatoric_var_lo: np.ndarray
    aleatoric_var_hi: np.ndarray
    alea_log_mean: np.ndarray   # log σ² 의 예측 평균 (MC 표본용)
    alea_log_std: np.ndarray    # log σ² 의 예측 표준편차
    decomposition_is_approximate: bool
    variance_reliability: str   # ok | low | none
    # 단일 관측값의 예측 분위수 (없으면 정규 근사 사용)
    q_levels: np.ndarray | None = None
    q_values: np.ndarray | None = None  # (len(q_levels), N)

    @property
    def sigma(self) -> np.ndarray:
        return np.sqrt(self.aleatoric_var)

    @property
    def total_var(self) -> np.ndarray:
        return self.epistemic_var + self.aleatoric_var

    def mean_interval(self, z: float = 1.96) -> tuple[np.ndarray, np.ndarray]:
        s = np.sqrt(self.epistemic_var)
        return self.mean - z * s, self.mean + z * s

    def spec_probability(self, lsl: float | None, usl: float | None) -> np.ndarray:
        """새로 1회 측정했을 때 규격 안에 들어올 확률."""
        if self.q_levels is not None and self.q_values is not None:
            return _prob_from_quantiles(self.q_levels, self.q_values, lsl, usl)
        sd = np.sqrt(np.maximum(self.total_var, 1e-30))
        hi = norm.cdf((usl - self.mean) / sd) if usl is not None else np.ones_like(self.mean)
        lo = norm.cdf((lsl - self.mean) / sd) if lsl is not None else np.zeros_like(self.mean)
        return np.clip(hi - lo, 0.0, 1.0)

    def take(self, idx: np.ndarray | list[int]) -> "Prediction":
        idx = np.asarray(idx)
        return Prediction(
            mean=self.mean[idx], epistemic_var=self.epistemic_var[idx], aleatoric_var=self.aleatoric_var[idx],
            aleatoric_var_lo=self.aleatoric_var_lo[idx], aleatoric_var_hi=self.aleatoric_var_hi[idx],
            alea_log_mean=self.alea_log_mean[idx], alea_log_std=self.alea_log_std[idx],
            decomposition_is_approximate=self.decomposition_is_approximate,
            variance_reliability=self.variance_reliability,
            q_levels=self.q_levels, q_values=None if self.q_values is None else self.q_values[:, idx])


def _prob_from_quantiles(levels: np.ndarray, values: np.ndarray, lsl: float | None, usl: float | None) -> np.ndarray:
    N = values.shape[1]
    out = np.empty(N)
    for i in range(N):
        q = np.maximum.accumulate(values[:, i])
        def cdf(v: float) -> float:
            return float(np.interp(v, q, levels, left=0.0, right=1.0))
        hi = cdf(usl) if usl is not None else 1.0
        lo = cdf(lsl) if lsl is not None else 0.0
        out[i] = max(0.0, min(1.0, hi - lo))
    return out


class SurrogateModel(Protocol):
    name: str
    capabilities: Capabilities

    @property
    def version(self) -> str: ...

    def fit(self, data: TrainingData, seed: int = 0, fast: bool = False) -> None: ...

    def predict(self, X: np.ndarray) -> Prediction: ...
