"""AI 도우미(DDS Conversa)·MCP가 쓰는 업무 단위 도구.

API 59개를 그대로 주면 사내 로컬 LLM이 고르기 어렵다. 엔지니어가 실제로 하는 일 단위로 14개만 연다.
- 읽기 도구: 바로 실행한다.
- 쓰기 도구: prepare(검증 + 바뀔 내용 미리 보기)와 execute(실행)로 나뉜다. 사람이 미리 보기를 확인한 뒤에만 실행한다.
  (화면 대화창: 확인 카드 → 사용자가 [실행] / MCP: confirm=true로 다시 호출, MCP 호스트의 승인 화면을 거침)
- 되돌리기 어려운 작업(삭제·공유·멤버 관리·소유권 이전)은 danger 도구: 미리 보기 → [실행] → "정말 할까요?" 재확인까지
  두 번 승인해야 실행된다 (서버가 강제. MCP는 confirm=true + confirm_again=true).

모든 도구는 기존 API 함수를 그대로 불러 같은 권한 검사(require_project)·검증·감사 로그를 거친다.
DOE·인자·응답·런은 사람이 쓰는 이름(예: "CMP 슬러리", "제거율", "1차-03")으로 지정할 수 있다.
"""
from __future__ import annotations

import json
import random
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from ..authz import require_project
from ..models import Project, User
from ..schemas import (AcceptProposalIn, AnalysisIn, FactorDef, ImportIn, InitialDesignIn, PredictIn, ProjectConfig,
                       ProjectCreate, RecommendIn, ResponseDef, ResultsIn)
from ..services.common import project_config
from .manual_search import search_manual

GOAL_KO = {"maximize": "클수록 좋음(망대)", "minimize": "작을수록 좋음(망소)", "target": "목표값(망목)"}
STATUS_KO = {"planned": "대기", "running": "대기", "done": "완료", "failed": "실패", "infeasible": "실행불가", "excluded": "삭제됨"}
ROLE_KO = {"owner": "소유자", "editor": "편집자", "runner": "실험자", "viewer": "열람자"}
ROLE_RANK = {"viewer": 0, "runner": 1, "editor": 2, "owner": 3}


class ToolError(Exception):
    """사용자·LLM에게 그대로 보여 줄 수 있는 오류 (내부 정보 없음)"""


@dataclass
class ToolContext:
    db: Session
    user: User
    project_id: int | None = None  # 화면에서 지금 보고 있는 DOE (DOE를 말하지 않으면 이것을 쓴다)


@dataclass
class Tool:
    name: str
    title: str
    description: str
    params: dict  # JSON Schema (object)
    writes: bool = False
    danger: bool = False  # 되돌리기 어려운 작업: 두 번 확인
    run: Callable[[ToolContext, dict], Any] | None = None                    # 읽기 도구
    prepare: Callable[[ToolContext, dict], tuple[dict, dict]] | None = None  # 쓰기: (정리된 인자, 미리 보기)
    execute: Callable[[ToolContext, dict], Any] | None = None                # 쓰기: 실행
    tags: list[str] = field(default_factory=list)

    def schema(self) -> dict:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.params}}


# ---------------------------------------------------------------- 공통 도움 함수
def _norm(s: str) -> str:
    return re.sub(r"[\s_·:()\[\]{}]", "", str(s)).lower()


def _num(v: Any) -> float:
    if isinstance(v, bool):
        raise ToolError(f"숫자가 아닙니다: {v}")
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError as e:
        raise ToolError(f"숫자가 아닙니다: {v}") from e


def _fmt(v: float | None, decimals: int = 3) -> float | None:
    if v is None:
        return None
    return round(float(v), max(0, min(decimals, 6)))


def _summaries(ctx: ToolContext) -> list:
    from ..routers.projects import list_projects
    return list_projects(scope="mine", q="", status="", db=ctx.db, user=ctx.user) + \
        list_projects(scope="member", q="", status="", db=ctx.db, user=ctx.user)


def find_doe(ctx: ToolContext, ref: Any, trash: bool = False) -> Project:
    """DOE 지정: 번호, 이름(일부), 또는 생략(지금 화면의 DOE). 여러 개가 맞으면 후보를 알려 준다. trash=True면 휴지통에서 찾는다."""
    if ref is None or str(ref).strip() == "":
        if ctx.project_id is None:
            raise ToolError("어느 DOE인지 알려 주세요. (list_does로 목록을 볼 수 있습니다)")
        ref = ctx.project_id
    s = str(ref).strip()
    if re.fullmatch(r"\d+", s):
        try:
            p, _ = require_project(ctx.db, ctx.user, int(s), allow_deleted=trash)
        except HTTPException:
            raise ToolError(f"DOE {s}번을 찾을 수 없거나 볼 권한이 없습니다.")
        return p
    if trash:
        from ..routers.projects import list_projects
        items = list_projects(scope="trash", q="", status="", db=ctx.db, user=ctx.user)
    else:
        items = _summaries(ctx)
    key = _norm(s)
    exact = [x for x in items if _norm(x.name) == key]
    part = exact or [x for x in items if key in _norm(x.name)]
    if not part:
        raise ToolError(f"'{s}'라는 DOE를 찾지 못했습니다. 볼 수 있는 DOE: " + ", ".join(f"{x.name}(#{x.id})" for x in items[:10]))
    if len(part) > 1:
        raise ToolError("여러 DOE가 맞습니다. 하나를 골라 주세요: " + ", ".join(f"{x.name}(#{x.id})" for x in part[:10]))
    p, _ = require_project(ctx.db, ctx.user, part[0].id, allow_deleted=trash)
    return p


def _find_user(ctx: ToolContext, ref: Any) -> User:
    """사용자 지정: 이름 또는 사번. 여러 명이면 후보(부서·사번)를 알려 준다."""
    from ..auth.deps import get_auth_provider
    q = str(ref or "").strip()
    if not q:
        raise ToolError("누구인지 이름이나 사번을 알려 주세요.")
    found = get_auth_provider().search_users(ctx.db, q, 20)
    exact = [u for u in found if u.name == q or u.user_key.lower() == q.lower()]
    cand = exact or found
    if not cand:
        raise ToolError(f"'{q}' 사용자를 찾지 못했습니다.")
    if len(cand) > 1:
        raise ToolError("여러 명이 맞습니다. 사번으로 알려 주세요: " + ", ".join(
            f"{u.name}({u.department.name if u.department else ''}, {u.user_key})" for u in cand[:10]))
    return cand[0]


def _who(u: User) -> str:
    return f"{u.name}({u.department.name if u.department else ''}, {u.user_key})"


def _role(ctx: ToolContext, p: Project) -> str:
    from ..authz import project_role
    return project_role(ctx.db, ctx.user, p) or "viewer"


def _need(ctx: ToolContext, p: Project, role: str, what: str) -> None:
    if ROLE_RANK.get(_role(ctx, p), 0) < ROLE_RANK[role]:
        raise ToolError(f"{what}은(는) {ROLE_KO[role]} 이상만 할 수 있습니다. (내 권한: {ROLE_KO.get(_role(ctx, p), '없음')})")


