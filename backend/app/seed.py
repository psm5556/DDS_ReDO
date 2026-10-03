"""개발용 시드 데이터: 조직·Mock 사용자·데모 프로젝트 2개(식각 레시피, CMP 슬러리 배합 — 모의 실험 결과 포함).

python -m app.seed          # 비어 있으면 생성
python -m app.seed --reset  # DB 초기화 후 생성 (개발 전용)
"""
from __future__ import annotations

import sys

import numpy as np
from sqlalchemy import select

from .db import Base, SessionLocal, engine
from .modeling.acquisition import propose_batch
from .modeling.design import initial_design
from .modeling.objectives import Objective
from .models import BusinessUnit, Department, Measurement, Project, ProjectMember, Run, Share, User
from .schemas import FactorDef, ProjectConfig, ProjectSettings, ResponseDef
from .services.analysis import load_training, make_factory, space_of

ORG = [
    ("SEMI", "반도체사업부", [("SEMI-ETCH", "식각공정개발팀"), ("SEMI-DEPO", "증착공정개발팀")]),
    ("DISP", "디스플레이사업부", [("DISP-PANEL", "패널공정개발팀")]),
    ("MAT", "소재사업부", [("MAT-RND", "소재개발팀")]),
]
USERS = [
    ("E1001", "김서연", "SEMI-ETCH", "user"),
    ("E1002", "이도윤", "SEMI-ETCH", "user"),
    ("E1003", "박지호", "SEMI-DEPO", "user"),
    ("E2001", "최유나", "DISP-PANEL", "user"),
    ("E3001", "정하준", "MAT-RND", "user"),
    ("E1900", "한지민", "SEMI-ETCH", "bu_admin"),
    ("E9000", "시스템관리자", "SEMI-ETCH", "admin"),
]


def _truth(x: dict[str, float]) -> tuple[float, float, float, float]:
    """모의 공정: 압력이 높을수록, 가스 유량이 낮을수록 산포가 커진다."""
    u1 = (x["rf_power"] - 200) / 600
    u2 = (x["pressure"] - 10) / 70
    u3 = (x["cl2_flow"] - 20) / 100
    er = 215 + 150 * u1 + 45 * u3 - 55 * u2 ** 2 + 30 * u1 * u3
    er_sd = 3 + 20 * u2 + 7 * (1 - u3)
    un = 1.8 + 2.4 * u2 + 4 * (u1 - 0.45) ** 2
    un_sd = 0.15 + 0.35 * u2
    return er, er_sd, un, un_sd


def demo_config() -> ProjectConfig:
    return ProjectConfig(
        factors=[
            FactorDef(key="rf_power", name="RF 파워", unit="W", low=200, high=800, step=10),
            FactorDef(key="pressure", name="챔버 압력", unit="mTorr", low=10, high=80, step=1),
            FactorDef(key="cl2_flow", name="Cl₂ 유량", unit="sccm", low=20, high=120, step=5),
        ],
        responses=[
            ResponseDef(key="etch_rate", name="식각률", unit="nm/min", goal="target", target=320, lsl=300, usl=340,
                        input_min=0, input_max=1000, decimals=1),
            ResponseDef(key="uniformity", name="균일도", unit="%", goal="minimize", usl=4.5, input_min=0,
                        input_max=50, decimals=2),
        ],
        settings=ProjectSettings(mode="robust", robust_objective="spec_prob", batch_size=4, budget_runs=40,
                                 primary_response="etch_rate"),
    )


def _truth_cmp(x: dict[str, float]) -> tuple[float, float, float, float, float, float]:
    """모의 CMP 슬러리: 연마제·산화제가 많을수록 제거율↑, 산화제가 많을수록 디싱↑, 연마제가 많을수록 결함↑ (서로 충돌).
    pH는 중간(4 근처)에서 제거율이 가장 높고, 높을수록 결함 산포가 커진다."""
    a = (x["abrasive"] - 1) / 9
    o = (x["oxidizer"] - 0.5) / 4.5
    h = (x["ph"] - 2) / 4
    mrr = 150 + 220 * a + 160 * o - 120 * (h - 0.5) ** 2 + 40 * a * o
    mrr_sd = 8 + 10 * a
    dish = 12 + 30 * o ** 1.5 + 6 * a - 5 * h
    dish_sd = 1.2 + 2.5 * o
    defect = 8 + 45 * a ** 2 + 10 * h
    defect_sd = 2 + 6 * h + 4 * a
    return mrr, mrr_sd, dish, dish_sd, defect, defect_sd


