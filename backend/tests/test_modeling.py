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


def test_virtual_observations_excluded_from_replicate_variance():
    """Kriging Believer 가상 관측은 평균 모델의 관측 수에는 들어가지만 산포(s²) 추정에는 들어가지 않는다."""
    d = make_data(n_pts=16)
    p = int(np.argmax(d.n))  # 반복이 있는 점
    q = int(np.argmin(d.n))  # 1회만 측정한 점
    b = d.with_extra(d.X_pts[[p, p, q]], np.array([d.y_mean[p], d.y_mean[p], d.y_mean[q]]))
    assert b.n[p] == d.n[p] + 2 and b.n_real[p] == d.n[p]
    assert b.s2[p] == d.s2[p], "가상 관측(=예측 평균)이 표본분산을 줄이면 안 됨"
    assert np.isnan(b.s2[q]) and b.n_real[q] == 1, "가상 관측으로 반복점이 생기면 안 됨"
    assert b.n_replicated_points == d.n_replicated_points
    # 제외해도 가상 관측 표시가 유지됨
    assert b.without_point(0).virtual.sum() == 3 - int(q == 0) - 2 * int(p == 0)


def test_believer_does_not_shrink_predicted_sigma():
    """가상 관측을 넣은 점에서 모델 불확실성은 줄되, 산포(σ) 예측은 실제 데이터 기준과 비슷해야 한다."""
    d = make_data(n_pts=16)
    x = np.array([[0.85, 0.2]])
    base = HeteroscedasticGP()
    base.fit(d)
    p0 = base.predict(x)
    b = d.with_extra(np.repeat(x, 3, axis=0), np.repeat(p0.mean, 3))
    m = HeteroscedasticGP()
    m.fit(b)
    p1 = m.predict(x)
    assert p1.epistemic_var[0] < p0.epistemic_var[0]
    assert 0.7 < p1.sigma[0] / p0.sigma[0] < 1.4

