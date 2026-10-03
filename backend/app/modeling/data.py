"""학습 데이터: 개별 관측값을 실험점(design point) 단위로 묶어 평균·반복수·표본분산을 계산한다."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

import numpy as np

from .space import Space


@dataclass
class TrainingData:
    space: Space
    X_obs: np.ndarray  # (N, d) 원래 단위, 실제 세팅값
    y_obs: np.ndarray  # (N,)
    # 가상 관측 여부 (N,). Kriging Believer가 넣은 예측값은 평균 모델에만 쓰고 산포 추정에는 쓰지 않는다.
    virtual: np.ndarray | None = None
    # 아래는 __post_init__에서 계산
    X_pts: np.ndarray = field(init=False)
    y_mean: np.ndarray = field(init=False)
    n: np.ndarray = field(init=False)  # 관측 수 (가상 관측 포함, 평균 모델용)
    n_real: np.ndarray = field(init=False)  # 실제 관측 수 (산포 모델용)
    s2: np.ndarray = field(init=False)  # 실제 관측의 표본분산, 실제 반복 2회 미만이면 nan
    obs_point_index: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        self.X_obs = np.asarray(self.X_obs, dtype=float).reshape(-1, self.space.d)
        self.y_obs = np.asarray(self.y_obs, dtype=float).reshape(-1)
        self.virtual = (np.zeros(len(self.y_obs), dtype=bool) if self.virtual is None
                        else np.asarray(self.virtual, dtype=bool).reshape(-1))
        keys: dict[tuple[float, ...], int] = {}
        idx = np.empty(len(self.y_obs), dtype=int)
        for i, row in enumerate(self.X_obs):
            k = self.space.point_key(row)
            if k not in keys:
                keys[k] = len(keys)
            idx[i] = keys[k]
        self.obs_point_index = idx
        P = len(keys)
        self.X_pts = np.array(list(keys.keys()), dtype=float).reshape(P, self.space.d)
        self.n = np.bincount(idx, minlength=P).astype(int)
        self.y_mean = np.bincount(idx, weights=self.y_obs, minlength=P) / np.maximum(self.n, 1)
        real = ~self.virtual
        self.n_real = np.bincount(idx[real], minlength=P).astype(int)
        self.s2 = np.full(P, np.nan)
        for p in range(P):
            if self.n_real[p] >= 2:
                self.s2[p] = float(np.var(self.y_obs[(idx == p) & real], ddof=1))

    @property
    def n_points(self) -> int:
        return len(self.n)

    @property
    def n_obs(self) -> int:
        return len(self.y_obs)

    @property
    def n_replicated_points(self) -> int:
        return int(np.sum(self.n_real >= 2))

    def with_extra(self, X: np.ndarray, y: np.ndarray) -> "TrainingData":
        """Kriging Believer 등에서 가상 관측을 추가한 사본. 가상 관측은 산포 추정에서 제외된다."""
        y = np.atleast_1d(y)
        return TrainingData(self.space, np.vstack([self.X_obs, np.atleast_2d(X)]),
                            np.concatenate([self.y_obs, y]),
                            np.concatenate([self.virtual, np.ones(len(y), dtype=bool)]))

    def without_point(self, p: int) -> "TrainingData":
        keep = self.obs_point_index != p
        return TrainingData(self.space, self.X_obs[keep], self.y_obs[keep], self.virtual[keep])

    def without_points(self, ps: set[int]) -> "TrainingData":
        keep = ~np.isin(self.obs_point_index, list(ps))
        return TrainingData(self.space, self.X_obs[keep], self.y_obs[keep], self.virtual[keep])

    def data_hash(self) -> str:
        payload = json.dumps({"k": self.space.keys, "X": np.round(self.X_obs, 10).tolist(),
                              "y": np.round(self.y_obs, 10).tolist()}, sort_keys=True)
        return hashlib.sha256(payload.encode()).hexdigest()

    def to_snapshot(self) -> dict:
        return {"keys": self.space.keys, "X": self.X_obs.tolist(), "y": self.y_obs.tolist()}