def cmp_config() -> ProjectConfig:
    return ProjectConfig(
        factors=[
            FactorDef(key="abrasive", name="연마제 농도", unit="wt%", low=1, high=10, step=0.5),
            FactorDef(key="oxidizer", name="산화제(H₂O₂)", unit="wt%", low=0.5, high=5, step=0.1),
            FactorDef(key="ph", name="pH", unit="", low=2, high=6, step=0.1),
        ],
        responses=[
            ResponseDef(key="mrr", name="제거율", unit="nm/min", goal="maximize", lsl=400, input_min=0, input_max=2000,
                        decimals=0, weight=1),
            ResponseDef(key="dishing", name="디싱", unit="nm", goal="minimize", usl=22, input_min=0, input_max=500,
                        decimals=1, weight=1),
            ResponseDef(key="defect", name="결함 수", unit="ea/wafer", goal="minimize", usl=40, input_min=0, input_max=1000,
                        decimals=0, weight=0.5),
        ],
        settings=ProjectSettings(mode="robust", robust_objective="spec_prob", batch_size=4, budget_runs=36,
                                 primary_response="mrr"),
    )


def _seed_cmp(db, users: dict) -> None:  # type: ignore[no-untyped-def]
    """두 번째 예제: 응답 3개(제거율↑·디싱↓·결함↓)가 서로 충돌하는 다목적 최적화. 첫 DOE 결과가 모두 입력된 상태."""
    from .models import DesignBatch
    owner = users["E1001"]
    cfg = cmp_config()
    p = Project(name="CMP 슬러리 배합 최적화 (데모)", owner_id=owner.id, business_unit_id=owner.business_unit_id,
                description="제거율 400 nm/min 이상, 디싱 22 nm 이하, 결함 40개 이하를 함께 만족하는 슬러리 배합을 찾습니다.",
                tags=["CMP", "배합", "데모"], config=cfg.model_dump())
    db.add(p)
    db.flush()
    db.add(ProjectMember(project_id=p.id, user_id=users["E1002"].id, role="runner"))
    rng = np.random.default_rng(11)
    planned = initial_design(space_of(cfg), 12, "sobol", 0.34, 3, seed=5)
    b = DesignBatch(project_id=p.id, seq=1, kind="initial", acquisition={"method": "sobol", "n_points": 12},
                    note="초기 설계", created_by=owner.id)
    db.add(b)
    db.flush()
    for i, r in enumerate(planned):
        run = Run(project_id=p.id, batch_id=b.id, code=f"1차-{i + 1:02d}", replicate_no=r.replicate_no,
                  run_order=r.run_order, status="done", planned=r.x, actual=dict(r.x),
                  reason="초기 설계: 인자 공간 전체를 고르게 살펴보기 위한 조건입니다.", assignee_id=users["E1002"].id)
        db.add(run)
        db.flush()
        mrr, mrr_sd, dish, dish_sd, defect, defect_sd = _truth_cmp(r.x)
        for key, mu, sd, nd in (("mrr", mrr, mrr_sd, 0), ("dishing", dish, dish_sd, 1), ("defect", defect, defect_sd, 0)):
            db.add(Measurement(run_id=run.id, response_key=key, value=round(float(max(0.0, mu + sd * rng.standard_normal())), nd),
                               created_by=users["E1002"].id))
    db.commit()


