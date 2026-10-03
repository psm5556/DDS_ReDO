"""다목적 레시피 최적화와 다목적 다음 실험 제안 (CLAUDE.md 5.4 다중 응답).

정식화
- 응답 i마다 자기 최적화 기준(Objective)으로 점수 s_i(x)를 매긴다 (규격이 있으면 규격 만족 확률, 없으면 평균∓kσ 또는 품질 손실).
- 바람직함 d_i ∈ [0, 1+): 규격 만족 확률은 그대로, 그 밖의 점수는 관측된 실험점들의 점수 범위를 0~1로 선형 변환한다
  (관측 최고보다 좋아질 여지를 남기기 위해 위쪽은 자르지 않는다).
- 종합 점수 D(x) = Π d_i^(w_i / Σw)  (가중 기하평균, Derringer 바람직함 함수). 한 응답이라도 나쁘면 D가 크게 떨어진다.
- 기대 종합 점수 E[D]는 응답마다 평균의 모델 불확실성과 산포의 불확실성을 표본화한 몬테카를로로 계산한다 (응답 간 독립 가정).
- 최적 레시피 = 내삽 영역 후보 중 E[D] 최대. 파레토 대안 = 응답별 기대 바람직함에서 지배되지 않는 후보 중 대표 몇 개.
- 다음 실험 = E[max(D − D*, 0)] (D* = 관측 실험점의 최고 E[D]) 최대, 배치는 모든 응답에 같은 가상 관측을 넣는 Kriging Believer.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from scipy.stats import qmc

from ..schemas import ResponseDef
from .acquisition import _mc_samples, is_extrapolation
from .data import TrainingData
from .objectives import Objective
from .space import Space
from .surrogates.base import Prediction, SurrogateModel

N_MC = 128
D_FLOOR = 1e-3


@dataclass
class RespModel:
    resp: ResponseDef
    obj: Objective
    data: TrainingData
    model: SurrogateModel
    weight: float
    lo: float = 0.0   # 정규화 기준 (규격 만족 확률이 아닌 기준에서만 사용)
    hi: float = 1.0

    @property
    def is_prob(self) -> bool:
        return self.obj.kind == "spec_prob"


def prepare(rms: list[RespModel], seed: int = 0) -> None:
    """정규화 기준(관측 실험점의 기대 점수 범위)을 정한다."""
    for rm in rms:
        if rm.is_prob:
            continue
        pred = rm.model.predict(rm.data.X_pts)
        mu, sig = _mc_samples(pred, np.random.default_rng(seed))
        s = rm.obj.score(mu, sig).mean(axis=0)
        lo, hi = float(np.min(s)), float(np.max(s))
        span = hi - lo
        if not np.isfinite(span) or span < 1e-12:
            span = max(abs(hi), 1.0) * 0.1
        rm.lo, rm.hi = lo, lo + span


def _d(rm: RespModel, mu: np.ndarray, sig: np.ndarray) -> np.ndarray:
    s = rm.obj.score(mu, sig)
    if rm.is_prob:
        return np.asarray(s, dtype=float)
    return np.maximum((s - rm.lo) / (rm.hi - rm.lo), 0.0)


def _weights(rms: list[RespModel]) -> np.ndarray:
    w = np.array([rm.weight for rm in rms], dtype=float)
    return w / w.sum() if w.sum() > 0 else np.full(len(rms), 1.0 / len(rms))


def mc_desirability(rms: list[RespModel], preds: list[Prediction], seed: int, n_mc: int = N_MC) -> tuple[np.ndarray, np.ndarray]:
    """(D 표본 (n_mc, N), 응답별 기대 바람직함 (k, N))"""
    w = _weights(rms)
    log_d = None
    each = []
    for i, (rm, pred) in enumerate(zip(rms, preds)):
        mu, sig = _mc_samples(pred, np.random.default_rng(seed + 7919 * i), n_mc)
        d = _d(rm, mu, sig)
        each.append(d.mean(axis=0))
        term = w[i] * np.log(np.maximum(d, D_FLOOR))
        log_d = term if log_d is None else log_d + term
    assert log_d is not None
    return np.exp(log_d), np.array(each)


def _observed(rms: list[RespModel]) -> np.ndarray:
    """모든 응답의 실험점 합집합 (외삽 판단·반복 후보용)"""
    X = np.vstack([rm.data.X_pts for rm in rms])
    return np.unique(X, axis=0)


def build_pool(space: Space, rms: list[RespModel], n: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n_global = int(n * 0.75)
    U = qmc.Sobol(space.d, scramble=True, seed=rng).random(int(2 ** np.ceil(np.log2(max(n_global, 2)))))[:n_global]
    parts = [space.from_unit(U)]
    obs = _observed(rms)
    if len(obs):
        D, _ = mc_desirability(rms, [rm.model.predict(obs) for rm in rms], seed)
        top = np.argsort(-D.mean(axis=0))[: min(5, len(obs))]
        centers = space.to_unit(obs[top])
        pick = centers[rng.integers(0, len(centers), n - n_global)]
        parts.append(space.from_unit(np.clip(pick + rng.normal(0, 0.06, pick.shape), 0, 1)))
        parts.append(obs)
    return np.unique(space.snap(np.vstack(parts)), axis=0)


def _per_response(rms: list[RespModel], preds: list[Prediction], idx: int, each: np.ndarray) -> list[dict]:
    out = []
    for i, (rm, pred) in enumerate(zip(rms, preds)):
        p1 = pred.take([idx])
        lo, hi = p1.mean_interval()
        has_spec = rm.resp.lsl is not None or rm.resp.usl is not None
        tsd = float(np.sqrt(p1.total_var[0]))
        out.append({
            "key": rm.resp.key, "name": rm.resp.name, "unit": rm.resp.unit, "goal": rm.resp.goal, "weight": rm.weight,
            "criterion": rm.obj.label, "mean": float(p1.mean[0]), "mean_lo": float(lo[0]), "mean_hi": float(hi[0]),
            "sigma": float(p1.sigma[0]), "sigma_lo": float(np.sqrt(p1.aleatoric_var_lo[0])),
            "sigma_hi": float(np.sqrt(p1.aleatoric_var_hi[0])),
            "obs_lo": float(p1.mean[0] - 1.96 * tsd), "obs_hi": float(p1.mean[0] + 1.96 * tsd),
            "spec_prob": float(p1.spec_probability(rm.resp.lsl, rm.resp.usl)[0]) if has_spec else None,
            "desirability": float(each[i, idx]),
        })
    return out


def _pareto(F: np.ndarray, cand: np.ndarray) -> np.ndarray:
    """F: (N, k) 클수록 좋음. cand 안에서 지배되지 않는 인덱스"""
    idx = cand[np.argsort(-F[cand].sum(axis=1))]
    keep: list[int] = []
    for i in idx:
        if not any(np.all(F[j] >= F[i]) and np.any(F[j] > F[i]) for j in keep):
            keep = [j for j in keep if not (np.all(F[i] >= F[j]) and np.any(F[i] > F[j]))] + [int(i)]
    return np.array(keep, dtype=int)


def optimize(space: Space, rms: list[RespModel], pool_size: int, seed: int = 0, n_alt: int = 4) -> dict:
    """다목적 최적 레시피 + 파레토 대안"""
    prepare(rms, seed)
    pool = build_pool(space, rms, pool_size, seed)
    preds = [rm.model.predict(pool) for rm in rms]
    Ds, each = mc_desirability(rms, preds, seed)
    ED = Ds.mean(axis=0)
    obs = _observed(rms)
    extrap = is_extrapolation(space, TrainingData(space, obs, np.zeros(len(obs))), pool)
    inside = np.where(~extrap)[0]
    cand = inside if len(inside) else np.arange(len(pool))
    best = int(cand[np.argmax(ED[cand])])
    observed = {space.point_key(r) for r in obs}

    def card(i: int, why: str) -> dict:
        return {"x": space.to_dicts(pool[i])[0], "desirability": float(ED[i]), "why": why,
                "extrapolation": bool(extrap[i]), "already_tested": space.point_key(pool[i]) in observed,
                "responses": _per_response(rms, preds, i, each)}

    alts: list[dict] = []
    if len(rms) > 1:
        # 응답별 기대 바람직함 기준 파레토 집합에서: 각 응답을 가장 잘 만족하는 대안 + 종합 점수 상위
        front = _pareto(each.T, cand[np.argsort(-ED[cand])][:400])
        chosen = [best]
        for k, rm in enumerate(rms):
            if rm.weight <= 0 or not len(front):
                continue
            j = int(front[np.argmax(each[k, front])])
            if j not in chosen:
                chosen.append(j)
                alts.append(card(j, f"{rm.resp.name} 우선"))
        for j in front[np.argsort(-ED[front])]:
            if len(alts) >= n_alt:
                break
            if int(j) not in chosen:
                chosen.append(int(j))
                alts.append(card(int(j), "균형이 다른 대안"))
    return {"best": card(best, "종합 점수 최고"), "alternatives": alts[:n_alt],
            "pool_size": int(len(pool))}


def propose(space: Space, rms: list[RespModel], pending: np.ndarray, make_model: Callable[[], SurrogateModel],
            q: int, pool_size: int, seed: int = 0, explore: bool = False) -> dict:
    """다목적 다음 실험 배치. 표시하는 예측값은 가상 관측 없이 실제 데이터로 적합한 모델에서 계산한다."""
    prepare(rms, seed)
    notes: list[str] = []
    obs = _observed(rms)
    pool = build_pool(space, rms, pool_size, seed)
    base_obs = [rm.model.predict(obs) for rm in rms]
    D_obs, _ = mc_desirability(rms, base_obs, seed)
    incumbent = float(D_obs.mean(axis=0).max())

    # 가상 관측(Kriging Believer)용 사본: 진행 중 런은 예측 평균이 나온 것으로 가정
    believers = [rm.data for rm in rms]
    models: list[SurrogateModel] = [rm.model for rm in rms]
    if len(pending):
        notes.append(f"진행 중인 런 {len(pending)}개는 결과가 나올 것으로 가정하고 제외했습니다.")
        for i, rm in enumerate(rms):
            believers[i] = rm.data.with_extra(pending, rm.model.predict(pending).mean)
            models[i] = make_model()
            models[i].fit(believers[i], seed=seed)
    fit_rms = [RespModel(rm.resp, rm.obj, believers[i], models[i], rm.weight, rm.lo, rm.hi) for i, rm in enumerate(rms)]
    extrap = is_extrapolation(space, TrainingData(space, obs, np.zeros(len(obs))), pool)
    chosen: list[int] = []
    acq_vals: list[float] = []
    for _ in range(q):
        preds = [m.model.predict(pool) for m in fit_rms]
        if explore:
            acq = sum(m.weight * p.epistemic_var / max(float(np.var(m.data.y_obs)), 1e-12) for m, p in zip(fit_rms, preds))
        else:
            Ds, _ = mc_desirability(fit_rms, preds, seed)
            acq = np.maximum(Ds - incumbent, 0.0).mean(axis=0)
        acq = np.asarray(acq, dtype=float)
        acq[chosen] = -np.inf
        i = int(np.argmax(acq))
        if not np.isfinite(acq[i]):
            break
        chosen.append(i)
        acq_vals.append(float(acq[i]))
        for m, p in zip(fit_rms, preds):
            m.data = m.data.with_extra(pool[i:i + 1], p.mean[i:i + 1])
            m.model = make_model()
            m.model.fit(m.data, seed=seed, fast=True)

    proposals = []
    if chosen:
        sel = np.array(chosen)
        preds = [rm.model.predict(pool[sel]) for rm in rms]
        Ds, each = mc_desirability(rms, preds, seed)
        ED = Ds.mean(axis=0)
        observed = {space.point_key(r) for r in obs}
        pend = {space.point_key(r) for r in pending} if len(pending) else set()
        for j, i in enumerate(chosen):
            key = space.point_key(pool[i])
            if key in pend and key not in observed:
                kind, rtype = "replicate", "replicate"
                why = "아직 결과가 없는 진행 중 런과 같은 조건입니다. 유망해서 반복 측정으로 산포까지 확인하도록 한 번 더 넣었습니다."
            elif key in observed:
                kind, rtype = "replicate", "replicate"
                why = "이미 실험한 조건입니다. 결과가 유망하지만 산포 추정이 불확실해서 반복 측정으로 확인합니다."
            elif explore:
                kind, rtype, why = "new", "explore", "아직 데이터가 적어 예측이 가장 불확실한 영역입니다."
            elif ED[j] >= incumbent:
                kind, rtype, why = "new", "exploit", "모든 응답을 함께 볼 때 지금까지보다 좋은 결과가 기대되는 조건입니다."
            else:
                kind, rtype, why = "new", "explore", "아직 확인되지 않은 영역입니다. 더 좋은 레시피가 있을 가능성이 있습니다."
            if extrap[i]:
                why += " 기존 실험 범위 밖이라 예측 신뢰도가 낮습니다."
            proposals.append({"x": space.to_dicts(pool[i])[0], "kind": kind, "reason_type": rtype, "reason": why,
                              "acquisition": acq_vals[j], "desirability": float(ED[j]), "extrapolation": bool(extrap[i]),
                              "responses": _per_response(rms, preds, j, each)})
    return {"proposals": proposals, "incumbent": incumbent, "pool_size": int(len(pool)), "notes": notes}
