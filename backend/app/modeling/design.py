"""초기 설계 생성: Sobol / 최적화 LHS + 반복점, 세팅 정밀도 반영, 실행 순서 무작위화."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.stats import qmc

from .space import Space


@dataclass
class PlannedRun:
    x: dict[str, float]
    point_index: int
    replicate_no: int
    run_order: int


def space_filling(space: Space, n: int, method: str = "sobol", seed: int = 0) -> np.ndarray:
    """[0,1]^d 공간 채움 설계 후 원래 단위로 변환·반올림. 중복점은 제거 후 보충한다."""
    rng = np.random.default_rng(seed)
    pts: list[tuple[float, ...]] = []
    seen: set[tuple[float, ...]] = set()
    attempt = 0
    while len(pts) < n and attempt < 20:
        m = max(n * (attempt + 1), 4)
        if method == "lhs":
            sampler = qmc.LatinHypercube(d=space.d, optimization="random-cd", seed=rng)
            U = sampler.random(m)
        else:
            sampler = qmc.Sobol(d=space.d, scramble=True, seed=rng)
            U = sampler.random(int(2 ** np.ceil(np.log2(m))))[:m]
        X = space.snap(space.from_unit(U))
        for row in X:
            key = tuple(row.tolist())
            if key not in seen:
                seen.add(key)
                pts.append(key)
                if len(pts) >= n:
                    break
        attempt += 1
    return np.array(pts[:n], dtype=float)


def initial_design(space: Space, n_points: int, method: str = "sobol", replicate_fraction: float = 0.25,
                   replicates_per_point: int = 3, seed: int = 0) -> list[PlannedRun]:
    X = space_filling(space, n_points, method, seed)
    rng = np.random.default_rng(seed + 1)
    n_rep_pts = int(round(replicate_fraction * len(X)))
    if replicate_fraction > 0 and n_rep_pts == 0 and len(X) >= 4:
        n_rep_pts = 1
    # 반복점은 공간 전체에 퍼지도록 고른다 (설계 순서가 이미 공간 채움이므로 등간격 선택)
    rep_idx = set(np.linspace(0, len(X) - 1, n_rep_pts).round().astype(int).tolist()) if n_rep_pts else set()
    runs: list[PlannedRun] = []
    for i, row in enumerate(X):
        reps = replicates_per_point if i in rep_idx else 1
        for r in range(reps):
            runs.append(PlannedRun(x=space.to_dicts(row)[0], point_index=i, replicate_no=r + 1, run_order=0))
    order = rng.permutation(len(runs))
    for pos, idx in enumerate(order):
        runs[idx].run_order = pos + 1
    runs.sort(key=lambda r: r.run_order)
    return runs
