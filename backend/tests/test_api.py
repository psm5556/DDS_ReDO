"""API·권한 테스트 (CLAUDE.md 8.3절, 10장): 역할별 허용/거부, IDOR, 공유 철회."""
import os

import pytest

from tests.conftest import H

from app.config import Settings, validate_settings


def _demo_id(c):
    r = c.get("/api/projects?scope=mine")
    assert r.status_code == 200
    return next(p["id"] for p in r.json() if "데모" in p["name"])


def test_requires_login(seeded):
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        assert c.get("/api/projects").status_code == 401


def test_csrf_header_required(client_for):
    c = client_for("E1001")
    r = c.post("/api/projects", json={}, headers={"X-Requested-With": ""})
    assert r.status_code == 403


def test_idor_other_bu_cannot_see_project(client_for):
    owner = client_for("E1001")
    pid = _demo_id(owner)
    other = client_for("E2001")  # 디스플레이사업부, 멤버 아님
    assert other.get(f"/api/projects/{pid}").status_code == 404
    assert other.get(f"/api/projects/{pid}/runs").status_code == 404
    assert other.post(f"/api/projects/{pid}/analysis", json={}).status_code == 404
    assert other.get(f"/api/projects/{pid}/runsheet.xlsx").status_code == 404


def test_role_matrix(client_for):
    owner = client_for("E1001")
    pid = _demo_id(owner)
    runner = client_for("E1002")
    viewer = client_for("E1003")
    # 열람자는 조회 가능, 결과 입력 불가
    assert viewer.get(f"/api/projects/{pid}/runs").status_code == 200
    run = viewer.get(f"/api/projects/{pid}/runs?status=planned").json()[0]
    r = viewer.post(f"/api/projects/{pid}/results", json={"rows": [{"run_id": run["id"], "values": {"etch_rate": 310}}]})
    assert r.status_code == 403
    # 실험자는 결과 입력 가능, 설정 변경·제안 불가
    r = runner.post(f"/api/projects/{pid}/results",
                    json={"rows": [{"run_id": run["id"], "values": {"etch_rate": 318.5, "uniformity": 2.4}}]})
    assert r.status_code == 200, r.text
    saved = r.json()["runs"][0]
    assert saved["status"] == "done" and saved["values"]["etch_rate"] == 318.5
    assert runner.patch(f"/api/projects/{pid}", json={"name": "x"}).status_code == 403
    assert runner.post(f"/api/projects/{pid}/recommend", json={}).status_code == 403
    # 공유 관리는 소유자만
    assert runner.get(f"/api/projects/{pid}/shares").status_code == 403


def test_measurement_versioning(client_for):
    owner = client_for("E1001")
    pid = _demo_id(owner)
    run = owner.get(f"/api/projects/{pid}/runs?status=done").json()[0]
    rid = run["id"]
    r = owner.post(f"/api/projects/{pid}/results", json={"rows": [{"run_id": rid, "values": {"etch_rate": 299.0}}]})
    assert r.status_code == 200
    r = owner.post(f"/api/projects/{pid}/results", json={"rows": [{"run_id": rid, "values": {"etch_rate": 301.0}}]})
    assert r.json()["runs"][0]["values"]["etch_rate"] == 301.0
    from app.db import SessionLocal
    from app.models import Measurement
    from sqlalchemy import select
    with SessionLocal() as db:
        ms = list(db.scalars(select(Measurement).where(Measurement.run_id == rid,
                                                       Measurement.response_key == "etch_rate")))
        assert len(ms) >= 3 and sum(m.is_current for m in ms) == 1


def test_analysis_recommend_accept_flow(client_for):
    owner = client_for("E1001")
    pid = _demo_id(owner)
    a = owner.post(f"/api/projects/{pid}/analysis", json={"validate_model": True})
    assert a.status_code == 200, a.text
    body = a.json()
    assert body["best"]["x"] and body["validation"]["available"]
    rec = owner.post(f"/api/projects/{pid}/recommend", json={"batch_size": 2})
    assert rec.status_code == 200, rec.text
    props = rec.json()["proposals"]
    assert len(props) == 2
    acc = owner.post(f"/api/projects/{pid}/batches/accept",
                     json={"proposals": props, "surrogate": "gp", "surrogate_version": rec.json()["surrogate_version"]})
    assert acc.status_code == 200 and acc.json()["runs_total"] == 2
    s = owner.post(f"/api/projects/{pid}/surface", json={"x_factor": "rf_power", "y_factor": "pressure",
                                                         "resolution": 12})
    assert s.status_code == 200 and len(s.json()["mean"]) == 12


