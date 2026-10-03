from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..audit import audit
from ..auth.deps import get_current_user
from ..authz import require_project
from ..db import get_db
from ..modeling.design import initial_design
from ..models import DesignBatch, Measurement, Project, Run, User
from ..schemas import (BatchOut, ExcludeIn, ImportIn, ImportOut, InitialDesignIn, ManualRunIn, ProjectConfig, ResultRow,
                       ResultsIn, RunOut)
from ..services.analysis import fitted_model, load_training, space_of
from ..services.common import project_config
from ..services.excel import build_runsheet, build_table_export, parse_upload
from ..services.results import apply_row, current_measurements, prediction_checks, static_checks

router = APIRouter(prefix="/api/projects/{project_id}", tags=["runs"])


def _run_out(run: Run, seq: int, cfg: ProjectConfig, meas: dict) -> RunOut:
    vals, exc, notes = {}, {}, {}
    for r in cfg.responses:
        m = meas.get((run.id, r.key))
        vals[r.key] = m.value if m else None
        exc[r.key] = bool(m.excluded) if m else False
        notes[r.key] = m.note if m else ""
    return RunOut(id=run.id, batch_id=run.batch_id, batch_seq=seq, code=run.code, replicate_no=run.replicate_no,
                  run_order=run.run_order, is_replicate_of_existing=run.is_replicate_of_existing, status=run.status,
                  planned=run.planned, actual=run.actual or run.planned, fail_reason=run.fail_reason,
                  deviation_note=run.deviation_note, reason=run.reason, values=vals, excluded=exc, notes=notes,
                  updated_at=run.updated_at)


def run_code(seq: int, n: int) -> str:
    """사람이 읽는 런 ID: '{차수}차-{번호}' (예: 2차-07)"""
    return f"{seq}차-{n:02d}"


def _seq_map(db: Session, project_id: int) -> dict[int, int]:
    return {b.id: b.seq for b in db.scalars(select(DesignBatch).where(DesignBatch.project_id == project_id))}


def next_batch_seq(db: Session, project_id: int) -> int:
    return (db.scalar(select(func.max(DesignBatch.seq)).where(DesignBatch.project_id == project_id)) or 0) + 1


def create_batch(db: Session, user: User, project: Project, cfg: ProjectConfig, kind: str, points: list[dict],
                 surrogate: str | None = None, surrogate_version: str | None = None, acquisition: dict | None = None,
                 seed: int = 0, note: str = "") -> DesignBatch:
    """points: [{x, replicate_no?, reason?, kind?}] — 실행 순서를 무작위화하여 런을 만든다."""
    import numpy as np

    seq = next_batch_seq(db, project.id)
    b = DesignBatch(project_id=project.id, seq=seq, kind=kind, surrogate=surrogate, surrogate_version=surrogate_version,
                    acquisition=acquisition or {}, seed=seed, note=note, created_by=user.id)
    db.add(b)
    db.flush()
    sp = space_of(cfg)
    order = np.random.default_rng(seed + seq * 7919).permutation(len(points))
    for pos, idx in enumerate(order):
        pt = points[int(idx)]
        x = sp.to_dicts(sp.snap(sp.from_dicts([pt["x"]])))[0]
        db.add(Run(project_id=project.id, batch_id=b.id, code=run_code(seq, pos + 1), replicate_no=pt.get("replicate_no", 1),
                   run_order=pos + 1, is_replicate_of_existing=pt.get("kind") == "replicate", status="planned",
                   planned=x, actual=dict(x), reason=pt.get("reason", "")))
    audit(db, user.id, "batch.create", "project", project.id, batch=seq, kind=kind, runs=len(points))
    return b