def _match(items: list, name: str) -> Any | None:
    """이름 맞추기: 정확히 같으면 그것, 아니면 이름의 일부(예: '산화제' → '산화제(H₂O₂)')가 하나만 맞을 때"""
    n = _norm(name)
    if not n:
        return None
    exact = [x for x in items if n in (_norm(x.name), _norm(x.key), _norm(x.name + x.unit))]
    if exact:
        return exact[0]
    part = [x for x in items if _norm(x.name).startswith(n) or n in _norm(x.name)]
    return part[0] if len(part) == 1 else None


def _factor_key(cfg: ProjectConfig, name: str) -> str:
    f = _match(cfg.factors, name)
    if f is None:
        raise ToolError(f"'{name}'은(는) 이 DOE의 인자가 아닙니다. 인자: " + ", ".join(f.name for f in cfg.factors))
    return f.key


def _response_key(cfg: ProjectConfig, name: str) -> str:
    r = _match(cfg.responses, name)
    if r is None:
        raise ToolError(f"'{name}'은(는) 이 DOE의 응답이 아닙니다. 응답: " + ", ".join(r.name for r in cfg.responses))
    return r.key


def _conditions(cfg: ProjectConfig, cond: dict, need_all: bool = True) -> dict[str, float]:
    if not isinstance(cond, dict):
        raise ToolError("조건은 {인자 이름: 값} 형태로 주세요.")
    x = {_factor_key(cfg, k): _num(v) for k, v in cond.items()}
    missing = [f.name for f in cfg.factors if f.key not in x]
    if need_all and missing:
        raise ToolError("빠진 인자 값이 있습니다: " + ", ".join(missing))
    return x


def _named(cfg: ProjectConfig, x: dict[str, float]) -> dict[str, Any]:
    return {f"{f.name}" + (f" [{f.unit}]" if f.unit else ""): _fmt(x.get(f.key), 6) for f in cfg.factors if f.key in x}


def _next_action(s: Any) -> str:
    if s.status == "archived":
        return "보관됨"
    if s.runs_total == 0:
        return "첫 실험 계획 필요(start_first_design 또는 기존 데이터 가져오기)"
    if s.runs_open > 0:
        return f"결과 입력 · {s.runs_open}건 남음"
    return "추천 레시피 확인 → 다음 실험 확정"


def _http_message(e: HTTPException) -> str:
    d = e.detail
    if isinstance(d, dict):
        msg = d.get("message", "요청을 처리하지 못했습니다.")
        errs = d.get("errors")
        if isinstance(errs, dict):
            msg += " " + "; ".join(f"{k}: {', '.join(v)}" for k, v in list(errs.items())[:5])
        return msg
    return str(d)


# ---------------------------------------------------------------- 읽기 도구
def t_list_does(ctx: ToolContext, a: dict) -> dict:
    q = _norm(a.get("query") or "")
    rows = []
    for s in _summaries(ctx):
        if q and q not in _norm(s.name) and q not in _norm(s.description or ""):
            continue
        rows.append({"id": s.id, "name": s.name, "my_role": ROLE_KO.get(s.my_role, s.my_role), "owner": s.owner.name,
                     "progress": f"{s.runs_done}/{s.runs_total} 완료", "next": _next_action(s),
                     "favorite": s.is_favorite})
    return {"count": len(rows), "does": rows[:50]}


def t_get_doe(ctx: ToolContext, a: dict) -> dict:
    from ..routers.projects import get_project
    from ..routers.runs import batches
    p = find_doe(ctx, a.get("doe"))
    d = get_project(p.id, db=ctx.db, user=ctx.user)
    cfg = d.config
    bs = batches(p.id, db=ctx.db, user=ctx.user)
    return {
        "id": d.id, "name": d.name, "description": d.description, "status": d.status, "my_role": ROLE_KO.get(d.my_role, d.my_role),
        "owner": d.owner.name, "round": max((b.seq for b in bs), default=None), "progress": f"{d.runs_done}/{d.runs_total} 완료",
        "open_runs": d.runs_open, "next": _next_action(d),
        "factors": [{"name": f.name, "unit": f.unit, "range": [f.low, f.high], "step": f.step} for f in cfg.factors],
        "responses": [{"name": r.name, "unit": r.unit, "goal": GOAL_KO[r.goal], "target": r.target, "lsl": r.lsl, "usl": r.usl,
                       "weight": r.weight} for r in cfg.responses],
        "settings": {"batch_size": cfg.settings.batch_size, "budget_runs": cfg.settings.budget_runs, "model": cfg.settings.default_surrogate},
    }


def t_list_runs(ctx: ToolContext, a: dict) -> dict:
    from ..routers.runs import list_runs
    p = find_doe(ctx, a.get("doe"))
    cfg = project_config(p)
    runs = list_runs(p.id, batch_id=None, status=None, db=ctx.db, user=ctx.user)
    if a.get("only_open"):
        runs = [r for r in runs if r.status in ("planned", "running")]
    if a.get("round") not in (None, ""):
        runs = [r for r in runs if r.batch_seq == int(_num(a["round"]))]
    limit = max(1, min(int(_num(a.get("limit") or 60)), 200))
    out = []
    for r in runs[:limit]:
        out.append({
            "run": r.code, "conditions": _named(cfg, r.actual),
            "results": {x.name: _fmt(r.values.get(x.key), x.decimals) for x in cfg.responses},
            "status": STATUS_KO.get(r.status, r.status), **({"note": r.deviation_note} if r.deviation_note else {}),
        })
    return {"doe": p.name, "total": len(runs), "shown": len(out), "runs": out}


def _resp_out(cfg: ProjectConfig, rr: list[dict]) -> list[dict]:
    dec = {r.key: r.decimals for r in cfg.responses}
    out = []
    for r in rr:
        d = dec.get(r["key"], 3)
        item = {"name": r["name"], "expected": _fmt(r["mean"], d), "unit": r.get("unit", ""),
                "range_1_measure": [_fmt(r.get("obs_lo"), d), _fmt(r.get("obs_hi"), d)], "sigma": _fmt(r.get("sigma"), d)}
        if r.get("spec_prob") is not None:
            item["spec_probability_pct"] = round(100 * r["spec_prob"], 1)
        out.append(item)
    return out


def t_get_recommendation(ctx: ToolContext, a: dict) -> dict:
    from ..routers.optimize import optimize
    p = find_doe(ctx, a.get("doe"))
    cfg = project_config(p)
    try:
        res = optimize(p.id, AnalysisIn(validate_model=False), db=ctx.db, user=ctx.user)
    except HTTPException as e:
        raise ToolError(_http_message(e))
    b = res["best"]
    warns = [f"{d['name']}: {w}" for d in res["responses"] for w in (d.get("warnings") or [])]
    return {
        "doe": p.name, "recommended_recipe": _named(cfg, b["x"]), "goal_score": round(100 * min(max(b["desirability"], 0), 1)),
        "responses": _resp_out(cfg, b["responses"]), "tentative": res["tentative"], "extrapolation": b.get("extrapolation", False),
        "alternatives": [{"why": al["why"], "conditions": _named(cfg, al["x"]), "goal_score": round(100 * min(max(al["desirability"], 0), 1))}
                         for al in res["alternatives"][:3]],
        "warnings": warns[:5],
        "note": "goal_score는 모든 응답의 목표를 함께 만족하는 정도(100점 만점). tentative=true면 실험이 적어 후보로만 볼 것.",
    }


