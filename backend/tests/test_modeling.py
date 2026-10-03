"""합성 이분산 함수로 대리모델·산포 복원·커버리지·획득을 검증 (CLAUDE.md 10장)."""
import numpy as np

from app.modeling.acquisition import propose_batch
from app.modeling.data import TrainingData
from app.modeling.design import initial_design
from app.modeling.objectives import Objective
from app.modeling.space import Space
from app.modeling.surrogates.gp import HeteroscedasticGP
from app.modeling.validation import cross_validate
from app.schemas import FactorDef, ProjectSettings, ResponseDef

SP = Space((FactorDef(key="a", name="A", low=0, high=1, step=0.01),
            FactorDef(key="b", name="B", low=0, high=1, step=0.01)))


def f(X):
    return 10 * np.sin(3 * X[:, 0]) + 6 * X[:, 1] ** 2


def sig(X):
    return 0.2 + 2.0 * X[:, 0]  # A가 클수록 산포 증가


def make_data(n_pts=24, reps=4, frac=0.5, seed=0):
    rng = np.random.default_rng(seed)
    runs = initial_design(SP, n_pts, "sobol", frac, reps, seed=seed)
    X = SP.from_dicts([r.x for r in runs])
    y = f(X) + sig(X) * rng.standard_normal(len(X))
    return TrainingData(SP, X, y)


def test_variance_model_recovers_heteroscedastic_trend():
    """반복점 12개(각 4회)로는 개별 추정의 잡음이 크므로 여러 시드 평균으로 경향 복원을 확인한다."""
    T = np.array([[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]])
    ratios, monotone = [], 0
    for seed in range(6):
        d = make_data(seed=seed)
        m = HeteroscedasticGP()
        m.fit(d)
        p = m.predict(T)
        assert p.variance_reliability == "ok"
        assert not p.decomposition_is_approximate
        ratios.append(p.sigma[2] / p.sigma[0])
        monotone += int(p.sigma[0] < p.sigma[2])
    assert monotone >= 5, "산포가 A에 따라 증가하는 경향을 대부분 복원해야 함"
    assert np.exp(np.mean(np.log(ratios))) > 2.0  # 참값 비율은 5


def test_no_replicates_flags_variance_unreliable():
    d = make_data(n_pts=15, frac=0.0)
    m = HeteroscedasticGP()
    m.fit(d)
    assert m.predict(np.array([[0.5, 0.5]])).variance_reliability == "none"


def test_cross_validation_coverage_reasonable():
    d = make_data(n_pts=20)
    cv = cross_validate(d, HeteroscedasticGP, max_points=40)
    assert cv["available"]
    assert cv["coverage95"] >= 0.75


def test_robust_proposals_valid_and_distinct():
    d = make_data(n_pts=16)
    resp = ResponseDef(key="y", name="Y", goal="target", target=8.0, lsl=6.0, usl=10.0)
    obj = Objective.build(resp, ProjectSettings(mode="robust", robust_objective="spec_prob"))
    pending = np.array([[0.3, 0.3]])
    res = propose_batch(SP, d, pending, HeteroscedasticGP, obj, q=3, pool_size=600, seed=0)
    assert len(res.proposals) == 3
    xs = {tuple(p.x.values()) for p in res.proposals}
    assert len(xs) == 3, "배치 내 중복 제안 없음"
    for p in res.proposals:
        for k, v in p.x.items():
            assert 0 <= v <= 1 and abs(v * 100 - round(v * 100)) < 1e-6
        assert p.reason
    assert res.notes  # pending 안내


def test_spec_probability_bounds():
    d = make_data(n_pts=12)
    m = HeteroscedasticGP()
    m.fit(d)
    p = m.predict(np.random.default_rng(0).random((50, 2)))
    prob = p.spec_probability(5.0, 9.0)
    assert np.all((prob >= 0) & (prob <= 1))
