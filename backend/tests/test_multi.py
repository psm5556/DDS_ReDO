"""다목적 레시피 최적화·제안 (modeling/multi.py) 테스트."""
import numpy as np
import pytest
from pydantic import ValidationError

from app.modeling import multi
from app.modeling.data import TrainingData
from app.modeling.design import initial_design
from app.modeling.objectives import Objective
from app.modeling.space import Space
from app.modeling.surrogates.gp import HeteroscedasticGP
from app.schemas import FactorDef, ProjectSettings, ResponseDef

SP = Space((FactorDef(key="a", name="A", low=0, high=1, step=0.01),
            FactorDef(key="b", name="B", low=0, high=1, step=0.01)))
ST = ProjectSettings(mode="robust", robust_objective="spec_prob")


def _rm(resp: ResponseDef, f, seed=0, weight=1.0) -> multi.RespModel:  # type: ignore[no-untyped-def]
    rng = np.random.default_rng(seed)
    runs = initial_design(SP, 20, "sobol", 0.3, 3, seed=seed)
    X = SP.from_dicts([r.x for r in runs])
    y = f(X) + 0.05 * rng.standard_normal(len(X))
    data = TrainingData(SP, X, y)
    m = HeteroscedasticGP()
    m.fit(data)
    return multi.RespModel(resp, Objective.build(resp, ST), data, m, weight)


# 서로 충돌하는 두 응답: Y1은 A가 클수록, Y2는 A가 작을수록 좋다 (둘 다 B와는 무관)
Y1 = ResponseDef(key="y1", name="Y1", goal="maximize")
Y2 = ResponseDef(key="y2", name="Y2", goal="maximize")
f1 = lambda X: 2 * X[:, 0]  # noqa: E731
f2 = lambda X: 2 * (1 - X[:, 0])  # noqa: E731


def test_compromise_and_pareto_alternatives():
    rms = [_rm(Y1, f1), _rm(Y2, f2)]
    res = multi.optimize(SP, rms, 800)
    a_best = res["best"]["x"]["a"]
    assert 0.2 < a_best < 0.8, "충돌하는 두 응답의 타협점은 가운데 근처여야 함"
    assert len(res["best"]["responses"]) == 2
    whys = [alt["why"] for alt in res["alternatives"]]
    assert "Y1 우선" in whys and "Y2 우선" in whys
    y1_first = next(alt for alt in res["alternatives"] if alt["why"] == "Y1 우선")
    y2_first = next(alt for alt in res["alternatives"] if alt["why"] == "Y2 우선")
    assert y1_first["x"]["a"] > a_best > y2_first["x"]["a"]


def test_weights_shift_the_recipe():
    even = multi.optimize(SP, [_rm(Y1, f1), _rm(Y2, f2)], 800)["best"]["x"]["a"]
    heavy = multi.optimize(SP, [_rm(Y1, f1, weight=5.0), _rm(Y2, f2)], 800)["best"]["x"]["a"]
    assert heavy > even, "Y1의 가중치를 높이면 Y1 쪽(A 큼)으로 움직여야 함"


def test_zero_weight_response_is_monitored_only():
    res = multi.optimize(SP, [_rm(Y1, f1), _rm(Y2, f2, weight=0.0)], 800)
    assert res["best"]["x"]["a"] > 0.8  # Y2는 무시
    assert len(res["best"]["responses"]) == 2  # 예측값은 함께 보여 줌


def test_propose_batch_distinct_and_reports_each_response():
    rms = [_rm(Y1, f1), _rm(Y2, f2)]
    res = multi.propose(SP, rms, np.empty((0, 2)), HeteroscedasticGP, 3, 600, seed=1)
    xs = {tuple(p["x"].values()) for p in res["proposals"]}
    assert len(res["proposals"]) == 3 and len(xs) == 3
    for p in res["proposals"]:
        assert {r["key"] for r in p["responses"]} == {"y1", "y2"}
        assert p["reason"]


def test_response_row_criterion_validation():
    with pytest.raises(ValidationError):
        ResponseDef(key="r", name="R", goal="maximize", criterion="spec_prob")  # 규격 없이 규격 확률
    with pytest.raises(ValidationError):
        ResponseDef(key="r", name="R", goal="maximize", criterion="taguchi")  # 망대에 품질 손실
    r = ResponseDef(key="r", name="R", goal="minimize", criterion="mean_k_sigma", weight=2)
    assert Objective.build(r, ST).kind == "mean_k_sigma"
