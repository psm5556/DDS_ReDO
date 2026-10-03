"""시각화용 예측: 2D 단면(평균/산포/모델 불확실성/규격 만족 확률), 주효과."""
from __future__ import annotations

import numpy as np

from .data import TrainingData
from .objectives import Objective
from .space import Space
from .surrogates.base import SurrogateModel


def reference_point(space: Space, fixed: dict[str, float]) -> np.ndarray:
    ref = np.array([(f.low + f.high) / 2 if f.scale == "linear" else np.sqrt(f.low * f.high) for f in space.factors])
    for j, k in enumerate(space.keys):
        if k in fixed:
            ref[j] = fixed[k]
    return ref


def surface(space: Space, model: SurrogateModel, data: TrainingData, obj: Objective, x_key: str, y_key: str,
            fixed: dict[str, float], res: int) -> dict:
    ix, iy = space.keys.index(x_key), space.keys.index(y_key)
    fx, fy = space.factors[ix], space.factors[iy]
    gx = space.from_unit(np.column_stack([np.linspace(0, 1, res)] * space.d))[:, ix]
    gy = space.from_unit(np.column_stack([np.linspace(0, 1, res)] * space.d))[:, iy]
    ref = reference_point(space, fixed)
    XX, YY = np.meshgrid(gx, gy)
    G = np.tile(ref, (res * res, 1))
    G[:, ix] = XX.ravel()
    G[:, iy] = YY.ravel()
    pr = model.predict(G)
    has_spec = obj.lsl is not None or obj.usl is not None
    shape = (res, res)
    return {
        "x": {"key": x_key, "name": fx.name, "unit": fx.unit, "values": gx.tolist()},
        "y": {"key": y_key, "name": fy.name, "unit": fy.unit, "values": gy.tolist()},
        "fixed": {k: float(v) for k, v in zip(space.keys, ref) if k not in (x_key, y_key)},
        "mean": pr.mean.reshape(shape).tolist(),
        "sigma": pr.sigma.reshape(shape).tolist(),
        "epistemic_sd": np.sqrt(pr.epistemic_var).reshape(shape).tolist(),
        "spec_prob": pr.spec_probability(obj.lsl, obj.usl).reshape(shape).tolist() if has_spec else None,
        "points": [{"x": float(r[ix]), "y": float(r[iy]), "n": int(n), "mean": float(m)}
                   for r, n, m in zip(data.X_pts, data.n, data.y_mean)],
        "decomposition_is_approximate": pr.decomposition_is_approximate,
        "variance_reliability": pr.variance_reliability,
    }


def main_effects(space: Space, model: SurrogateModel, fixed: dict[str, float], n: int = 30) -> list[dict]:
    ref = reference_point(space, fixed)
    out = []
    for j, f in enumerate(space.factors):
        u = np.linspace(0, 1, n)
        vals = space.from_unit(np.column_stack([u] * space.d))[:, j]
        G = np.tile(ref, (n, 1))
        G[:, j] = vals
        pr = model.predict(G)
        lo, hi = pr.mean_interval()
        out.append({"key": f.key, "name": f.name, "unit": f.unit, "x": vals.tolist(), "mean": pr.mean.tolist(),
                    "lo": lo.tolist(), "hi": hi.tolist(), "sigma": pr.sigma.tolist()})
    return out
