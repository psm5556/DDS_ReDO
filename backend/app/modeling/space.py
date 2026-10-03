"""인자 공간 변환: 원래 단위 ↔ [0,1] 정규화, 세팅 정밀도 반올림."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..schemas import FactorDef


@dataclass(frozen=True)
class Space:
    factors: tuple[FactorDef, ...]

    @property
    def keys(self) -> list[str]:
        return [f.key for f in self.factors]

    @property
    def d(self) -> int:
        return len(self.factors)

    def to_unit(self, X: np.ndarray) -> np.ndarray:
        X = np.atleast_2d(np.asarray(X, dtype=float))
        U = np.empty_like(X)
        for j, f in enumerate(self.factors):
            if f.scale == "log":
                U[:, j] = (np.log(X[:, j]) - np.log(f.low)) / (np.log(f.high) - np.log(f.low))
            else:
                U[:, j] = (X[:, j] - f.low) / (f.high - f.low)
        return U

    def from_unit(self, U: np.ndarray) -> np.ndarray:
        U = np.clip(np.atleast_2d(np.asarray(U, dtype=float)), 0.0, 1.0)
        X = np.empty_like(U)
        for j, f in enumerate(self.factors):
            if f.scale == "log":
                X[:, j] = np.exp(np.log(f.low) + U[:, j] * (np.log(f.high) - np.log(f.low)))
            else:
                X[:, j] = f.low + U[:, j] * (f.high - f.low)
        return X

    def snap(self, X: np.ndarray) -> np.ndarray:
        """사람이 실제로 세팅할 수 있는 값으로 반올림하고 범위 안으로 자른다."""
        X = np.atleast_2d(np.asarray(X, dtype=float)).copy()
        for j, f in enumerate(self.factors):
            base = f.low
            X[:, j] = base + np.round((X[:, j] - base) / f.step) * f.step
            X[:, j] = np.clip(X[:, j], f.low, f.high)
            X[:, j] = np.round(X[:, j], _decimals(f.step))
        return X

    def to_dicts(self, X: np.ndarray) -> list[dict[str, float]]:
        return [{k: float(v) for k, v in zip(self.keys, row)} for row in np.atleast_2d(X)]

    def from_dicts(self, rows: list[dict[str, float]]) -> np.ndarray:
        return np.array([[float(r[k]) for k in self.keys] for r in rows], dtype=float).reshape(len(rows), self.d)

    def point_key(self, row: np.ndarray | dict[str, float]) -> tuple[float, ...]:
        if isinstance(row, dict):
            row = np.array([row[k] for k in self.keys], dtype=float)
        snapped = self.snap(np.asarray(row, dtype=float))[0]
        return tuple(float(v) for v in snapped)


def _decimals(step: float) -> int:
    s = f"{step:.10f}".rstrip("0")
    return max(0, len(s.split(".")[1])) if "." in s else 0