def t_predict(ctx: ToolContext, a: dict) -> dict:
    from ..routers.optimize import predict_multi
    p = find_doe(ctx, a.get("doe"))
    cfg = project_config(p)
    x = _conditions(cfg, a.get("conditions") or {})
    try:
        r = predict_multi(p.id, PredictIn(points=[x]), db=ctx.db, user=ctx.user)[0]
    except HTTPException as e:
        raise ToolError(_http_message(e))
    return {"doe": p.name, "conditions": _named(cfg, x), "goal_score": round(100 * min(max(r["desirability"], 0), 1)),
            "extrapolation": r["extrapolation"], "responses": _resp_out(cfg, r["responses"]),
            **({"warning": "실험한 범위 밖이라 예측이 부정확할 수 있습니다."} if r["extrapolation"] else {})}


def _proposals(ctx: ToolContext, p: Project, count: int | None) -> tuple[list[dict], dict]:
    from ..routers.optimize import recommend_multi
    try:
        rec = recommend_multi(p.id, RecommendIn(batch_size=count, seed=random.randint(0, 99999)), db=ctx.db, user=ctx.user)
    except HTTPException as e:
        raise ToolError(_http_message(e))
    return rec["proposals"], rec


REASON_KO = {"exploit": "좋은 결과 기대", "explore": "아직 모르는 영역", "replicate": "반복 측정"}


def t_propose_next(ctx: ToolContext, a: dict) -> dict:
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "editor", "다음 실험 제안")
    cfg = project_config(p)
    count = int(_num(a["count"])) if a.get("count") not in (None, "") else None
    props, _ = _proposals(ctx, p, count)
    return {"doe": p.name, "proposals": [{"conditions": _named(cfg, pr["x"]), "reason": REASON_KO.get(pr.get("reason_type", ""), pr.get("reason", ""))}
                                         for pr in props],
            "note": "아직 저장하지 않았습니다. 확정하려면 confirm_next_experiments를 쓰세요."}


def t_search_manual(ctx: ToolContext, a: dict) -> dict:
    return {"results": search_manual(str(a.get("query") or ""), limit=3)}


SCREENS = {"home": "/", "new": "/new", "settings": "", "data": "/step/1", "results": "/step/2"}


def t_open_screen(ctx: ToolContext, a: dict) -> dict:
    screen = str(a.get("screen") or "home")
    if screen == "manual":
        return {"ui_action": {"type": "open_manual", "section": a.get("section") or ""}, "message": "사용 매뉴얼을 엽니다."}
    if screen not in SCREENS:
        raise ToolError("screen은 home, new, settings, data, results, manual 중 하나입니다.")
    if screen in ("home", "new"):
        return {"ui_action": {"type": "navigate", "path": SCREENS[screen]}, "message": "화면을 엽니다."}
    p = find_doe(ctx, a.get("doe"))
    return {"ui_action": {"type": "navigate", "path": f"/projects/{p.id}{SCREENS[screen]}"}, "message": f"{p.name} 화면을 엽니다."}


# ---------------------------------------------------------------- 쓰기 도구 (prepare → 사람 확인 → execute)
def _goal(v: Any) -> str:
    s = _norm(v or "maximize")
    if s in ("maximize", "max", "최대", "망대", "클수록좋음", "높게", "크게"):
        return "maximize"
    if s in ("minimize", "min", "최소", "망소", "작을수록좋음", "낮게", "작게"):
        return "minimize"
    if s in ("target", "목표", "목표값", "망목", "맞추기"):
        return "target"
    raise ToolError(f"목표는 최대/최소/목표값 중 하나입니다: {v}")