@router.post("/design/initial", response_model=BatchOut)
def make_initial(project_id: int, body: InitialDesignIn, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)) -> BatchOut:
    p, _ = require_project(db, user, project_id, "editor")
    cfg = project_config(p)
    st = cfg.settings
    n = body.n_points or st.initial_points or cfg.recommended_initial_points()
    runs = initial_design(space_of(cfg), n, body.method or st.design_method,
                          st.replicate_fraction if body.replicate_fraction is None else body.replicate_fraction,
                          body.replicates_per_point or st.replicates_per_point, body.seed)
    pts = [{"x": r.x, "replicate_no": r.replicate_no,
            "reason": "초기 설계: 인자 공간 전체를 고르게 살펴보기 위한 조건입니다." +
                      (" 산포 추정을 위한 반복 측정입니다." if r.replicate_no > 1 or
                       sum(1 for q in runs if q.point_index == r.point_index) > 1 else "")} for r in runs]
    b = create_batch(db, user, p, cfg, "initial", pts, acquisition={"method": body.method or st.design_method,
                                                                     "n_points": n}, seed=body.seed,
                     note="초기 설계")
    db.commit()
    return _batch_out(db, b)


def _batch_out(db: Session, b: DesignBatch) -> BatchOut:
    rows = db.execute(select(Run.status, func.count()).where(Run.batch_id == b.id).group_by(Run.status)).all()
    by = {s: c for s, c in rows}
    u = db.get(User, b.created_by)
    return BatchOut(id=b.id, seq=b.seq, kind=b.kind, surrogate=b.surrogate, acquisition=b.acquisition or {},
                    note=b.note, created_at=b.created_at, created_by=u.name if u else "",
                    runs_total=sum(by.values()), runs_done=by.get("done", 0))


@router.get("/batches", response_model=list[BatchOut])
def batches(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[BatchOut]:
    p, _ = require_project(db, user, project_id)
    return [_batch_out(db, b) for b in db.scalars(select(DesignBatch).where(DesignBatch.project_id == p.id)
                                                  .order_by(DesignBatch.seq))]


@router.delete("/batches/{batch_id}")
def cancel_batch(project_id: int, batch_id: int, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)) -> dict:
    p, _ = require_project(db, user, project_id, "editor")
    b = db.get(DesignBatch, batch_id)
    if b is None or b.project_id != p.id:
        raise HTTPException(404, "배치를 찾을 수 없습니다.")
    runs = list(db.scalars(select(Run).where(Run.batch_id == b.id)))
    if any(r.status not in ("planned",) for r in runs):
        raise HTTPException(409, "이미 진행했거나 결과가 있는 런이 있어 배치를 취소할 수 없습니다. 개별 런을 '실행불가'로 표시하세요.")
    for r in runs:
        db.delete(r)
    db.delete(b)
    audit(db, user.id, "batch.cancel", "project", p.id, batch=b.seq)
    db.commit()
    return {"ok": True}


@router.post("/batches/manual", response_model=BatchOut)
def manual_batch(project_id: int, body: ManualRunIn, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)) -> BatchOut:
    p, _ = require_project(db, user, project_id, "editor")
    cfg = project_config(p)
    keys = [f.key for f in cfg.factors]
    for pt in body.points:
        if any(k not in pt for k in keys):
            raise HTTPException(400, "모든 인자 값을 입력하세요.")
    reason = ("추천 레시피의 재현성을 확인하는 확인 실험입니다." if body.kind == "confirmation"
              else "직접 추가한 실험입니다.")
    pts = [{"x": pt, "reason": reason, "replicate_no": i + 1 if body.kind == "confirmation" else 1}
           for i, pt in enumerate(body.points)]
    b = create_batch(db, user, p, cfg, body.kind, pts,
                     note=body.note or ("확인 실험" if body.kind == "confirmation" else "직접 추가"))
    db.commit()
    return _batch_out(db, b)


IMPORT_SEQ = 0  # 기존 데이터는 '0차'로 묶는다 (앱이 제안한 실험은 1차부터)


