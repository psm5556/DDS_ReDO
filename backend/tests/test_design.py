import numpy as np

from app.modeling.design import initial_design
from app.modeling.space import Space
from app.schemas import FactorDef


def _space():
    return Space((FactorDef(key="t", name="온도", unit="℃", low=150, high=250, step=1),
                  FactorDef(key="p", name="압력", low=0.5, high=5.0, step=0.1),
                  FactorDef(key="c", name="농도", low=0.01, high=1.0, step=0.01, scale="log")))


def test_initial_design_respects_range_precision_and_replicates():
    sp = _space()
    runs = initial_design(sp, 12, "sobol", replicate_fraction=0.25, replicates_per_point=3, seed=1)
    X = sp.from_dicts([r.x for r in runs])
    for j, f in enumerate(sp.factors):
        assert X[:, j].min() >= f.low - 1e-9 and X[:, j].max() <= f.high + 1e-9
        steps = (X[:, j] - f.low) / f.step
        assert np.allclose(steps, np.round(steps), atol=1e-6), f"{f.name} 세팅 정밀도 위반"
    pts = {r.point_index for r in runs}
    assert len(pts) == 12
    reps = [sum(1 for r in runs if r.point_index == i) for i in pts]
    assert reps.count(3) == 3 and reps.count(1) == 9
    assert sorted(r.run_order for r in runs) == list(range(1, len(runs) + 1))


def test_design_is_reproducible():
    sp = _space()
    a = [r.x for r in initial_design(sp, 10, "lhs", seed=5)]
    b = [r.x for r in initial_design(sp, 10, "lhs", seed=5)]
    assert a == b
