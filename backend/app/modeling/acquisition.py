"""다음 실험 제안 (CLAUDE.md 5.5절).

- 후보 풀 방식: Sobol 후보 + 현재 최적 주변 국소 섭동 + 기존 실험점(반복 후보). 모든 후보는 세팅 정밀도로 반올림.
- 획득값: 몬테카를로 기대개선(평균의 모델 불확실성 + 산포의 불확실성을 함께 표본화). GP·TabPFN 공통.
- 배치: Kriging Believer (선택점의 예측 평균을 가상 관측으로 추가 후 재적합).
- 진행 중 런(pending)은 처음부터 가상 관측으로 넣어 중복 제안을 막는다.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
from scipy.stats import qmc

from .data import TrainingData
from .objectives import Objective
from .space import Space
from .surrogates.base import Prediction, SurrogateModel

N_MC = 128


def build_pool(space: Space, data: TrainingData, model: SurrogateModel, obj: Objective, n: int,
               seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n_global = int(n * 0.75)
    U = qmc.Sobol(space.d, scramble=True, seed=rng).random(int(2 ** np.ceil(np.log2(max(n_global, 2)))))[:n_global]
    parts = [space.from_unit(U)]
    if data.n_points > 0:
        # 현재 기대 점수 상위 실험점 주변 국소 탐색
        pred = model.predict(data.X_pts)
        es = expected_score(pred, obj, rng)
        top = np.argsort(-es)[: min(5, data.n_points)]
        n_local = n - n_global
        centers = space.to_unit(data.X_pts[top])
        pick = centers[rng.integers(0, len(centers), n_local)]
        local = np.clip(pick + rng.normal(0, 0.06, pick.shape), 0, 1)
        parts.append(space.from_unit(local))
        parts.append(data.X_pts)
    X = space.snap(np.vstack(parts))
    return np.unique(X, axis=0)


def _mc_samples(pred: Prediction, rng: np.random.Generator, n_mc: int = N_MC) -> tuple[np.ndarray, np.ndarray]:
    e1 = rng.standard_normal((n_mc, 1))
    e2 = rng.standard_normal((n_mc, 1))
    mu = pred.mean[None, :] + np.sqrt(pred.epistemic_var)[None, :] * e1
    sig = np.exp(0.5 * (pred.alea_log_mean[None, :] + pred.alea_log_std[None, :] * e2))
    return mu, sig


def expected_score(pred: Prediction, obj: Objective, rng: np.random.Generator | None = None) -> np.ndarray:
    rng = rng or np.random.default_rng(12345)
    mu, sig = _mc_samples(pred, rng)
    return obj.score(mu, sig).mean(axis=0)


def acquisition_values(pred: Prediction, obj: Objective, incumbent: float, seed: int) -> np.ndarray:
    if obj.mode == "explore":
        return pred.epistemic_var
    rng = np.random.default_rng(seed)  # 공통 난수(CRN)로 후보 간 비교를 안정화
    mu, sig = _mc_samples(pred, rng)
    return np.maximum(obj.score(mu, sig) - incumbent, 0.0).mean(axis=0)


@dataclass
class Proposal:
    x: dict[str, float]
    kind: str               # new | replicate
    reason_type: str        # explore | exploit | replicate
    reason: str
    acquisition: float
    mean: float
    mean_lo: float
    mean_hi: float
    sigma: float
    sigma_lo: float
    sigma_hi: float
    spec_prob: float | None
    expected_score: float
    extrapolation: bool


@dataclass
class ProposalResult:
    proposals: list[Proposal]
    objective: str
    incumbent: float
    pool_size: int
    notes: list[str] = field(default_factory=list)


def is_extrapolation(space: Space, data: TrainingData, X: np.ndarray) -> np.ndarray:
    if data.n_points == 0:
        return np.ones(len(X), dtype=bool)
    lo, hi = data.X_pts.min(axis=0), data.X_pts.max(axis=0)
    span = np.array([f.high - f.low for f in space.factors])
    tol = 0.02 * span
    out = np.any((X < lo - tol) | (X > hi + tol), axis=1)
    # 가장 가까운 실험점과의 거리(정규화)도 고려
    U, P = space.to_unit(X), space.to_unit(data.X_pts)
    dmin = np.sqrt(((U[:, None, :] - P[None, :, :]) ** 2).sum(-1)).min(axis=1)
    return out | (dmin > 0.45 * np.sqrt(space.d) / 2)


def propose_batch(space: Space, data: TrainingData, pending: np.ndarray, make_model: Callable[[], SurrogateModel],
                  obj: Objective, q: int, pool_size: int, seed: int = 0) -> ProposalResult:
    notes: list[str] = []
    model = make_model()
    believer = data
    if len(pending):
        model.fit(data, seed=seed, fast=True)
        pend_pred = model.predict(pending)
        believer = data.with_extra(pending, pend_pred.mean)
        notes.append(f"진행 중인 런 {len(pending)}개는 결과가 나올 것으로 가정하고 제외했습니다.")
    model.fit(believer, seed=seed)
    pool = build_pool(space, data, model, obj, pool_size, seed)
    observed = {space.point_key(r) for r in data.X_pts}
    pending_keys = {space.point_key(r) for r in pending} if len(pending) else set()
    chosen: list[int] = []
    proposals: list[Proposal] = []
    pred_obs = model.predict(data.X_pts)
    incumbent = float(np.max(expected_score(pred_obs, obj))) if obj.mode != "explore" else 0.0
    alea_med = float(np.median(pred_obs.aleatoric_var))
    extrap = is_extrapolation(space, data, pool)

    picks: list[tuple[int, float]] = []
    for _ in range(q):
        pred = model.predict(pool)
        acq = acquisition_values(pred, obj, incumbent, seed)
        acq[chosen] = -np.inf
        i = int(np.argmax(acq))
        if not np.isfinite(acq[i]):
            break
        chosen.append(i)
        picks.append((i, float(acq[i])))
        # Kriging Believer: 예측 평균을 가상 관측으로 추가 후 재적합 (점 선택에만 사용)
        believer = believer.with_extra(pool[i:i + 1], pred.mean[i:i + 1])
        model.fit(believer, seed=seed, fast=True)

    # 사용자에게 보여 주는 예측값은 가상 관측이 섞이지 않은, 실제 데이터만으로 적합한 모델에서 계산한다.
    # (가상 관측으로 재적합한 모델은 선택한 점 주변의 불확실성·산포를 실제보다 작게 보여 준다)
    if believer is not data:
        model = make_model()
        model.fit(data, seed=seed)
        pred_obs = model.predict(data.X_pts)
        alea_med = float(np.median(pred_obs.aleatoric_var))
    if picks:
        shown = model.predict(pool[[i for i, _ in picks]])
    for j, (i, a) in enumerate(picks):
        p1 = shown.take([j])
        es = float(expected_score(p1, obj)[0]) if obj.mode != "explore" else float("nan")
        key = space.point_key(pool[i])
        kind = "replicate" if key in observed or key in pending_keys else "new"
        lo, hi = p1.mean_interval()
        sp = p1.spec_probability(obj.lsl, obj.usl)[0] if (obj.lsl is not None or obj.usl is not None) else None
        reason_type, reason = _explain(kind, obj, es, incumbent, float(p1.aleatoric_var[0]), alea_med,
                                       float(p1.epistemic_var[0]), float(p1.aleatoric_var[0]), bool(extrap[i]),
                                       pending=key in pending_keys and key not in observed)
        proposals.append(Proposal(
            x=space.to_dicts(pool[i])[0], kind=kind, reason_type=reason_type, reason=reason,
            acquisition=a, mean=float(p1.mean[0]), mean_lo=float(lo[0]), mean_hi=float(hi[0]),
            sigma=float(np.sqrt(p1.aleatoric_var[0])), sigma_lo=float(np.sqrt(p1.aleatoric_var_lo[0])),
            sigma_hi=float(np.sqrt(p1.aleatoric_var_hi[0])), spec_prob=None if sp is None else float(sp),
            expected_score=es, extrapolation=bool(extrap[i])))
    return ProposalResult(proposals=proposals, objective=obj.label, incumbent=incumbent, pool_size=len(pool),
                          notes=notes)


def _explain(kind: str, obj: Objective, es: float, incumbent: float, alea: float, alea_med: float, epi: float,
             alea_v: float, extrap: bool, pending: bool = False) -> tuple[str, str]:
    if pending:
        return "replicate", ("아직 결과가 없는 진행 중 런과 같은 조건입니다. 유망한 조건이라 반복 측정으로 산포까지 "
                             "확인하도록 한 번 더 넣었습니다. 필요 없으면 빼도 됩니다.")
    if kind == "replicate":
        return "replicate", "이미 실험한 조건입니다. 결과가 유망하지만 산포 추정이 불확실해서 반복 측정으로 확인합니다."
    if obj.mode == "explore":
        return "explore", "아직 데이터가 적어 예측이 가장 불확실한 영역입니다. 응답 표면을 넓게 파악하기 위한 실험입니다."
    parts: list[str]
    if np.isfinite(es) and es >= incumbent:
        rt, parts = "exploit", ["현재까지 가장 좋은 결과가 예상되는 조건 근처입니다."]
    else:
        rt, parts = "explore", ["아직 데이터가 적어 확인이 필요한 영역입니다. 더 좋은 레시피가 있을 가능성이 있습니다."]
    if obj.mode == "robust" and alea < 0.8 * alea_med:
        parts.append("다른 조건보다 산포가 작을 것으로 예상됩니다.")
    if extrap:
        parts.append("기존 실험 범위 밖이라 예측 신뢰도가 낮습니다.")
    return rt, " ".join(parts)


def best_recipe(space: Space, data: TrainingData, model: SurrogateModel, obj: Objective, pool_size: int,
                seed: int = 0) -> dict:
    """현재 모델 기준 최적 레시피 후보 (기대 점수 최대). 외삽점은 내삽점 중 최선과 함께 비교한다."""
    pool = build_pool(space, data, model, obj, pool_size, seed)
    pred = model.predict(pool)
    if obj.mode == "explore":
        obj = Objective("optimize", "mean", obj.goal, obj.target, obj.lsl, obj.usl, obj.k)
    es = expected_score(pred, obj)
    extrap = is_extrapolation(space, data, pool)
    es_in = np.where(extrap, -np.inf, es)
    i = int(np.argmax(es_in)) if np.isfinite(es_in).any() else int(np.argmax(es))
    p1 = pred.take([i])
    lo, hi = p1.mean_interval()
    sp = p1.spec_probability(obj.lsl, obj.usl)[0] if (obj.lsl is not None or obj.usl is not None) else None
    observed = {space.point_key(r) for r in data.X_pts}
    return {
        "x": space.to_dicts(pool[i])[0],
        "mean": float(p1.mean[0]), "mean_lo": float(lo[0]), "mean_hi": float(hi[0]),
        "sigma": float(p1.sigma[0]), "sigma_lo": float(np.sqrt(p1.aleatoric_var_lo[0])),
        "sigma_hi": float(np.sqrt(p1.aleatoric_var_hi[0])),
        "obs_lo": float(p1.mean[0] - 1.96 * np.sqrt(p1.total_var[0])),
        "obs_hi": float(p1.mean[0] + 1.96 * np.sqrt(p1.total_var[0])),
        "spec_prob": None if sp is None else float(sp),
        "expected_score": float(es[i]), "score_label": obj.score_label,
        "extrapolation": bool(extrap[i]), "already_tested": space.point_key(pool[i]) in observed,
        "objective": obj.label,
    }