@router.post("/import", response_model=ImportOut)
def import_existing(project_id: int, body: ImportIn, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)) -> ImportOut:
    """이미 해 둔 실험 데이터 가져오기. 같은 조건이 여러 행이면 반복 측정으로 본다.
    인자 값은 세팅 정밀도로 반올림하지 않는다 (실제로 세팅한 값이므로 그대로 학습)."""
    import math

    p, _ = require_project(db, user, project_id, "editor")
    cfg = project_config(p)
    fs = {f.key: f for f in cfg.factors}
    rkeys = {r.key for r in cfg.responses}
    problems: list[str] = []
    for i, row in enumerate(body.rows, start=1):
        for f in cfg.factors:
            v = row.x.get(f.key)
            if v is None or not math.isfinite(v):
                problems.append(f"{i}행: '{f.name}' 값이 없습니다.")
            elif not (f.low - 1e-9 <= v <= f.high + 1e-9):
                problems.append(f"{i}행: '{f.name}' {v:g}이(가) 설정 범위({f.low:g}~{f.high:g}) 밖입니다.")
        unknown = [k for k in list(row.x) if k not in fs] + [k for k in row.values if k not in rkeys]
        if unknown:
            problems.append(f"{i}행: 알 수 없는 열 {', '.join(unknown)}")
        bad = [k for k, v in row.values.items() if v is not None and not math.isfinite(v)]
        if bad:
            problems.append(f"{i}행: 숫자가 아닌 결과 {', '.join(bad)}")
    if problems:
        more = f" 외 {len(problems) - 5}건" if len(problems) > 5 else ""
        raise HTTPException(422, " ".join(problems[:5]) + more)

    b = db.scalar(select(DesignBatch).where(DesignBatch.project_id == p.id, DesignBatch.seq == IMPORT_SEQ))
    if b is None:
        b = DesignBatch(project_id=p.id, seq=IMPORT_SEQ, kind="import", acquisition={}, seed=0, note="기존 데이터",
                        created_by=user.id)
        db.add(b)
        db.flush()
    existing = list(db.scalars(select(Run).where(Run.batch_id == b.id)))
    n = len(existing)
    key = lambda x: tuple(round(float(x[f.key]), 9) for f in cfg.factors)  # noqa: E731
    count: dict[tuple, int] = {}
    for r in existing:
        if r.status != "excluded":
            count[key(r.actual or r.planned)] = count.get(key(r.actual or r.planned), 0) + 1
    current: dict = {}
    done = 0
    for row in body.rows:
        x = {f.key: float(row.x[f.key]) for f in cfg.factors}
        k = key(x)
        count[k] = count.get(k, 0) + 1
        n += 1
        run = Run(project_id=p.id, batch_id=b.id, code=run_code(IMPORT_SEQ, n), replicate_no=count[k], run_order=n,
                  is_replicate_of_existing=False, status="planned", planned=x, actual=dict(x),
                  reason="가져온 기존 실험 데이터입니다.", deviation_note=row.note)  # 메모 칸
        db.add(run)
        db.flush()
        vals = {rk: v for rk, v in row.values.items() if v is not None}
        if vals:
            apply_row(db, user, p, cfg, run, ResultRow(run_id=run.id, values=vals), current)
        done += run.status == "done"
    audit(db, user.id, "data.import", "project", p.id, rows=len(body.rows), done=done)
    db.commit()
    return ImportOut(batch=_batch_out(db, b), imported=len(body.rows), done=done,
                     replicated_conditions=sum(1 for c in count.values() if c >= 2))


@router.get("/runs", response_model=list[RunOut])
def list_runs(project_id: int, batch_id: int | None = None, status: str | None = None, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)) -> list[RunOut]:
    p, _ = require_project(db, user, project_id)
    cfg = project_config(p)
    stmt = select(Run).where(Run.project_id == p.id, Run.status != "excluded")  # 삭제한 런은 보이지 않음
    if batch_id:
        stmt = stmt.where(Run.batch_id == batch_id)
    if status:
        stmt = stmt.where(Run.status.in_(status.split(",")))
    runs = list(db.scalars(stmt))
    seq = _seq_map(db, p.id)
    runs.sort(key=lambda r: (seq.get(r.batch_id, 0), r.run_order))
    meas = current_measurements(db, [r.id for r in runs])
    return [_run_out(r, seq.get(r.batch_id, 0), cfg, meas) for r in runs]