def seed(reset: bool = False) -> None:
    if reset:
        Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        if db.scalar(select(User.id).limit(1)) is not None:
            return
        depts: dict[str, Department] = {}
        for bcode, bname, ds in ORG:
            bu = BusinessUnit(code=bcode, name=bname)
            db.add(bu)
            db.flush()
            for dcode, dname in ds:
                d = Department(code=dcode, name=dname, business_unit_id=bu.id)
                db.add(d)
                db.flush()
                depts[dcode] = d
        users: dict[str, User] = {}
        for key, name, dcode, role in USERS:
            d = depts[dcode]
            u = User(user_key=key, name=name, email=f"{key.lower()}@example.com", department_id=d.id,
                     business_unit_id=d.business_unit_id, system_role=role)
            db.add(u)
            db.flush()
            users[key] = u

        owner = users["E1001"]
        cfg = demo_config()
        p = Project(name="Poly-Si 식각 레시피 개발 (데모)", owner_id=owner.id, business_unit_id=owner.business_unit_id,
                    description="게이트 Poly-Si 식각률을 목표 320 nm/min(규격 300~340)에 맞추면서 산포가 작은 레시피를 찾습니다.",
                    tags=["식각", "데모"], config=cfg.model_dump())
        db.add(p)
        db.flush()
        db.add(ProjectMember(project_id=p.id, user_id=users["E1002"].id, role="runner"))
        db.add(ProjectMember(project_id=p.id, user_id=users["E1003"].id, role="viewer"))

        from .models import DesignBatch
        rng = np.random.default_rng(7)
        sp = space_of(cfg)
        planned = initial_design(sp, 12, "sobol", 0.34, 3, seed=3)
        b = DesignBatch(project_id=p.id, seq=1, kind="initial", acquisition={"method": "sobol", "n_points": 12},
                        note="초기 설계", created_by=owner.id)
        db.add(b)
        db.flush()
        for i, r in enumerate(planned):
            run = Run(project_id=p.id, batch_id=b.id, code=f"1차-{i + 1:02d}", replicate_no=r.replicate_no,
                      run_order=r.run_order, status="done", planned=r.x, actual=dict(r.x),
                      reason="초기 설계: 인자 공간 전체를 고르게 살펴보기 위한 조건입니다.", assignee_id=users["E1002"].id)
            db.add(run)
            db.flush()
            er, er_sd, un, un_sd = _truth(r.x)
            db.add(Measurement(run_id=run.id, response_key="etch_rate",
                               value=round(float(er + er_sd * rng.standard_normal()), 1), created_by=users["E1002"].id))
            db.add(Measurement(run_id=run.id, response_key="uniformity",
                               value=round(float(max(0.2, un + un_sd * rng.standard_normal())), 2),
                               created_by=users["E1002"].id))
        db.commit()

        # 2차 배치: 능동학습 제안 (아직 실험 전)
        data, pending = load_training(db, p, cfg, "etch_rate")
        obj = Objective.build(cfg.response("etch_rate"), cfg.settings)
        res = propose_batch(sp, data, pending, make_factory("gp"), obj, 4, 2000, seed=0)
        b2 = DesignBatch(project_id=p.id, seq=2, kind="active", surrogate="gp", surrogate_version="seed",
                         acquisition={"objective": res.objective}, note="능동학습 제안", created_by=owner.id)
        db.add(b2)
        db.flush()
        for i, pr in enumerate(res.proposals):
            db.add(Run(project_id=p.id, batch_id=b2.id, code=f"2차-{i + 1:02d}", run_order=i + 1,
                       is_replicate_of_existing=pr.kind == "replicate", status="planned", planned=pr.x,
                       actual=dict(pr.x), reason=pr.reason, assignee_id=users["E1002"].id))
        db.commit()

        # 증착공정개발팀에 스냅샷 공유
        from .services.sharing import build_payload
        payload = build_payload(p, cfg, data, "etch_rate", "gp", False)
        import secrets
        db.add(Share(project_id=p.id, token=secrets.token_urlsafe(24), target_type="department",
                     target_id=depts["SEMI-DEPO"].id, permission="view_simulate", mode="snapshot",
                     response_key="etch_rate", surrogate="gp",
                     snapshot={"payload": payload, "config": cfg.model_dump(), "data": data.to_snapshot()},
                     include_raw=False, created_by=owner.id))
        db.commit()

        _seed_cmp(db, users)
    finally:
        db.close()


def seed_if_empty() -> None:
    seed(reset=False)


if __name__ == "__main__":
    seed(reset="--reset" in sys.argv)
    print("시드 데이터 준비 완료")