def p_create_doe(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    name = str(a.get("name") or "").strip()
    if not name:
        raise ToolError("DOE 이름이 필요합니다.")
    fs, rs = a.get("factors") or [], a.get("responses") or []
    if not fs or not rs:
        raise ToolError("인자와 응답이 1개 이상 필요합니다.")
    factors = []
    for i, f in enumerate(fs, start=1):
        low, high = _num(f.get("low")), _num(f.get("high"))
        step = _num(f["step"]) if f.get("step") not in (None, "") else (1.0 if (high - low) >= 20 else round((high - low) / 50, 6) or 0.01)
        factors.append(FactorDef(key=f"f{i}", name=str(f.get("name", f"인자{i}")), unit=str(f.get("unit") or ""), low=low, high=high, step=step))
    responses = []
    for i, r in enumerate(rs, start=1):
        opt = lambda k: _num(r[k]) if r.get(k) not in (None, "") else None  # noqa: E731
        responses.append(ResponseDef(key=f"r{i}", name=str(r.get("name", f"응답{i}")), unit=str(r.get("unit") or ""), goal=_goal(r.get("goal")),
                                     target=opt("target"), lsl=opt("lsl"), usl=opt("usl"), weight=opt("weight") if r.get("weight") not in (None, "") else 1.0))
    cfg = ProjectConfig(factors=factors, responses=responses)
    body = ProjectCreate(name=name, description=str(a.get("description") or ""), config=cfg)
    preview = {
        "title": f"새 DOE '{name}' 만들기",
        "lines": [f"인자 {len(factors)}개: " + ", ".join(f"{f.name} {f.low:g}~{f.high:g}{f.unit} (정밀도 {f.step:g})" for f in factors),
                  f"응답 {len(responses)}개: " + ", ".join(
                      f"{r.name}({GOAL_KO[r.goal]}" + (f", 목표 {r.target:g}" if r.target is not None else "")
                      + (f", LSL {r.lsl:g}" if r.lsl is not None else "") + (f", USL {r.usl:g}" if r.usl is not None else "") + ")"
                      for r in responses)],
    }
    return {"body": body.model_dump()}, preview


def x_create_doe(ctx: ToolContext, a: dict) -> dict:
    from ..routers.projects import create_project
    d = create_project(ProjectCreate.model_validate(a["body"]), db=ctx.db, user=ctx.user)
    return {"created": {"id": d.id, "name": d.name}, "next": "첫 실험 계획(start_first_design) 또는 기존 데이터 가져오기",
            "ui_action": {"type": "navigate", "path": f"/projects/{d.id}/step/1"}}


def p_first_design(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "editor", "첫 실험 계획")
    from ..models import Run
    from sqlalchemy import select
    if ctx.db.scalar(select(Run.id).where(Run.project_id == p.id, Run.status != "excluded").limit(1)) is not None:
        raise ToolError("이미 실험이 있습니다. 첫 실험 계획은 실험이 없을 때만 만듭니다.")
    cfg = project_config(p)
    st = cfg.settings
    n = st.initial_points or cfg.recommended_initial_points()
    rep = round(st.replicate_fraction * n)
    total = n - rep + rep * st.replicates_per_point
    return {"doe": p.id, "seed": random.randint(0, 99999)}, {
        "title": f"'{p.name}' 첫 실험 계획 만들기",
        "lines": [f"{n}개 조건, 총 {total}회 ({rep}개 조건은 {st.replicates_per_point}회 반복)", "인자 범위 전체를 고르게 살펴보는 조건입니다."]}


def x_first_design(ctx: ToolContext, a: dict) -> dict:
    from ..routers.runs import make_initial
    b = make_initial(int(a["doe"]), InitialDesignIn(seed=int(a.get("seed") or 0)), db=ctx.db, user=ctx.user)
    return {"created_round": b.seq, "runs": b.runs_total, "ui_action": {"type": "navigate", "path": f"/projects/{a['doe']}/step/1"}}


def _result_rows(cfg: ProjectConfig, rows: list) -> list[dict]:
    if not rows:
        raise ToolError("입력할 결과가 없습니다.")
    out = []
    for r in rows:
        if not isinstance(r, dict) or not r.get("run"):
            raise ToolError("각 행에 run(런 ID, 예: 1차-03)이 필요합니다.")
        vals = {_response_key(cfg, k): (None if v in (None, "") else _num(v)) for k, v in (r.get("values") or {}).items()}
        row: dict = {"run_code": str(r["run"])}
        if vals:
            row["values"] = vals
        if r.get("note") not in (None, ""):
            row["deviation_note"] = str(r["note"])
        if r.get("actual_conditions"):
            row["actual"] = _conditions(cfg, r["actual_conditions"], need_all=False)
        out.append(row)
    return out


def p_enter_results(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    from ..routers.runs import save_results
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "runner", "결과 입력")
    cfg = project_config(p)
    rows = _result_rows(cfg, a.get("rows") or [])
    try:
        dry = save_results(p.id, ResultsIn.model_validate({"rows": rows}), dry_run=True, db=ctx.db, user=ctx.user)
    except HTTPException as e:
        raise ToolError(_http_message(e))
    lines = [f"{c['run']}: " + ", ".join(f"{x['field']} {x['before'] if x['before'] not in (None, '') else '(빈 칸)'} → {x['after']}" for x in c["changes"])
             for c in dry["changes"]]
    warns = [f"⚠ {k}: {'; '.join(v)}" for k, v in dry["warnings"].items()]
    if not lines:
        raise ToolError("바뀌는 값이 없습니다 (이미 같은 값이 들어 있습니다).")
    return {"doe": p.id, "rows": rows}, {"title": f"'{p.name}' 결과 {len(lines)}건 저장", "lines": lines + warns}


def x_enter_results(ctx: ToolContext, a: dict) -> dict:
    from ..routers.runs import save_results
    res = save_results(int(a["doe"]), ResultsIn.model_validate({"rows": a["rows"]}), dry_run=False, db=ctx.db, user=ctx.user)
    done = [r["code"] for r in res["runs"] if r["status"] == "done"]
    return {"saved_rows": res["saved"], "now_done": done, "warnings": res["warnings"], "data_changed": True}


def p_import(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    from ..routers.runs import import_existing
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "editor", "기존 데이터 가져오기")
    cfg = project_config(p)
    rows = []
    for r in a.get("rows") or []:
        rows.append({"x": _conditions(cfg, r.get("conditions") or {}),
                     "values": {_response_key(cfg, k): (None if v in (None, "") else _num(v)) for k, v in (r.get("results") or {}).items()},
                     "note": str(r.get("note") or "")})
    if not rows:
        raise ToolError("가져올 행이 없습니다.")
    try:
        out = import_existing(p.id, ImportIn.model_validate({"rows": rows}), dry_run=True, db=ctx.db, user=ctx.user)
    except HTTPException as e:
        raise ToolError(_http_message(e))
    return {"doe": p.id, "rows": rows}, {
        "title": f"'{p.name}'에 기존 데이터 {out.imported}건 가져오기 (0차)",
        "lines": [f"결과가 있는 행 {out.done}건, 반복한 조건 {out.replicated_conditions}개",
                  *[f"{i + 1}. " + ", ".join(f"{k} {v:g}" for k, v in _named(cfg, r['x']).items() if v is not None) for i, r in enumerate(rows[:10])],
                  *(["… 외 %d건" % (len(rows) - 10)] if len(rows) > 10 else [])]}


def x_import(ctx: ToolContext, a: dict) -> dict:
    from ..routers.runs import import_existing
    out = import_existing(int(a["doe"]), ImportIn.model_validate({"rows": a["rows"]}), dry_run=False, db=ctx.db, user=ctx.user)
    return {"imported": out.imported, "with_results": out.done, "data_changed": True}


def p_confirm_next(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "editor", "다음 실험 확정")
    cfg = project_config(p)
    exps = a.get("experiments")
    if exps:
        props = [{"x": _conditions(cfg, e.get("conditions") or e), "kind": "new", "reason": "AI 도우미로 지정한 조건"} for e in exps]
        rec_meta = {"surrogate": cfg.settings.default_surrogate, "surrogate_version": ""}
    else:
        raw, rec = _proposals(ctx, p, int(_num(a["count"])) if a.get("count") not in (None, "") else None)
        props = [{"x": pr["x"], "kind": pr.get("kind", "new"), "reason": pr.get("reason", "")} for pr in raw]
        rec_meta = {"surrogate": rec["surrogate"], "surrogate_version": rec.get("surrogate_version", "")}
    for pr in props:  # 범위·세팅 정밀도 확인
        for f in cfg.factors:
            v = pr["x"][f.key]
            if not (f.low - 1e-9 <= v <= f.high + 1e-9):
                raise ToolError(f"'{f.name}' {v:g}이(가) 설정 범위({f.low:g}~{f.high:g}) 밖입니다.")
            pr["x"][f.key] = round(round((v - f.low) / f.step) * f.step + f.low, 10)
    lines = [f"{i + 1}. " + ", ".join(f"{k} {v:g}" for k, v in _named(cfg, pr['x']).items() if v is not None)
             + (f" — {REASON_KO.get(pr['reason'], pr['reason'])}" if pr.get("reason") else "") for i, pr in enumerate(props)]
    return {"doe": p.id, "proposals": props, **rec_meta}, {"title": f"'{p.name}' 다음 실험 {len(props)}건 확정", "lines": lines}


def x_confirm_next(ctx: ToolContext, a: dict) -> dict:
    from ..routers.analysis import accept
    b = accept(int(a["doe"]), AcceptProposalIn(proposals=a["proposals"], surrogate=a["surrogate"], surrogate_version=a.get("surrogate_version", ""),
                                               acquisition={"via": "assistant"}, note="AI 도우미로 확정"), db=ctx.db, user=ctx.user)
    return {"round": b.seq, "runs": b.runs_total, "data_changed": True, "ui_action": {"type": "navigate", "path": f"/projects/{a['doe']}/step/1"}}


def p_mark_failed(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    from ..routers.runs import normalize_run_code
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "runner", "실패·실행불가 표시")
    kind = "infeasible" if _norm(a.get("kind") or "") in ("infeasible", "실행불가", "불가", "실행안됨") else "failed"
    reason = str(a.get("reason") or "").strip() or "AI 도우미로 표시"
    code = normalize_run_code(str(a.get("run") or ""))
    if not code:
        raise ToolError("런 ID가 필요합니다 (예: 1차-03).")
    from ..routers.runs import resolve_run_codes
    from ..schemas import ResultRow
    probe = [ResultRow(run_code=code)]
    try:
        resolve_run_codes(ctx.db, p.id, probe)
    except HTTPException as e:
        raise ToolError(_http_message(e))
    return {"doe": p.id, "rows": [{"run_code": code, "status": kind, "fail_reason": reason}]}, {
        "title": f"'{p.name}' {code}을(를) {STATUS_KO[kind]}로 표시", "lines": [f"사유: {reason}", "이 런은 학습에서 빠집니다 (화면에서 되돌리기 가능)."]}


def x_mark_failed(ctx: ToolContext, a: dict) -> dict:
    return x_enter_results(ctx, a)


# ---------------------------------------------------------------- 관리 도구 (멤버·공유·삭제·소유권) — danger: 두 번 확인
ROLE_IN = {"편집자": "editor", "editor": "editor", "실험자": "runner", "runner": "runner", "열람자": "viewer", "viewer": "viewer"}
PERM_IN = {"보기": "view", "view": "view", "보기만": "view", "보기+시뮬레이션": "view_simulate", "view_simulate": "view_simulate", "시뮬레이션": "view_simulate"}
MODE_IN = {"스냅샷": "snapshot", "snapshot": "snapshot", "실시간": "live", "live": "live"}
TARGET_IN = {"사람": "user", "user": "user", "부서": "department", "department": "department",
             "사업부": "business_unit", "business_unit": "business_unit", "전사": "company", "company": "company"}


def _pick(table: dict, v: Any, what: str, default: str | None = None) -> str:
    if v in (None, "") and default is not None:
        return default
    k = _norm(v)
    for key, val in table.items():
        if _norm(key) == k:
            return val
    raise ToolError(f"{what}은(는) {', '.join(sorted(set(k for k in table if not k.isascii())))} 중 하나입니다: {v}")


def t_members_shares(ctx: ToolContext, a: dict) -> dict:
    from ..routers.projects import members
    p = find_doe(ctx, a.get("doe"))
    ms = members(p.id, db=ctx.db, user=ctx.user)
    out: dict = {"doe": p.name, "members": [{"name": m.user.name, "user_key": m.user.user_key, "department": m.user.department,
                                              "role": ROLE_KO.get(m.role, m.role)} for m in ms]}
    if _role(ctx, p) == "owner":
        from ..routers.sharing import list_shares
        out["shares"] = [{"share_id": x.id, "target": x.target_label, "permission": "보기+시뮬레이션" if x.permission == "view_simulate" else "보기",
                          "mode": "스냅샷" if x.mode == "snapshot" else "실시간", "expires_at": x.expires_at, "views": x.view_count}
                         for x in list_shares(p.id, db=ctx.db, user=ctx.user) if not x.revoked_at]
    return out


def p_set_member(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    from sqlalchemy import select
    from ..models import ProjectMember
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "owner", "멤버 관리")
    u = _find_user(ctx, a.get("user"))
    if u.id == p.owner_id:
        raise ToolError("소유자는 이미 모든 권한을 가지고 있습니다.")
    role = _pick(ROLE_IN, a.get("role"), "역할", "runner")
    cur = ctx.db.scalar(select(ProjectMember).where(ProjectMember.project_id == p.id, ProjectMember.user_id == u.id))
    what = f"권한을 {ROLE_KO[cur.role]} → {ROLE_KO[role]}(으)로 바꿉니다" if cur else f"{ROLE_KO[role]}(으)로 추가합니다"
    return {"doe": p.id, "user_id": u.id, "role": role}, {
        "title": f"'{p.name}' 멤버 {_who(u)} — {what}",
        "lines": [{"editor": "편집자: 설정 변경, 다음 실험 확정, 결과 입력", "runner": "실험자: 결과 입력, 못 함 표시, 메모",
                   "viewer": "열람자: 보기만"}[role], "이 사람은 이 DOE의 실험 데이터를 볼 수 있게 됩니다."]}


def x_set_member(ctx: ToolContext, a: dict) -> dict:
    from ..routers.projects import add_member
    from ..schemas import MemberIn
    add_member(int(a["doe"]), MemberIn(user_id=int(a["user_id"]), role=a["role"]), db=ctx.db, user=ctx.user)
    return {"done": True, "data_changed": True}


def p_remove_member(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    from sqlalchemy import select
    from ..models import ProjectMember
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "owner", "멤버 내보내기")
    u = _find_user(ctx, a.get("user"))
    if ctx.db.scalar(select(ProjectMember).where(ProjectMember.project_id == p.id, ProjectMember.user_id == u.id)) is None:
        raise ToolError(f"{_who(u)}은(는) 이 DOE의 멤버가 아닙니다.")
    return {"doe": p.id, "user_id": u.id}, {"title": f"'{p.name}'에서 {_who(u)} 내보내기",
                                             "lines": ["이 사람은 더 이상 이 DOE를 볼 수 없습니다 (공유받은 예측 페이지는 공유 설정에 따름)."]}


def x_remove_member(ctx: ToolContext, a: dict) -> dict:
    from ..routers.projects import remove_member
    remove_member(int(a["doe"]), int(a["user_id"]), db=ctx.db, user=ctx.user)
    return {"done": True, "data_changed": True}


def p_transfer(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "owner", "소유권 이전")
    u = _find_user(ctx, a.get("user"))
    if u.id == p.owner_id:
        raise ToolError("이미 이 사람이 소유자입니다.")
    return {"doe": p.id, "user_id": u.id}, {"title": f"'{p.name}' 소유권을 {_who(u)}에게 넘기기",
                                             "lines": ["나는 편집자가 되고, 멤버·공유 관리와 삭제 권한을 잃습니다.",
                                                       "되돌리려면 새 소유자가 다시 넘겨 줘야 합니다."]}


def x_transfer(ctx: ToolContext, a: dict) -> dict:
    from ..routers.projects import transfer
    from ..schemas import TransferIn
    d = transfer(int(a["doe"]), TransferIn(new_owner_id=int(a["user_id"])), db=ctx.db, user=ctx.user)
    return {"done": True, "new_owner": d.owner.name, "data_changed": True}


def p_share(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    from datetime import datetime, timedelta, timezone
    from ..routers.meta import org_units
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "owner", "예측 공유")
    tt = _pick(TARGET_IN, a.get("target_type"), "공유 대상 종류", "user")
    target_id, label = None, "전사"
    if tt == "user":
        u = _find_user(ctx, a.get("target"))
        target_id, label = u.id, _who(u)
    elif tt in ("department", "business_unit"):
        q = str(a.get("target") or "").strip()
        units = [o for o in org_units(q=q, db=ctx.db, user=ctx.user) if o.type == tt]
        exact = [o for o in units if o.name.split(" (")[0] == q]
        units = exact or units
        if not units:
            raise ToolError(f"'{q}' {'부서' if tt == 'department' else '사업부'}를 찾지 못했습니다.")
        if len(units) > 1:
            raise ToolError("여러 곳이 맞습니다: " + ", ".join(o.name for o in units[:10]))
        target_id, label = units[0].id, units[0].name
    perm = _pick(PERM_IN, a.get("permission"), "권한", "view_simulate")
    mode = _pick(MODE_IN, a.get("mode"), "방식", "snapshot")
    days = a.get("expires_days")
    expires = (datetime.now(timezone.utc) + timedelta(days=int(_num(days)))).isoformat() if days not in (None, "") else None
    raw = bool(a.get("include_raw_data"))
    body = {"target_type": tt, "target_id": target_id, "permission": perm, "mode": mode, "include_raw": raw, "expires_at": expires}
    lines = [f"대상: {label}", f"권한: {'보기 + 조건 시뮬레이션' if perm == 'view_simulate' else '보기만'}",
             f"방식: {'스냅샷 — 지금 결과로 고정' if mode == 'snapshot' else '실시간 — 항상 최신 결과'}",
             f"만료: {str(expires)[:10] if expires else '없음 (철회할 때까지)'}",
             "원본 실험 데이터도 보여 줍니다 ⚠" if raw else "원본 실험 데이터는 보여 주지 않습니다 (예측 결과만)"]
    if tt in ("company", "business_unit"):
        lines.append("⚠ 많은 사람이 볼 수 있게 됩니다.")
    return {"doe": p.id, "body": body}, {"title": f"'{p.name}' 예측 페이지를 {label}에 공유", "lines": lines}


def x_share(ctx: ToolContext, a: dict) -> dict:
    from ..routers.sharing import create_share
    from ..schemas import ShareCreate
    out = create_share(int(a["doe"]), ShareCreate.model_validate(a["body"]), db=ctx.db, user=ctx.user)
    return {"shared_with": out.target_label, "link": f"/shared/{out.token}", "data_changed": True}


def p_revoke_share(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    from ..routers.sharing import list_shares
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "owner", "공유 철회")
    ref = str(a.get("share") or "").strip()
    live = [x for x in list_shares(p.id, db=ctx.db, user=ctx.user) if not x.revoked_at]
    cand = [x for x in live if str(x.id) == ref] or [x for x in live if _norm(ref) and _norm(ref) in _norm(x.target_label)]
    if not cand:
        raise ToolError("철회할 공유를 찾지 못했습니다. 지금 공유: " + (", ".join(f"#{x.id} {x.target_label}" for x in live) or "없음"))
    if len(cand) > 1:
        raise ToolError("여러 공유가 맞습니다. 번호로 알려 주세요: " + ", ".join(f"#{x.id} {x.target_label}" for x in cand))
    x = cand[0]
    return {"doe": p.id, "share_id": x.id}, {"title": f"'{p.name}' 공유 철회: {x.target_label}",
                                              "lines": ["이 공유 링크로는 즉시 볼 수 없게 됩니다."]}


def x_revoke_share(ctx: ToolContext, a: dict) -> dict:
    from ..routers.sharing import revoke_share
    revoke_share(int(a["doe"]), int(a["share_id"]), db=ctx.db, user=ctx.user)
    return {"done": True, "data_changed": True}


def p_delete_run(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    from ..routers.runs import normalize_run_code, resolve_run_codes
    from ..schemas import ResultRow
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "editor", "런 삭제")
    code = normalize_run_code(str(a.get("run") or ""))
    probe = [ResultRow(run_code=code)]
    try:
        resolve_run_codes(ctx.db, p.id, probe)
    except HTTPException as e:
        raise ToolError(_http_message(e))
    return {"doe": p.id, "run_id": probe[0].run_id, "code": code}, {
        "title": f"'{p.name}' 런 {code} 삭제", "lines": ["표와 학습에서 빠집니다. 입력한 결과도 학습에 쓰지 않습니다.", "기록은 남아 관리자가 복구할 수 있습니다."]}


def x_delete_run(ctx: ToolContext, a: dict) -> dict:
    from ..routers.runs import delete_run
    delete_run(int(a["doe"]), int(a["run_id"]), db=ctx.db, user=ctx.user)
    return {"deleted": a.get("code"), "data_changed": True}


def p_delete_doe(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    from ..config import get_settings
    from ..routers.projects import get_project, members
    p = find_doe(ctx, a.get("doe"))
    _need(ctx, p, "owner", "DOE 삭제")
    d = get_project(p.id, db=ctx.db, user=ctx.user)
    n_mem = len(members(p.id, db=ctx.db, user=ctx.user)) - 1
    return {"doe": p.id, "name": p.name}, {
        "title": f"DOE '{p.name}' 삭제",
        "lines": [f"실험 {d.runs_total}회(결과 {d.runs_done}건), 멤버 {n_mem}명, 공유 {d.active_shares}건",
                  "멤버와 공유받은 사람 모두 더 이상 볼 수 없습니다.",
                  f"휴지통에 {get_settings().trash_retention_days}일 동안 보관되며, 그동안은 되살릴 수 있습니다 (restore_doe)."]}


def x_delete_doe(ctx: ToolContext, a: dict) -> dict:
    from ..routers.projects import soft_delete
    r = soft_delete(int(a["doe"]), db=ctx.db, user=ctx.user)
    return {"deleted": a.get("name"), "restorable_until": str(r["restorable_until"])[:10], "data_changed": True,
            "ui_action": {"type": "navigate", "path": "/"}}


def p_restore(ctx: ToolContext, a: dict) -> tuple[dict, dict]:
    p = find_doe(ctx, a.get("doe"), trash=True)
    if p.deleted_at is None:
        raise ToolError("휴지통에 있는 DOE가 아닙니다.")
    return {"doe": p.id, "name": p.name}, {"title": f"휴지통의 DOE '{p.name}' 되살리기", "lines": ["멤버와 공유 설정도 함께 돌아옵니다."]}


def x_restore(ctx: ToolContext, a: dict) -> dict:
    from ..routers.projects import restore
    restore(int(a["doe"]), db=ctx.db, user=ctx.user)
    return {"restored": a.get("name"), "data_changed": True, "ui_action": {"type": "navigate", "path": f"/projects/{a['doe']}"}}


# ---------------------------------------------------------------- 도구 목록
S = "string"
DOE = {"type": S, "description": "DOE 이름(일부도 됨) 또는 번호. 생략하면 사용자가 지금 보고 있는 DOE"}
COND = {"type": "object", "description": "인자 이름 → 값. 예: {\"RF 파워\": 530, \"챔버 압력\": 42}", "additionalProperties": {"type": "number"}}

TOOLS: list[Tool] = [
    Tool("list_does", "DOE 목록", "내가 볼 수 있는 DOE 목록과 진행 상황·다음에 할 일. query로 이름 검색.",
         {"type": "object", "properties": {"query": {"type": S, "description": "이름·설명 검색어 (선택)"}}}, run=t_list_does),
    Tool("get_doe", "DOE 정보", "DOE의 인자(범위)·응답(목표·규격)·진행 상황·다음에 할 일.",
         {"type": "object", "properties": {"doe": DOE}}, run=t_get_doe),
    Tool("list_runs", "실험 목록", "런 ID(예: 1차-03)별 조건·결과·상태. only_open=true면 결과가 남은 실험만.",
         {"type": "object", "properties": {"doe": DOE, "only_open": {"type": "boolean"}, "round": {"type": "integer", "description": "차수 (0=기존 데이터)"},
                                           "limit": {"type": "integer", "description": "최대 행 수 (기본 60)"}}}, run=t_list_runs),
    Tool("get_recommendation", "추천 레시피", "지금까지의 결과로 학습한 추천 레시피, 목표 달성 점수, 응답별 예상값·규격 만족 확률, 다른 선택지.",
         {"type": "object", "properties": {"doe": DOE}}, run=t_get_recommendation),
    Tool("predict", "조건 예측", "주어진 조건에서 모든 응답의 예상값·산포·규격 만족 확률과 목표 달성 점수를 계산한다.",
         {"type": "object", "properties": {"doe": DOE, "conditions": COND}, "required": ["conditions"]}, run=t_predict),
    Tool("propose_next_experiments", "다음 실험 제안 보기", "다음에 할 실험 조건과 이유를 제안한다 (저장하지 않음).",
         {"type": "object", "properties": {"doe": DOE, "count": {"type": "integer", "description": "제안 개수 (생략 시 DOE 설정값)"}}}, run=t_propose_next),
    Tool("search_manual", "사용법 찾기", "사용 매뉴얼에서 화면 사용법·용어 설명을 찾는다. 사용법 질문에 먼저 쓴다.",
         {"type": "object", "properties": {"query": {"type": S}}, "required": ["query"]}, run=t_search_manual),
    Tool("open_screen", "화면 열기", "사용자 화면을 바꾼다. screen: home(첫 화면), new(새 DOE), settings(DOE 설정), data(① 실험 데이터 입력), results(② 능동학습 결과), manual(사용 매뉴얼).",
         {"type": "object", "properties": {"screen": {"type": S, "enum": ["home", "new", "settings", "data", "results", "manual"]}, "doe": DOE,
                                           "section": {"type": S, "description": "manual일 때 절 이름 (선택)"}}, "required": ["screen"]}, run=t_open_screen),
    Tool("create_doe", "DOE 만들기", "새 DOE를 만든다. goal은 최대/최소/목표값. 목표값이면 target 필요. 규격은 lsl/usl. 사람이 확인한 뒤 실행된다.",
         {"type": "object", "properties": {
             "name": {"type": S}, "description": {"type": S},
             "factors": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": S}, "low": {"type": "number"}, "high": {"type": "number"},
                                                                               "step": {"type": "number", "description": "세팅 정밀도 (선택)"}, "unit": {"type": S}},
                                                     "required": ["name", "low", "high"]}},
             "responses": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": S}, "goal": {"type": S, "enum": ["최대", "최소", "목표값"]},
                                                                                 "target": {"type": "number"}, "lsl": {"type": "number"}, "usl": {"type": "number"},
                                                                                 "unit": {"type": S}, "weight": {"type": "number"}},
                                                       "required": ["name", "goal"]}}},
          "required": ["name", "factors", "responses"]}, writes=True, prepare=p_create_doe, execute=x_create_doe),
    Tool("start_first_design", "첫 실험 계획", "실험이 없는 DOE에 첫 실험 조건(반복 포함)을 만든다. 사람이 확인한 뒤 실행된다.",
         {"type": "object", "properties": {"doe": DOE}}, writes=True, prepare=p_first_design, execute=x_first_design),
    Tool("enter_results", "결과 입력", "런 ID별 측정 결과를 저장한다. values는 {응답 이름: 값}. 실제로 다르게 세팅했으면 actual_conditions. 사람이 확인한 뒤 실행된다.",
         {"type": "object", "properties": {"doe": DOE, "rows": {"type": "array", "items": {"type": "object", "properties": {
             "run": {"type": S, "description": "런 ID (예: 1차-03)"}, "values": {"type": "object", "additionalProperties": {"type": "number"}},
             "note": {"type": S}, "actual_conditions": COND}, "required": ["run"]}}}, "required": ["rows"]},
         writes=True, prepare=p_enter_results, execute=x_enter_results),
    Tool("import_existing_data", "기존 데이터 가져오기", "이미 해 둔 실험(조건 + 결과)을 0차로 가져온다. 사람이 확인한 뒤 실행된다.",
         {"type": "object", "properties": {"doe": DOE, "rows": {"type": "array", "items": {"type": "object", "properties": {
             "conditions": COND, "results": {"type": "object", "additionalProperties": {"type": "number"}}, "note": {"type": S}},
             "required": ["conditions"]}}}, "required": ["rows"]}, writes=True, prepare=p_import, execute=x_import),
    Tool("confirm_next_experiments", "다음 실험 확정", "다음 차수 실험을 확정한다. experiments를 주면 그 조건으로, 생략하면 앱의 제안으로. 사람이 확인한 뒤 실행된다.",
         {"type": "object", "properties": {"doe": DOE, "count": {"type": "integer"},
                                           "experiments": {"type": "array", "items": {"type": "object", "properties": {"conditions": COND}}}}},
         writes=True, prepare=p_confirm_next, execute=x_confirm_next),
    Tool("mark_run_not_done", "실패·실행불가 표시", "실험을 못 한 런을 실패(했지만 결과 없음) 또는 실행불가(조건을 맞출 수 없음)로 표시한다. 사람이 확인한 뒤 실행된다.",
         {"type": "object", "properties": {"doe": DOE, "run": {"type": S}, "kind": {"type": S, "enum": ["실패", "실행불가"]}, "reason": {"type": S}},
          "required": ["run"]}, writes=True, prepare=p_mark_failed, execute=x_mark_failed),
    Tool("list_members_and_shares", "멤버·공유 보기", "DOE 멤버와 역할, (소유자라면) 지금 공유 중인 예측 페이지 목록.",
         {"type": "object", "properties": {"doe": DOE}}, run=t_members_shares),
    Tool("restore_doe", "삭제한 DOE 되살리기", "휴지통의 DOE를 되살린다 (소유자). 사람이 확인한 뒤 실행된다.",
         {"type": "object", "properties": {"doe": {"type": S, "description": "휴지통에 있는 DOE 이름 또는 번호"}}, "required": ["doe"]},
         writes=True, prepare=p_restore, execute=x_restore),
    Tool("set_member", "멤버 추가·권한 변경", "사람을 멤버로 추가하거나 역할을 바꾼다 (소유자). role: 편집자/실험자/열람자. 되돌리기 어려워 사용자가 두 번 확인한다.",
         {"type": "object", "properties": {"doe": DOE, "user": {"type": S, "description": "이름 또는 사번"},
                                           "role": {"type": S, "enum": ["편집자", "실험자", "열람자"]}}, "required": ["user", "role"]},
         writes=True, danger=True, prepare=p_set_member, execute=x_set_member),
    Tool("remove_member", "멤버 내보내기", "멤버를 DOE에서 뺀다 (소유자). 사용자가 두 번 확인한다.",
         {"type": "object", "properties": {"doe": DOE, "user": {"type": S, "description": "이름 또는 사번"}}, "required": ["user"]},
         writes=True, danger=True, prepare=p_remove_member, execute=x_remove_member),
    Tool("share_prediction", "예측 페이지 공유", "추천 레시피·지도 페이지를 사람·부서·사업부·전사에 공유한다 (소유자). 사용자가 두 번 확인한다.",
         {"type": "object", "properties": {"doe": DOE, "target_type": {"type": S, "enum": ["사람", "부서", "사업부", "전사"]},
                                           "target": {"type": S, "description": "사람 이름·사번 또는 부서·사업부 이름 (전사면 생략)"},
                                           "permission": {"type": S, "enum": ["보기", "보기+시뮬레이션"]}, "mode": {"type": S, "enum": ["스냅샷", "실시간"]},
                                           "expires_days": {"type": "integer", "description": "며칠 뒤 만료 (선택)"},
                                           "include_raw_data": {"type": "boolean", "description": "원본 실험 데이터도 보여 줄지 (기본 아니오)"}},
          "required": ["target_type"]}, writes=True, danger=True, prepare=p_share, execute=x_share),
    Tool("revoke_share", "공유 철회", "공유를 즉시 끊는다 (소유자). share는 공유 번호 또는 대상 이름. 사용자가 두 번 확인한다.",
         {"type": "object", "properties": {"doe": DOE, "share": {"type": S}}, "required": ["share"]},
         writes=True, danger=True, prepare=p_revoke_share, execute=x_revoke_share),
    Tool("transfer_ownership", "소유권 넘기기", "DOE 소유권을 다른 사람에게 넘긴다 (소유자). 사용자가 두 번 확인한다.",
         {"type": "object", "properties": {"doe": DOE, "user": {"type": S, "description": "새 소유자 이름 또는 사번"}}, "required": ["user"]},
         writes=True, danger=True, prepare=p_transfer, execute=x_transfer),
    Tool("delete_run", "런 삭제", "런을 표와 학습에서 뺀다 (편집자). 사용자가 두 번 확인한다.",
         {"type": "object", "properties": {"doe": DOE, "run": {"type": S, "description": "런 ID (예: 1차-03)"}}, "required": ["run"]},
         writes=True, danger=True, prepare=p_delete_run, execute=x_delete_run),
    Tool("delete_doe", "DOE 삭제", "DOE를 휴지통으로 옮긴다 (소유자). 보관 기간 동안 되살릴 수 있다. 사용자가 두 번 확인한다.",
         {"type": "object", "properties": {"doe": DOE}}, writes=True, danger=True, prepare=p_delete_doe, execute=x_delete_doe),
]
BY_NAME = {t.name: t for t in TOOLS}