@router.get("/runs/{run_id}", response_model=RunOut)
def get_run(project_id: int, run_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> RunOut:
    p, _ = require_project(db, user, project_id)
    r = db.get(Run, run_id)
    if r is None or r.project_id != p.id:
        raise HTTPException(404, "런을 찾을 수 없습니다.")
    seq = _seq_map(db, p.id)
    return _run_out(r, seq.get(r.batch_id, 0), project_config(p), current_measurements(db, [r.id]))


def _models_for_check(db: Session, p: Project, cfg: ProjectConfig) -> dict:
    out = {}
    for r in cfg.responses:
        data, _ = load_training(db, p, cfg, r.key)
        if data.n_points >= max(5, len(cfg.factors) + 2):
            try:
                out[r.key] = fitted_model(cfg, data, "gp")
            except Exception:  # 검증 보조 기능이므로 실패해도 저장은 진행
                pass
    return out


@router.post("/results")
def save_results(project_id: int, body: ResultsIn, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)) -> dict:
    p, _ = require_project(db, user, project_id, "runner")
    cfg = project_config(p)
    ids = [r.run_id for r in body.rows]
    runs = {r.id: r for r in db.scalars(select(Run).where(Run.id.in_(ids), Run.project_id == p.id))}
    if len(runs) != len(set(ids)):
        raise HTTPException(404, "이 프로젝트에 없는 런이 포함되어 있습니다.")
    errors: dict[int, list[str]] = {}
    warnings: dict[int, list[str]] = {}
    for row in body.rows:
        e, w = static_checks(cfg, row, runs[row.run_id])
        if e:
            errors[row.run_id] = e
        if w:
            warnings[row.run_id] = w
    if errors:
        raise HTTPException(422, {"message": "저장하지 못한 행이 있습니다.", "errors": errors})
    models = _models_for_check(db, p, cfg)
    for row in body.rows:
        if row.values:
            pw = prediction_checks(cfg, models, runs[row.run_id], row.values)
            if pw:
                warnings.setdefault(row.run_id, []).extend(pw)
    current = current_measurements(db, ids)
    changed = 0
    for row in body.rows:
        if apply_row(db, user, p, cfg, runs[row.run_id], row, current):
            changed += 1
    if changed:
        audit(db, user.id, "results.save", "project", p.id, rows=changed)
        p.updated_at = p.updated_at  # touch
    db.commit()
    seq = _seq_map(db, p.id)
    meas = current_measurements(db, ids)
    return {"saved": changed, "warnings": {str(k): v for k, v in warnings.items()},
            "runs": [_run_out(runs[i], seq.get(runs[i].batch_id, 0), cfg, meas).model_dump(mode="json")
                     for i in dict.fromkeys(ids)]}


@router.delete("/runs/{run_id}")
def delete_run(project_id: int, run_id: int, db: Session = Depends(get_db),
               user: User = Depends(get_current_user)) -> dict:
    """런 삭제: 표와 학습에서 빠진다. 측정값·이력은 지우지 않고 '삭제됨'(excluded)으로만 표시해 복구할 수 있게 둔다."""
    p, _ = require_project(db, user, project_id, "editor")
    r = db.get(Run, run_id)
    if r is None or r.project_id != p.id or r.status == "excluded":
        raise HTTPException(404, "런을 찾을 수 없습니다.")
    audit(db, user.id, "run.delete", "project", p.id, run=r.code, status=r.status)
    r.status = "excluded"
    db.commit()
    return {"ok": True}


@router.post("/runs/{run_id}/exclude")
def exclude(project_id: int, run_id: int, body: ExcludeIn, db: Session = Depends(get_db),
            user: User = Depends(get_current_user)) -> dict:
    p, _ = require_project(db, user, project_id, "editor")
    r = db.get(Run, run_id)
    if r is None or r.project_id != p.id:
        raise HTTPException(404, "런을 찾을 수 없습니다.")
    m = db.scalar(select(Measurement).where(Measurement.run_id == r.id, Measurement.response_key == body.response_key,
                                            Measurement.is_current.is_(True)))
    if m is None:
        raise HTTPException(404, "측정값이 없습니다.")
    m.excluded = body.excluded
    m.exclude_reason = body.reason
    audit(db, user.id, "measurement.exclude" if body.excluded else "measurement.include", "project", p.id,
          run=r.code, response=body.response_key, reason=body.reason)
    db.commit()
    return {"ok": True}