def test_tabpfn_unavailable_is_reported_not_crash(client_for):
    owner = client_for("E1001")
    pid = _demo_id(owner)
    r = owner.post(f"/api/projects/{pid}/analysis", json={"surrogate": "tabpfn", "validate_model": False})
    assert r.status_code == 409
    cmp = owner.post(f"/api/projects/{pid}/compare", json={})
    assert cmp.status_code == 200
    models = {m["name"]: m for m in cmp.json()["models"]}
    assert models["gp"]["available"] and not models["tabpfn"]["available"]


def test_share_targeting_and_revoke(client_for):
    owner = client_for("E1001")
    pid = _demo_id(owner)
    depo = client_for("E1003")   # 증착공정개발팀 (시드에서 부서 공유됨)
    disp = client_for("E2001")   # 다른 사업부
    received = depo.get("/api/shares/received").json()
    assert any(s["project_id"] == pid for s in received)
    token = next(s["token"] for s in received if s["project_id"] == pid)
    v = depo.get(f"/api/shared/{token}")
    assert v.status_code == 200 and v.json()["best"]["x"]
    assert v.json()["raw"] is None  # 원본 데이터 숨김 기본값
    assert disp.get(f"/api/shared/{token}").status_code == 403
    assert depo.post(f"/api/shared/{token}/predict",
                     json={"points": [{"rf_power": 500, "pressure": 20, "cl2_flow": 80}]}).status_code == 200
    # 사업부 단위 공유 생성 후 철회
    from app.db import SessionLocal
    from app.models import BusinessUnit
    from sqlalchemy import select
    with SessionLocal() as db:
        disp_bu = db.scalar(select(BusinessUnit).where(BusinessUnit.code == "DISP")).id
    sh = owner.post(f"/api/projects/{pid}/shares", json={"target_type": "business_unit", "target_id": disp_bu,
                                                        "permission": "view", "mode": "snapshot"})
    assert sh.status_code == 200, sh.text
    t2 = sh.json()["token"]
    assert disp.get(f"/api/shared/{t2}").status_code == 200
    assert disp.post(f"/api/shared/{t2}/predict",
                     json={"points": [{"rf_power": 500, "pressure": 20, "cl2_flow": 80}]}).status_code == 403
    owner.delete(f"/api/projects/{pid}/shares/{sh.json()['id']}")
    assert disp.get(f"/api/shared/{t2}").status_code == 410


def test_soft_delete_and_restore(client_for):
    owner = client_for("E1001")
    r = owner.post("/api/projects", json={"name": "임시", "config": {
        "factors": [{"key": "a", "name": "A", "low": 0, "high": 10, "step": 1}],
        "responses": [{"key": "y", "name": "Y"}]}})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    member = client_for("E1002")
    owner.post(f"/api/projects/{pid}/members", json={"user_id": member.get("/api/auth/me").json()["id"],
                                                     "role": "editor"})
    assert member.get(f"/api/projects/{pid}").status_code == 200
    owner.delete(f"/api/projects/{pid}")
    assert member.get(f"/api/projects/{pid}").status_code == 404
    assert any(p["id"] == pid for p in owner.get("/api/projects?scope=trash").json())
    assert owner.post(f"/api/projects/{pid}/restore").status_code == 200
    assert member.get(f"/api/projects/{pid}").status_code == 200


def test_mock_auth_refused_in_prod():
    with pytest.raises(RuntimeError):
        validate_settings(Settings(env="prod", auth_mode="mock", secret_key="x" * 32))


def test_excel_roundtrip_preview(client_for):
    owner = client_for("E1001")
    pid = _demo_id(owner)
    x = owner.get(f"/api/projects/{pid}/runsheet.xlsx")
    assert x.status_code == 200
    import io
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(x.content))
    ws = wb["실험 시트"]
    header = [c.value for c in ws[1]]
    col = header.index("식각률 [nm/min]") + 1
    for row in range(2, ws.max_row + 1):
        if ws.cell(row=row, column=header.index("상태") + 1).value == "계획":
            ws.cell(row=row, column=col).value = "3l5"  # 오타
            break
    buf = io.BytesIO()
    wb.save(buf)
    r = owner.post(f"/api/projects/{pid}/results/preview",
                   files={"file": ("sheet.xlsx", buf.getvalue(),
                                   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert r.status_code == 200, r.text
    assert r.json()["summary"]["errors"] >= 1


def test_user_search_requires_query(client_for):
    c = client_for("E2001")
    assert c.get("/api/users/search?q=").json() == []
    assert c.get("/api/users/search?q=%20").json() == []
    assert [u["user_key"] for u in c.get("/api/users/search?q=김서연").json()] == ["E1001"]
