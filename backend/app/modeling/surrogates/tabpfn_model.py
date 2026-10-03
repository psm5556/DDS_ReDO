"""TabPFN 대리모델 — 실험적 (CLAUDE.md 5.3절 B, 6장).

주의
- 이 모듈은 환경(가중치 파일, GPU 등)이 갖춰진 서버에서 검증되지 않았다. 사내 검증(6.3절) 전에는 기본 모델로 쓰지 않는다.
- tabpfn 패키지 API(예: predict의 output_type, quantiles 인자)는 버전마다 다를 수 있으므로
  설치된 버전의 공식 문서로 확인하고 `tests/test_tabpfn_contract.py`(서버에서만 실행)로 계약을 검증한다.
- 가중치는 서버 로컬 경로(REDO_TABPFN_MODEL_PATH)에서만 로드한다. 런타임 자동 다운로드 금지.
- 텔레메트리 비활성화는 설치 버전의 문서에 명시된 환경변수로 설정한다 (README 참고).
- 가중치 라이선스는 버전마다 다르다. 운영 사용 전 법무 확인 필수 (6.2절).

불확실성 분해(근사)
- 평균·전체 예측분포: 개별 반복 관측 전체를 문맥으로 넣어 단일 관측값의 분포 → V_total
- 산포: 반복점의 log(s²)를 별도 TabPFN 회귀로 예측 (부족하면 합동분산)
- 모델 불확실성 ≈ max(V_total − σ̂², 0)  → decomposition_is_approximate = True
"""
from __future__ import annotations

import hashlib
import os
from functools import lru_cache

import numpy as np

from ...config import get_settings
from ..data import TrainingData
from .base import Capabilities, Prediction, SurrogateUnavailable
from .variance import log_var_targets, pooled_log_var, variance_reliability

Q_LEVELS = np.array([0.025, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.975])


@lru_cache(maxsize=4)
def _verify_weights(path: str, expected_sha256: str) -> None:
    if not path or not os.path.isfile(path):
        raise SurrogateUnavailable("TabPFN 가중치 파일이 없습니다. REDO_TABPFN_MODEL_PATH를 확인하세요.")
    if expected_sha256:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest().lower() != expected_sha256.lower():
            raise SurrogateUnavailable("TabPFN 가중치 파일의 해시가 설정값과 다릅니다.")


def tabpfn_status() -> tuple[bool, str]:
    s = get_settings()
    if not s.tabpfn_enabled:
        return False, "관리자 설정에서 TabPFN이 꺼져 있습니다."
    try:
        import tabpfn  # noqa: F401
    except Exception:
        return False, "서버에 tabpfn 패키지가 설치되어 있지 않습니다."
    try:
        _verify_weights(s.tabpfn_model_path, s.tabpfn_model_sha256)
    except SurrogateUnavailable as e:
        return False, str(e)
    return True, "사용 가능 (실험적)"


class TabPFNSurrogate:
    name = "tabpfn"
    capabilities = Capabilities(differentiable=False, native_categorical=True, max_train_samples=10000,
                                decomposition_exact=False)

    def __init__(self) -> None:
        ok, reason = tabpfn_status()
        if not ok:
            raise SurrogateUnavailable(reason)
        s = get_settings()
        self._path = s.tabpfn_model_path
        self._n_est = s.tabpfn_n_estimators
        self._data: TrainingData | None = None

    @property
    def version(self) -> str:
        import tabpfn
        return f"tabpfn-{getattr(tabpfn, '__version__', '?')}/{os.path.basename(self._path)}"

    def _regressor(self, seed: int):  # type: ignore[no-untyped-def]
        from tabpfn import TabPFNRegressor
        return TabPFNRegressor(model_path=self._path, n_estimators=self._n_est, random_state=seed)

    def fit(self, data: TrainingData, seed: int = 0, fast: bool = False) -> None:
        if data.n_obs > self.capabilities.max_train_samples:
            raise SurrogateUnavailable("TabPFN이 처리할 수 있는 학습 데이터 수를 초과했습니다.")
        if data.n_points < 2:
            raise ValueError("모델을 만들려면 서로 다른 실험점이 최소 2개 필요합니다.")
        self._data = data
        sp = data.space
        self._y_mu = float(np.mean(data.y_obs))
        self._y_sd = float(np.std(data.y_obs)) or 1.0
        self._mean_model = self._regressor(seed)
        self._mean_model.fit(sp.to_unit(data.X_obs), (data.y_obs - self._y_mu) / self._y_sd)

        self.reliability = variance_reliability(data)
        t = log_var_targets(data, sp.to_unit(data.X_pts))
        self._var_model = None
        self._var_const: tuple[float, float] | None = None
        if len(t.z) >= 3:
            self._var_model = self._regressor(seed + 1)
            self._var_model.fit(t.X_unit, t.z)
        else:
            pooled = pooled_log_var(data)
            self._var_const = pooled  # None이면 전체분포에서 추정

    def predict(self, X: np.ndarray) -> Prediction:
        assert self._data is not None
        U = self._data.space.to_unit(X)
        mean_s = np.asarray(self._mean_model.predict(U, output_type="mean"))
        qs = self._mean_model.predict(U, output_type="quantiles", quantiles=Q_LEVELS.tolist())
        qv = np.vstack([np.asarray(q) for q in qs]) * self._y_sd + self._y_mu
        mean = mean_s * self._y_sd + self._y_mu
        total_var = ((qv[-1] - qv[0]) / (2 * 1.96)) ** 2

        if self._var_model is not None:
            zm = np.asarray(self._var_model.predict(U, output_type="mean"))
            zq = self._var_model.predict(U, output_type="quantiles", quantiles=[0.025, 0.975])
            zs = np.maximum((np.asarray(zq[1]) - np.asarray(zq[0])) / (2 * 1.96), 1e-3)
        elif self._var_const is not None:
            zm = np.full(len(U), self._var_const[0])
            zs = np.full(len(U), self._var_const[1])
        else:
            # 반복이 전혀 없음: 전체 분산의 절반을 산포로 가정 (매우 거친 근사, 신뢰도 none으로 표시)
            zm = np.log(np.maximum(total_var * 0.5, 1e-12))
            zs = np.full(len(U), 1.5)
        alea = np.exp(zm)
        epi = np.maximum(total_var - alea, 1e-12)
        return Prediction(mean=mean, epistemic_var=epi, aleatoric_var=alea,
                          aleatoric_var_lo=np.exp(zm - 1.96 * zs), aleatoric_var_hi=np.exp(zm + 1.96 * zs),
                          alea_log_mean=zm, alea_log_std=zs, decomposition_is_approximate=True,
                          variance_reliability=self.reliability, q_levels=Q_LEVELS, q_values=qv)