@router.get("/runs.xlsx")
def export_runs(project_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    """실험 표 엑셀 다운로드 (화면의 표와 같은 열, 삭제한 런 제외)"""
    from urllib.parse import quote

    p, _ = require_project(db, user, project_id)
    cfg = project_config(p)
    runs = list(db.scalars(select(Run).where(Run.project_id == p.id, Run.status != "excluded")))
    seq = _seq_map(db, p.id)
    runs.sort(key=lambda r: (seq.get(r.batch_id, 0), r.run_order))
    data = build_table_export(p, cfg, runs, current_measurements(db, [r.id for r in runs]))
    audit(db, user.id, "data.export", "project", p.id, runs=len(runs))
    db.commit()
    safe = "".join(ch for ch in p.name if ch not in '\\/:*?"<>|').strip() or f"DOE_{p.id}"
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename=\"ReDO_{p.id}.xlsx\"; "
                                                    f"filename*=UTF-8''{quote(safe + '_실험데이터.xlsx')}"})


@router.get("/runsheet.xlsx")
def runsheet(project_id: int, batch_id: int | None = None, db: Session = Depends(get_db),
             user: User = Depends(get_current_user)) -> Response:
    p, _ = require_project(db, user, project_id)
    cfg = project_config(p)
    stmt = select(Run).where(Run.project_id == p.id)
    if batch_id:
        stmt = stmt.where(Run.batch_id == batch_id)
    runs = list(db.scalars(stmt))
    seq = _seq_map(db, p.id)
    runs.sort(key=lambda r: (seq.get(r.batch_id, 0), r.run_order))
    data = build_runsheet(p, cfg, runs, seq, current_measurements(db, [r.id for r in runs]))
    name = f"ReDO_{p.id}_" + (f"{seq.get(batch_id, '')}차" if batch_id else "all") + ".xlsx"
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/results/preview")
async def preview_upload(project_id: int, file: UploadFile = File(...), db: Session = Depends(get_db),
                         user: User = Depends(get_current_user)) -> dict:
    p, _ = require_project(db, user, project_id, "runner")
    cfg = project_config(p)
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "파일이 너무 큽니다 (최대 10MB).")
    rows, file_errors = parse_upload(file.filename or "", content, p, cfg)
    runs = {r.code: r for r in db.scalars(select(Run).where(Run.project_id == p.id))}
    meas = current_measurements(db, [r.id for r in runs.values()])
    out = []
    for rec in rows:
        run = runs.get(rec["code"] or "")
        item = {"code": rec["code"], "run_id": run.id if run else None, "changes": [], "errors": list(rec["errors"]),
                "warnings": [], "row": None}
        if run is None:
            item["errors"].append("이 프로젝트에 없는 런 ID입니다.")
            out.append(item)
            continue
        actual = {k: v for k, v in rec["actual"].items() if abs(v - (run.actual or run.planned).get(k, v)) > 1e-12}
        values = {}
        for rk, v in rec["values"].items():
            m = meas.get((run.id, rk))
            old = m.value if m else None
            if old != v:
                values[rk] = v
                item["changes"].append({"field": cfg.response(rk).name, "old": old, "new": v})
        for k, v in actual.items():
            f = next(f for f in cfg.factors if f.key == k)
            item["changes"].append({"field": f"{f.name} 실제값", "old": (run.actual or run.planned).get(k), "new": v})
        status = rec["status"] if rec["status"] and rec["status"] != run.status else None
        if status:
            item["changes"].append({"field": "상태", "old": run.status, "new": status})
        note = rec["note"] if rec["note"] is not None and rec["note"] != run.deviation_note else None
        if note is not None:
            item["changes"].append({"field": "메모", "old": run.deviation_note, "new": note})
        row = ResultRow(run_id=run.id, actual=actual or None, values=values or None, status=status,
                        deviation_note=note)
        e, w = static_checks(cfg, row, run)
        item["errors"] += e
        item["warnings"] += w
        item["row"] = row.model_dump()
        out.append(item)
    return {"file_errors": file_errors, "rows": out,
            "summary": {"rows": len(out), "changed": sum(1 for r in out if r["changes"] and not r["errors"]),
                        "errors": sum(1 for r in out if r["errors"])}}
