"""이분산(heteroscedastic) Gaussian Process 대리모델 (CLAUDE.md 5.3절 A).

구성
1) 산포 모델: 반복점의 편향 보정 log(s²)를 별도 GP로 학습. 관측잡음 = trigamma((n-1)/2).
2) 평균 모델: 실험점 평균을 학습하며 관측잡음 = σ̂²(x)/n (이분산).
3) 반복점이 부족하면 합동분산(상수) 또는 WhiteKernel 추정으로 대체하고 신뢰도를 낮게 표시.

프로토타입은 의존성을 가볍게 하기 위해 scikit-learn GP를 사용한다.
사내 개발 시 BoTorch/GPyTorch 구현으로 교체해도 SurrogateModel 인터페이스는 동일하게 유지한다.
"""
from __future__ import annotations

import warnings

import numpy as np
import sklearn
from sklearn.exceptions import ConvergenceWarning
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import ConstantKernel, Matern, WhiteKernel

from ..data import TrainingData
from .base import Capabilities, Prediction
from .variance import log_var_targets, pooled_log_var, variance_reliability


def _matern(d: int, ls_low: float, ls0: float = 0.5) -> Matern:
    return Matern(length_scale=np.full(d, ls0), length_scale_bounds=(ls_low, 50.0), nu=2.5)


class _WeightedLinearTrend:
    """log σ² 의 가중 리지 선형 추세. 가중치 = 1/관측잡음."""

    def __init__(self, beta: np.ndarray, cov: np.ndarray, use_slope: bool) -> None:
        self.beta, self.cov, self.use_slope = beta, cov, use_slope

    @staticmethod
    def _design(U: np.ndarray, use_slope: bool) -> np.ndarray:
        ones = np.ones((len(U), 1))
        return np.hstack([ones, U - 0.5]) if use_slope else ones

    @classmethod
    def fit(cls, U: np.ndarray, z: np.ndarray, noise: np.ndarray, use_slope: bool,
            ridge: float = 0.1) -> "_WeightedLinearTrend":
        A = cls._design(U, use_slope)
        W = 1.0 / noise
        reg = np.eye(A.shape[1]) * ridge
        reg[0, 0] = 1e-6  # 절편은 규제하지 않음
        H = A.T @ (A * W[:, None]) + reg
        cov = np.linalg.inv(H)
        beta = cov @ (A.T @ (W * z))
        return cls(beta, cov, use_slope)

    def predict(self, U: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        A = self._design(U, self.use_slope)
        return A @ self.beta, np.sqrt(np.einsum("ij,jk,ik->i", A, self.cov, A))


class HeteroscedasticGP:
    name = "gp"
    capabilities = Capabilities(differentiable=True, native_categorical=False, max_train_samples=2000,
                                decomposition_exact=True)

    def __init__(self) -> None:
        self._mean_gp: GaussianProcessRegressor | None = None
        self._var_gp: GaussianProcessRegressor | None = None
        self._var_const: tuple[float, float] | None = None  # (log σ², std)
        self._white_in_mean = False
        self._data: TrainingData | None = None

    @property
    def version(self) -> str:
        return f"sklearn-{sklearn.__version__}/hetero-gp-1"

    def fit(self, data: TrainingData, seed: int = 0, fast: bool = False) -> None:
        if data.n_points < 2:
            raise ValueError("모델을 만들려면 서로 다른 실험점이 최소 2개 필요합니다.")
        self._data = data
        sp = data.space
        d = sp.d
        U = sp.to_unit(data.X_pts)
        restarts = 0 if fast else 2
        y_mu = float(np.mean(data.y_obs))
        y_sd = float(np.std(data.y_obs)) or 1.0
        self._y_mu, self._y_sd = y_mu, y_sd

        # ---- 1) 산포 모델 ----
        self._var_gp, self._var_const, self._white_in_mean = None, None, False
        t = log_var_targets(data, U)
        self.reliability = variance_reliability(data)
        if len(t.z) >= 3:
            # 산포는 보통 완만한 경향을 가지므로 '선형 추세 + GP 잔차'(universal kriging)로 모델링한다.
            # 반복점이 적을 때 GP 진폭이 0으로 붕괴하여 산포가 상수로 추정되는 문제를 막는다.
            self._trend = _WeightedLinearTrend.fit(t.X_unit, t.z, t.noise, use_slope=len(t.z) >= d + 3)
            resid = t.z - self._trend.predict(t.X_unit)[0]
            self._z_mu = 0.0
            k = ConstantKernel(0.3, (1e-3, 1e2)) * _matern(d, ls_low=0.15, ls0=0.6)
            gp = GaussianProcessRegressor(k, alpha=t.noise, normalize_y=False, n_restarts_optimizer=restarts,
                                          random_state=seed)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", ConvergenceWarning)
                gp.fit(t.X_unit, resid)
            self._var_gp = gp
            sig2_pts = np.exp(self._trend.predict(U)[0] + gp.predict(U))
        else:
            pooled = pooled_log_var(data)
            if pooled is not None:
                self._var_const = pooled
                sig2_pts = np.full(data.n_points, np.exp(pooled[0]))
            else:
                sig2_pts = None  # 반복 없음 → 평균 모델의 WhiteKernel로 추정

        # ---- 2) 평균 모델 ----
        ys = (data.y_mean - y_mu) / y_sd
        base = ConstantKernel(1.0, (1e-3, 1e3)) * _matern(d, ls_low=0.03)
        if sig2_pts is None:
            kernel = base + WhiteKernel(0.05, (1e-6, 1.0))
            alpha = 1e-8
            self._white_in_mean = True
        else:
            kernel = base
            alpha = sig2_pts / data.n / (y_sd ** 2) + 1e-8
        gp_m = GaussianProcessRegressor(kernel, alpha=alpha, normalize_y=False, n_restarts_optimizer=restarts,
                                        random_state=seed)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ConvergenceWarning)
            gp_m.fit(U, ys)
        self._mean_gp = gp_m
        if self._white_in_mean:
            noise = float(gp_m.kernel_.k2.noise_level) * y_sd ** 2  # type: ignore[attr-defined]
            # 평균이 n개 관측의 평균이므로 단일 관측 산포 = noise (대부분 n=1)
            self._var_const = (float(np.log(max(noise, 1e-12))), 1.5)

    def predict(self, X: np.ndarray) -> Prediction:
        assert self._mean_gp is not None and self._data is not None, "fit()을 먼저 호출하세요."
        U = self._data.space.to_unit(X)
        m, s = self._mean_gp.predict(U, return_std=True)
        var_f = s ** 2
        if self._white_in_mean:
            var_f = np.maximum(var_f - float(self._mean_gp.kernel_.k2.noise_level), 0.0)  # type: ignore[attr-defined]
        mean = self._y_mu + m * self._y_sd
        epi = np.maximum(var_f, 1e-12) * self._y_sd ** 2
        if self._var_gp is not None:
            zm, zs = self._var_gp.predict(U, return_std=True)
            tm, ts = self._trend.predict(U)
            zm = zm + tm
            zs = np.sqrt(zs ** 2 + ts ** 2)
        else:
            assert self._var_const is not None
            zm = np.full(len(U), self._var_const[0])
            zs = np.full(len(U), self._var_const[1])
        alea = np.exp(zm)
        return Prediction(mean=mean, epistemic_var=epi, aleatoric_var=alea,
                          aleatoric_var_lo=np.exp(zm - 1.96 * zs), aleatoric_var_hi=np.exp(zm + 1.96 * zs),
                          alea_log_mean=zm, alea_log_std=zs, decomposition_is_approximate=False,
                          variance_reliability=self.reliability)