def _clean(v: Any) -> Any:
    """JSON으로 바꿀 수 있게 (numpy 수 등)"""
    return json.loads(json.dumps(v, ensure_ascii=False, default=lambda o: float(o) if hasattr(o, "__float__") else str(o)))


def run_tool(ctx: ToolContext, name: str, args: dict | None, confirmed: bool = False, danger_ack: bool = False) -> dict:
    """도구 실행 결과: {status: ok|needs_confirmation|needs_reconfirmation|error, ...}.
    쓰기 도구는 confirmed=True일 때만, 위험(danger) 도구는 danger_ack=True(두 번째 확인)까지 있어야 실행한다."""
    t = BY_NAME.get(name)
    if t is None:
        return {"status": "error", "message": f"알 수 없는 도구입니다: {name}"}
    a = dict(args or {})
    a.pop("confirm", None)
    a.pop("confirm_again", None)
    try:
        if not t.writes:
            return {"status": "ok", "data": _clean(t.run(ctx, a))}  # type: ignore[misc]
        prepared, preview = t.prepare(ctx, a)  # type: ignore[misc]
        if t.danger:
            preview = {**preview, "danger": True, "warning": "되돌리기 어려운 작업입니다. 정말 실행할지 한 번 더 확인합니다."}
        if not confirmed:
            return {"status": "needs_confirmation", "tool": name, "args": _clean(prepared), "preview": preview}
        if t.danger and not danger_ack:
            return {"status": "needs_reconfirmation", "tool": name, "args": _clean(prepared), "preview": preview}
        return {"status": "ok", "data": _clean(t.execute(ctx, prepared)), "preview": preview}  # type: ignore[misc]
    except ToolError as e:
        ctx.db.rollback()
        return {"status": "error", "message": str(e)}
    except HTTPException as e:
        ctx.db.rollback()
        return {"status": "error", "message": _http_message(e)}
    except ValidationError as e:
        ctx.db.rollback()
        return {"status": "error", "message": "; ".join(str(x.get("msg", "")).replace("Value error, ", "") for x in e.errors()[:5])}
    except (KeyError, TypeError, ValueError) as e:
        ctx.db.rollback()
        return {"status": "error", "message": f"요청 형식이 맞지 않습니다: {e}"}


def is_danger(name: str) -> bool:
    t = BY_NAME.get(name)
    return bool(t and t.danger)


def execute_prepared(ctx: ToolContext, name: str, prepared: dict, danger_ack: bool = False) -> dict:
    """사람이 확인 카드를 승인한 뒤: prepare에서 정리한 인자 그대로 실행한다 (LLM이 다시 끼어들 수 없음)."""
    t = BY_NAME.get(name)
    if t is None or not t.writes:
        return {"status": "error", "message": "실행할 수 없는 작업입니다."}
    if t.danger and not danger_ack:
        return {"status": "error", "message": "되돌리기 어려운 작업이라 한 번 더 확인이 필요합니다."}
    try:
        return {"status": "ok", "data": _clean(t.execute(ctx, prepared))}  # type: ignore[misc]
    except ToolError as e:
        ctx.db.rollback()
        return {"status": "error", "message": str(e)}
    except HTTPException as e:
        ctx.db.rollback()
        return {"status": "error", "message": _http_message(e)}
    except ValidationError as e:
        ctx.db.rollback()
        return {"status": "error", "message": "; ".join(str(x.get("msg", "")) for x in e.errors()[:5])}
