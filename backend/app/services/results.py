"""결과 입력: 측정값 버전 관리, 상태 자동 갱신, 입력 검증(차단하지 않는 경고 포함)."""
from __future__ import annotations

import math

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..audit import audit
from ..models import Measurement, Project, Run, User
from ..schemas import ProjectConfig, ResultRow

STATUS_KO = {"planned": "계획", "running": "진행중", "done": "완료", "failed": "실패", "infeasible": "실행불가",
             "excluded": "제외"}
STATUS_FROM_KO = {v: k for k, v in STATUS_KO.items()}


def current_measurements(db: Session, run_ids: list[int]) -> dict[tuple[int, str], Measurement]:
    if not run_ids:
        return {}
    rows = db.scalars(select(Measurement).where(Measurement.run_id.in_(run_ids), Measurement.is_current.is_(True)))
    return {(m.run_id, m.response_key): m for m in rows}


def static_checks(cfg: ProjectConfig, row: ResultRow, run: Run) -> tuple[list[str], list[str]]:
    """(errors, warnings). 오류는 저장 불가, 경고는 확인 권장."""
    errors: list[str] = []
    warns: list[str] = []
    fkeys = {f.key: f for f in cfg.factors}
    rkeys = {r.key: r for r in cfg.responses}
    for k, v in (row.actual or {}).items():
        f = fkeys.get(k)
        if f is None:
            errors.append(f"알 수 없는 인자: {k}")
            continue
        if v is None or not math.isfinite(v):
            errors.append(f"{f.name} 실제값이 숫자가 아닙니다.")
            continue
        if v < f.low or v > f.high:
            warns.append(f"{f.name} 실제값 {v:g}{f.unit}이 설정 범위({f.low:g}~{f.high:g})를 벗어났습니다.")
        pv = run.planned.get(k)
        if pv is not None and abs(v - pv) > 1e-9:
            warns.append(f"{f.name}이 계획값({pv:g})과 다릅니다. 차이가 생긴 이유를 메모에 남겨 주세요.")
    for k, v in (row.values or {}).items():
        r = rkeys.get(k)
        if r is None:
            errors.append(f"알 수 없는 응답: {k}")
            continue
        if v is None:
            continue
        if not math.isfinite(v):
            errors.append(f"{r.name} 값이 숫자가 아닙니다.")
            continue
        if r.input_min is not None and v < r.input_min or r.input_max is not None and v > r.input_max:
            warns.append(f"{r.name} 값 {v:g}이 입력 허용 범위를 벗어났습니다. 값과 단위를 확인해 주세요.")
    return errors, warns


def prediction_checks(cfg: ProjectConfig, model_by_resp: dict, run: Run, values: dict[str, float | None]) -> list[str]:
    """모델 예측 범위를 크게 벗어나면 경고 (차단하지 않음, CLAUDE.md 7.3절)."""
    warns: list[str] = []
    keys = [f.key for f in cfg.factors]
    src = run.actual or run.planned
    x = np.array([[float(src[k]) for k in keys]])
    for rk, v in values.items():
        m = model_by_resp.get(rk)
        if m is None or v is None:
            continue
        p = m.predict(x)
        mu, sd = float(p.mean[0]), float(np.sqrt(p.total_var[0]))
        r = cfg.response(rk)
        if abs(v - mu) > 4 * sd:
            msg = f"{r.name} 값 {v:g}이 예측 범위({mu - 3 * sd:.4g}~{mu + 3 * sd:.4g})를 크게 벗어났습니다."
            if mu != 0:
                ratio = abs(v / mu)
                if 8 < ratio < 12 or 0.08 < ratio < 0.12 or 800 < ratio < 1200 or 0.0008 < ratio < 0.0012:
                    msg += " 단위(10배·1000배) 입력 실수가 아닌지 확인해 주세요."
                else:
                    msg += " 값과 단위를 다시 확인해 주세요. 실제 결과라면 그대로 저장해도 됩니다."
            warns.append(msg)
    return warns


def apply_row(db: Session, user: User, project: Project, cfg: ProjectConfig, run: Run, row: ResultRow,
              current: dict[tuple[int, str], Measurement]) -> bool:
    changed = False
    if row.actual:
        new_actual = dict(run.actual or run.planned)
        new_actual.update({k: float(v) for k, v in row.actual.items()})
        if new_actual != run.actual:
            run.actual = new_actual
            changed = True
    if row.deviation_note is not None and row.deviation_note != run.deviation_note:
        run.deviation_note = row.deviation_note
        changed = True
    if row.fail_reason is not None and row.fail_reason != run.fail_reason:
        run.fail_reason = row.fail_reason
        changed = True
    for rk, v in (row.values or {}).items():
        cur = current.get((run.id, rk))
        old = cur.value if cur else None
        if cur is None and v is None:
            continue
        if cur is not None and (old == v or (old is not None and v is not None and abs(old - v) < 1e-12)):
            if row.note is not None and row.note != cur.note:
                cur.note = row.note
                changed = True
            continue
        version = 1
        excluded, ex_reason = False, ""
        if cur is not None:
            cur.is_current = False
            version = cur.version + 1
            excluded, ex_reason = cur.excluded, cur.exclude_reason
        m = Measurement(run_id=run.id, response_key=rk, value=v, version=version, is_current=True, excluded=excluded,
                        exclude_reason=ex_reason, note=row.note or (cur.note if cur else ""), created_by=user.id)
        db.add(m)
        current[(run.id, rk)] = m
        if cur is not None:
            audit(db, user.id, "measurement.revise", "run", run.id, response=rk, version=version)
        changed = True
    if row.status is not None and row.status != run.status:
        audit(db, user.id, "run.status", "run", run.id, frm=run.status, to=row.status)
        run.status = row.status
        changed = True
    # 모든 응답이 입력되면 자동으로 완료 처리
    if run.status in ("planned", "running"):
        if all(current.get((run.id, r.key)) is not None and current[(run.id, r.key)].value is not None
               for r in cfg.responses):
            run.status = "done"
            changed = True
    return changed
