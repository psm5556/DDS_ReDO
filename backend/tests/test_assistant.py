"""AI 도우미(DDS Conversa) · MCP · 개인 토큰 · LLM 연결 · API 설명서 테스트.

실제 LLM 대신 정해진 답을 돌려주는 가짜 LLM을 쓴다 (사내 LLM 없이도 전체 흐름을 검증).
"""
import json

import httpx
import pytest
from fastapi.routing import APIRoute

from tests.conftest import H

from app.api_docs import DOCS
from app.assistant import agent
from app.assistant.llm import LLMClient, LLMReply, ToolCall
from app.assistant.tools import BY_NAME, TOOLS, ToolContext, run_tool
from app.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import AuditLog, User


def _project(c, name):
    r = c.post("/api/projects", json={"name": name, "config": {
        "factors": [{"key": "temp", "name": "온도", "unit": "°C", "low": 100, "high": 200, "step": 1},
                    {"key": "time", "name": "시간", "unit": "min", "low": 10, "high": 60, "step": 5}],
        "responses": [{"key": "yield", "name": "수율", "unit": "%", "goal": "maximize", "input_min": 0, "input_max": 100}],
        "settings": {"batch_size": 3, "initial_points": 6, "replicate_fraction": 0.34, "replicates_per_point": 2}}})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert c.post(f"/api/projects/{pid}/design/initial", json={"seed": 1}).status_code == 200
    return pid


def _ctx(user_key, pid=None):
    db = SessionLocal()
    from sqlalchemy import select
    u = db.scalar(select(User).where(User.user_key == user_key))
    return ToolContext(db=db, user=u, project_id=pid)


class FakeLLM:
    """정해진 순서로 답하는 가짜 LLM. 받은 메시지를 기록한다."""
    def __init__(self, replies):
        self.replies = list(replies)
        self.seen = []

    def chat(self, messages, tools):
        self.seen.append(messages)
        return self.replies.pop(0) if self.replies else LLMReply("끝")

    def ping(self):
        return True, "연결됨"


@pytest.fixture
def llm_on(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "llm_base_url", "http://fake-ollama:11434")
    monkeypatch.setattr(s, "llm_model", "qwen-test")
    fake = FakeLLM([])
    monkeypatch.setattr(agent, "make_client", lambda s=None: fake)
    return fake


@pytest.fixture
def mcp_on(monkeypatch):
    monkeypatch.setattr(get_settings(), "mcp_enabled", True)


def _say(c, text, **kw):
    """대화 한 번. 응답의 마지막 메시지(도우미 답)를 돌려준다."""
    r = c.post("/api/assistant/chat", json={"message": text, **kw})
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------- 1단계: API 설명서·런 ID·미리 보기
def test_every_api_has_korean_summary_and_stable_operation_id(seeded):
    names = {r.name for r in app.routes if isinstance(r, APIRoute) and r.path.startswith("/api")}
    assert names - set(DOCS) == set(), "api_docs.DOCS에 설명이 빠진 API"
    spec = app.openapi()
    ops = [o for p in spec["paths"].values() for o in p.values()]
    assert all(o["operationId"] in DOCS for o in ops)
    assert all(any("가" <= ch <= "힣" for ch in o["summary"]) for o in ops)
    assert spec["paths"]["/api/projects/{project_id}/results"]["post"]["operationId"] == "save_results"


def test_results_by_run_code_and_dry_run(client_for):
    c = client_for("E1001")
    pid = _project(c, "런 ID 결과 저장")
    runs = c.get(f"/api/projects/{pid}/runs").json()
    code = runs[0]["code"]
    # 미리 보기: 저장하지 않는다
    r = c.post(f"/api/projects/{pid}/results?dry_run=true", json={"rows": [{"run_code": code.replace("-0", "-"), "values": {"yield": 61}}]})
    assert r.status_code == 200, r.text
    assert r.json()["dry_run"] and r.json()["changes"][0]["changes"][0]["after"] == 61
    assert c.get(f"/api/projects/{pid}/runs").json()[0]["values"]["yield"] is None
    # 실제 저장 (예전 형식 B1-01도 인식)
    r = c.post(f"/api/projects/{pid}/results", json={"rows": [{"run_code": "B" + code.replace("차", ""), "values": {"yield": 62}}]})
    assert r.status_code == 200, r.text
    assert c.get(f"/api/projects/{pid}/runs").json()[0]["values"]["yield"] == 62
    assert c.post(f"/api/projects/{pid}/results", json={"rows": [{"run_code": "9차-99", "values": {"yield": 1}}]}).status_code == 404
    assert c.post(f"/api/projects/{pid}/results", json={"rows": [{"values": {"yield": 1}}]}).status_code == 422


def test_import_dry_run_saves_nothing(client_for):
    c = client_for("E1001")
    pid = _project(c, "가져오기 미리 보기")
    before = len(c.get(f"/api/projects/{pid}/runs").json())
    r = c.post(f"/api/projects/{pid}/import?dry_run=true", json={"rows": [{"x": {"temp": 150, "time": 30}, "values": {"yield": 70}}]})
    assert r.status_code == 200 and r.json()["dry_run"] and r.json()["imported"] == 1
    assert len(c.get(f"/api/projects/{pid}/runs").json()) == before


# ---------------------------------------------------------------- 도구
def test_tools_schemas_are_valid():
    assert len(TOOLS) == len(BY_NAME) == 23
    for t in TOOLS:
        sch = t.schema()
        assert sch["type"] == "function" and sch["function"]["parameters"]["type"] == "object"
        assert t.description and (t.run if not t.writes else (t.prepare and t.execute))


def test_read_tools_by_human_names(client_for):
    client_for("E1001")
    ctx = _ctx("E1001")
    r = run_tool(ctx, "list_does", {"query": "CMP"})
    assert r["status"] == "ok" and r["data"]["count"] >= 1
    d = run_tool(ctx, "get_doe", {"doe": "CMP 슬러리"})
    assert d["status"] == "ok", d
    assert [f["name"] for f in d["data"]["factors"]] == ["연마제 농도", "산화제(H₂O₂)", "pH"]
    runs = run_tool(ctx, "list_runs", {"doe": "CMP", "limit": 3})["data"]
    assert runs["shown"] == 3 and runs["runs"][0]["run"].endswith("-01")
    rec = run_tool(ctx, "get_recommendation", {"doe": "CMP"})
    assert rec["status"] == "ok" and 0 <= rec["data"]["goal_score"] <= 100 and len(rec["data"]["responses"]) == 3
    pr = run_tool(ctx, "predict", {"doe": "CMP", "conditions": {"연마제 농도": 9, "산화제": 2, "pH": 2.5}})
    assert pr["status"] == "ok" and len(pr["data"]["responses"]) == 3
    bad = run_tool(ctx, "predict", {"doe": "CMP", "conditions": {"온도": 1}})
    assert bad["status"] == "error" and "인자가 아닙니다" in bad["message"]
    m = run_tool(ctx, "search_manual", {"query": "엑셀 붙여넣기"})
    assert m["data"]["results"] and m["data"]["results"][0]["manual_link"].startswith("/manual/index.html#")
    nav = run_tool(ctx, "open_screen", {"screen": "results", "doe": "CMP"})
    assert nav["data"]["ui_action"]["path"].endswith("/step/2")
    ctx.db.close()


def test_tools_respect_permissions(client_for):
    client_for("E1001")
    other = _ctx("E2001")  # 다른 사업부: 데모 DOE를 볼 수 없다
    r = run_tool(other, "get_doe", {"doe": "CMP"})
    assert r["status"] == "error"
    runner = _ctx("E1002")  # 실험자: 다음 실험 확정 불가
    r = run_tool(runner, "confirm_next_experiments", {"doe": "Poly-Si"})
    assert r["status"] == "error" and "편집자" in r["message"]
    other.db.close(); runner.db.close()


def test_write_tool_previews_then_executes_only_when_confirmed(client_for):
    c = client_for("E1001")
    pid = _project(c, "도구 쓰기")
    code = c.get(f"/api/projects/{pid}/runs").json()[0]["code"]
    ctx = _ctx("E1001", pid)
    r = run_tool(ctx, "enter_results", {"rows": [{"run": code, "values": {"수율": 77}}], "confirm": True})  # LLM이 confirm을 넣어도
    assert r["status"] == "needs_confirmation" and "77" in " ".join(r["preview"]["lines"])
    assert c.get(f"/api/projects/{pid}/runs").json()[0]["values"]["yield"] is None
    r = run_tool(ctx, "enter_results", {"rows": [{"run": code, "values": {"수율": 77}}]}, confirmed=True)
    assert r["status"] == "ok", r
    assert c.get(f"/api/projects/{pid}/runs").json()[0]["values"]["yield"] == 77
    ctx.db.close()


def test_danger_tool_needs_second_confirmation(client_for):
    c = client_for("E1001")
    pid = _project(c, "위험 작업 재확인")
    code = c.get(f"/api/projects/{pid}/runs").json()[0]["code"]
    ctx = _ctx("E1001", pid)
    r = run_tool(ctx, "delete_run", {"run": code})
    assert r["status"] == "needs_confirmation" and r["preview"]["danger"]
    n = len(c.get(f"/api/projects/{pid}/runs").json())
    r = run_tool(ctx, "delete_run", {"run": code}, confirmed=True)
    assert r["status"] == "needs_reconfirmation"
    assert len(c.get(f"/api/projects/{pid}/runs").json()) == n
    r = run_tool(ctx, "delete_run", {"run": code}, confirmed=True, danger_ack=True)
    assert r["status"] == "ok"
    assert len(c.get(f"/api/projects/{pid}/runs").json()) == n - 1
    ctx.db.close()


def test_member_and_share_tools(client_for):
    c = client_for("E1001")
    pid = _project(c, "멤버 공유 도구")
    ctx = _ctx("E1001", pid)
    r = run_tool(ctx, "set_member", {"user": "이도윤", "role": "실험자"}, confirmed=True, danger_ack=True)
    assert r["status"] == "ok", r
    ms = run_tool(ctx, "list_members_and_shares", {})["data"]["members"]
    assert {"name": "이도윤", "role": "실험자"}.items() <= next(m for m in ms if m["name"] == "이도윤").items()
    # 결과가 있어야 공유할 수 있다
    rows = c.get(f"/api/projects/{pid}/runs").json()
    c.post(f"/api/projects/{pid}/results", json={"rows": [{"run_id": x["id"], "values": {"yield": 50 + i}} for i, x in enumerate(rows)]})
    pv = run_tool(ctx, "share_prediction", {"target_type": "부서", "target": "증착공정개발팀"})
    assert pv["status"] == "needs_confirmation" and "증착공정개발팀" in pv["preview"]["title"]
    r = run_tool(ctx, "share_prediction", {"target_type": "부서", "target": "증착공정개발팀"}, confirmed=True, danger_ack=True)
    assert r["status"] == "ok", r
    assert len(run_tool(ctx, "list_members_and_shares", {})["data"]["shares"]) == 1
    r = run_tool(ctx, "revoke_share", {"share": "증착"}, confirmed=True, danger_ack=True)
    assert r["status"] == "ok", r
    r = run_tool(ctx, "remove_member", {"user": "이도윤"}, confirmed=True, danger_ack=True)
    assert r["status"] == "ok"
    ctx.db.close()


def test_delete_and_restore_doe(client_for):
    c = client_for("E1001")
    pid = _project(c, "삭제 후 되살리기 도구")
    ctx = _ctx("E1001")
    r = run_tool(ctx, "delete_doe", {"doe": "삭제 후 되살리기"}, confirmed=True, danger_ack=True)
    assert r["status"] == "ok", r
    assert c.get(f"/api/projects/{pid}").json()["deleted_at"] is not None
    assert all(x["id"] != pid for x in c.get("/api/projects?scope=mine").json())
    r = run_tool(ctx, "restore_doe", {"doe": "삭제 후 되살리기"}, confirmed=True)
    assert r["status"] == "ok", r
    assert c.get(f"/api/projects/{pid}").json()["deleted_at"] is None
    ctx.db.close()


def test_create_doe_and_first_design_tools(client_for):
    c = client_for("E1001")
    ctx = _ctx("E1001")
    args = {"name": "도구로 만든 DOE", "factors": [{"name": "전류", "low": 1, "high": 5, "unit": "A"}],
            "responses": [{"name": "두께", "goal": "목표값", "target": 10, "lsl": 9, "usl": 11}]}
    pv = run_tool(ctx, "create_doe", args)
    assert pv["status"] == "needs_confirmation" and "전류" in pv["preview"]["lines"][0]
    r = run_tool(ctx, "create_doe", args, confirmed=True)
    assert r["status"] == "ok", r
    pid = r["data"]["created"]["id"]
    r = run_tool(ctx, "start_first_design", {"doe": pid}, confirmed=True)
    assert r["status"] == "ok" and r["data"]["runs"] > 0
    assert run_tool(ctx, "start_first_design", {"doe": pid})["status"] == "error"  # 이미 실험이 있음
    ctx.db.close()


# ---------------------------------------------------------------- 대화 (가짜 LLM)
def test_status_and_chat_disabled_without_llm(client_for):
    c = client_for("E1001")
    st = c.get("/api/assistant/status").json()
    assert st["enabled"] is False and st["title"] == "DDS Conversa" and "REDO_LLM_BASE_URL" in st["message"]
    assert c.post("/api/assistant/chat", json={"message": "안녕"}).status_code == 503


def test_chat_read_tool_then_answer(client_for, llm_on):
    c = client_for("E1001")
    pid = _project(c, "대화 읽기")
    llm_on.replies = [LLMReply("", [ToolCall("1", "get_doe", {})]), LLMReply("온도·시간 2개 인자입니다.")]
    r = _say(c, "이 DOE 알려줘", project_id=pid, path=f"/projects/{pid}/step/1")
    am = r["messages"][-1]
    assert am["content"] == "온도·시간 2개 인자입니다." and am["pending"] is None
    sys_msg = llm_on.seen[0][0]["content"]
    assert "지금 보고 있는 DOE: 대화 읽기" in sys_msg and "① 실험 데이터 입력" in sys_msg
    tool_msg = llm_on.seen[1][-1]
    assert tool_msg["role"] == "tool" and "온도" in tool_msg["content"]


def test_chat_write_needs_user_confirmation(client_for, llm_on):
    c = client_for("E1001")
    pid = _project(c, "대화 쓰기")
    code = c.get(f"/api/projects/{pid}/runs").json()[0]["code"]
    llm_on.replies = [LLMReply("저장할게요", [ToolCall("1", "enter_results", {"rows": [{"run": code, "values": {"수율": 81}}], "confirm": True})])]
    r = _say(c, f"{code} 수율 81", project_id=pid)
    card = r["messages"][-1]
    p = card["pending"]
    assert p and p["tool"] == "enter_results" and not p["danger"] and "81" in " ".join(p["lines"])
    assert c.get(f"/api/projects/{pid}/runs").json()[0]["values"]["yield"] is None  # 아직 저장 안 됨
    # 다른 사람은 이 카드로 실행할 수 없다
    assert client_for("E1002").post("/api/assistant/confirm", json={"token": p["token"]}).status_code == 400
    # 위·변조된 카드는 거부
    assert c.post("/api/assistant/confirm", json={"token": p["token"][:-3] + "abc"}).status_code == 400
    ok = c.post("/api/assistant/confirm", json={"token": p["token"], "message_id": card["id"]})
    assert ok.status_code == 200, ok.text
    assert ok.json()["card"]["state"] == "done" and ok.json()["message"]["content"].startswith("✓ 실행했습니다")
    assert c.get(f"/api/projects/{pid}/runs").json()[0]["values"]["yield"] == 81
    assert c.post("/api/assistant/confirm", json={"token": p["token"]}).status_code == 400  # 두 번 실행 불가
    assert c.post("/api/assistant/confirm", json={"token": p["token"], "message_id": card["id"]}).status_code == 400
    # 처리 결과가 대화 기록에 남는다
    msgs = c.get(f"/api/assistant/conversations/{r['conversation']['id']}").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "assistant"] and msgs[1]["state"] == "done"
    with SessionLocal() as db:
        logs = db.query(AuditLog).filter(AuditLog.entity_id == pid, AuditLog.action == "results.save").all()
        assert logs and logs[-1].detail.get("via") == "assistant"


def test_chat_danger_needs_two_confirmations(client_for, llm_on):
    c = client_for("E1001")
    pid = _project(c, "대화 위험 작업")
    code = c.get(f"/api/projects/{pid}/runs").json()[0]["code"]
    llm_on.replies = [LLMReply("", [ToolCall("1", "delete_run", {"run": code})])]
    p = _say(c, f"{code} 지워줘", project_id=pid)["messages"][-1]["pending"]
    assert p["danger"] and p["warning"]
    n = len(c.get(f"/api/projects/{pid}/runs").json())
    r = c.post("/api/assistant/confirm", json={"token": p["token"]})
    assert r.status_code == 400 and "한 번 더" in r.json()["detail"]
    assert len(c.get(f"/api/projects/{pid}/runs").json()) == n
    r = c.post("/api/assistant/confirm", json={"token": p["token"], "danger_ack": True})
    assert r.status_code == 200, r.text
    assert len(c.get(f"/api/projects/{pid}/runs").json()) == n - 1


def test_chat_ignores_project_context_without_access(client_for, llm_on):
    owner = client_for("E1001")
    pid = _project(owner, "남의 DOE 문맥")
    llm_on.replies = [LLMReply("네")]
    _say(client_for("E2001"), "이거", project_id=pid)
    assert "남의 DOE 문맥" not in llm_on.seen[0][0]["content"]


# ---------------------------------------------------------------- 대화 기록 (계정별 저장)
def test_conversation_is_saved_and_continued(client_for, llm_on):
    c = client_for("E1001")
    llm_on.replies = [LLMReply("첫 답"), LLMReply("둘째 답")]
    r1 = _say(c, "첫 질문입니다\n두 번째 줄")
    cid = r1["conversation"]["id"]
    assert r1["conversation"]["title"] == "첫 질문입니다"
    r2 = _say(c, "이어서 질문", conversation_id=cid)
    assert r2["conversation"]["id"] == cid and r2["conversation"]["message_count"] == 4
    # 두 번째 요청에는 서버에 저장된 지난 대화가 문맥으로 들어간다
    sent = [m["content"] for m in llm_on.seen[1] if m["role"] in ("user", "assistant")]
    assert sent == ["첫 질문입니다\n두 번째 줄", "첫 답", "이어서 질문"]
    # 목록·불러오기·이름 바꾸기
    lst = c.get("/api/assistant/conversations").json()
    assert lst[0]["id"] == cid
    got = c.get(f"/api/assistant/conversations/{cid}").json()
    assert [m["content"] for m in got["messages"]] == ["첫 질문입니다\n두 번째 줄", "첫 답", "이어서 질문", "둘째 답"]
    assert c.patch(f"/api/assistant/conversations/{cid}", json={"title": "공정 문의"}).json()["title"] == "공정 문의"
    # 새 대화는 따로
    llm_on.replies = [LLMReply("새 답")]
    r3 = _say(c, "새 대화")
    assert r3["conversation"]["id"] != cid and len(llm_on.seen[2]) == 2  # 시스템 + 이번 질문만
    assert c.get("/api/assistant/conversations").json()[0]["id"] == r3["conversation"]["id"]  # 최근 순
    # 삭제
    assert c.delete(f"/api/assistant/conversations/{cid}").status_code == 200
    assert c.get(f"/api/assistant/conversations/{cid}").status_code == 404
    ids = [x["id"] for x in c.get("/api/assistant/conversations").json()]
    assert cid not in ids and r3["conversation"]["id"] in ids


def test_conversations_are_private_to_each_account(client_for, llm_on):
    owner, other = client_for("E1001"), client_for("E1002")
    llm_on.replies = [LLMReply("답")]
    cid = _say(owner, "내 비밀 대화")["conversation"]["id"]
    mid = owner.get(f"/api/assistant/conversations/{cid}").json()["messages"][0]["id"]
    assert all(x["id"] != cid for x in other.get("/api/assistant/conversations").json())
    assert other.get(f"/api/assistant/conversations/{cid}").status_code == 404
    assert other.patch(f"/api/assistant/conversations/{cid}", json={"title": "x"}).status_code == 404
    assert other.delete(f"/api/assistant/conversations/{cid}").status_code == 404
    assert other.post("/api/assistant/chat", json={"message": "끼어들기", "conversation_id": cid}).status_code == 404
    assert other.post(f"/api/assistant/messages/{mid}/cancel").status_code == 404
    assert owner.get(f"/api/assistant/conversations/{cid}").json()["conversation"]["message_count"] == 2


def test_cancel_card_and_llm_error_are_saved(client_for, llm_on, monkeypatch):
    c = client_for("E1001")
    pid = _project(c, "대화 취소")
    code = c.get(f"/api/projects/{pid}/runs").json()[0]["code"]
    llm_on.replies = [LLMReply("", [ToolCall("1", "enter_results", {"rows": [{"run": code, "values": {"수율": 50}}]})])]
    r = _say(c, f"{code} 수율 50", project_id=pid)
    card = r["messages"][-1]
    assert c.post(f"/api/assistant/messages/{card['id']}/cancel").json()["state"] == "cancelled"
    assert c.post("/api/assistant/confirm", json={"token": card["pending"]["token"], "message_id": card["id"]}).status_code == 400
    assert c.get(f"/api/projects/{pid}/runs").json()[0]["values"]["yield"] is None
    # LLM 오류도 대화에 남고(빨간 말풍선), 다음 요청 문맥에서는 빠진다
    from app.assistant.llm import LLMError

    def boom(*a, **k):
        raise LLMError("사내 LLM 서버에 연결하지 못했습니다.")
    monkeypatch.setattr(llm_on, "chat", boom)
    r2 = _say(c, "다시", conversation_id=r["conversation"]["id"])
    assert r2["messages"][-1]["error"] is True
    monkeypatch.undo()
    s = get_settings()
    monkeypatch.setattr(s, "llm_base_url", "http://fake-ollama:11434")
    monkeypatch.setattr(s, "llm_model", "qwen-test")
    fake = FakeLLM([LLMReply("이제 됩니다")])
    monkeypatch.setattr(agent, "make_client", lambda s=None: fake)
    _say(c, "한 번 더", conversation_id=r["conversation"]["id"])
    assert all("연결하지 못했습니다" not in (m.get("content") or "") for m in fake.seen[0])


def test_mcp_on_by_default_and_can_be_turned_off(client_for, monkeypatch):
    from fastapi.testclient import TestClient
    c = client_for("E1001")
    assert get_settings().mcp_enabled is True and c.get("/api/assistant/status").json()["mcp"]["enabled"] is True
    monkeypatch.setattr(get_settings(), "mcp_enabled", False)
    assert c.get("/api/assistant/status").json()["mcp"]["enabled"] is False
    assert c.post("/api/me/tokens", json={"name": "x"}).status_code == 403
    m = TestClient(app)
    assert m.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers={"Authorization": "Bearer redo_x"}).status_code == 404


# ---------------------------------------------------------------- MCP · 토큰
def _rpc(c, token, method, params=None, id_=1):
    return c.post("/mcp", json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}},
                  headers={"Authorization": f"Bearer {token}"})


def test_mcp_with_personal_token(client_for, mcp_on):
    from fastapi.testclient import TestClient
    c = client_for("E1001")
    pid = _project(c, "MCP 테스트")
    tok = c.post("/api/me/tokens", json={"name": "사내 에이전트"}).json()
    raw = tok["token"]
    assert raw.startswith("redo_") and tok["prefix"].endswith("…")
    assert all("token" not in t for t in c.get("/api/me/tokens").json())  # 목록에는 원문이 없다
    m = TestClient(app)  # 쿠키 없이 토큰만
    assert m.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).status_code == 401
    init = _rpc(m, raw, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}).json()
    assert init["result"]["serverInfo"]["name"] == "dds-redo" and init["result"]["capabilities"]["tools"]
    assert m.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers={"Authorization": f"Bearer {raw}"}).status_code == 202
    tools = _rpc(m, raw, "tools/list").json()["result"]["tools"]
    assert len(tools) == 23
    er = next(t for t in tools if t["name"] == "enter_results")
    assert "confirm" in er["inputSchema"]["properties"] and er["annotations"]["readOnlyHint"] is False
    dd = next(t for t in tools if t["name"] == "delete_doe")
    assert dd["annotations"]["destructiveHint"] and "confirm_again" in dd["inputSchema"]["properties"]
    got = _rpc(m, raw, "tools/call", {"name": "get_doe", "arguments": {"doe": "MCP 테스트"}}).json()["result"]
    assert not got["isError"] and got["structuredContent"]["name"] == "MCP 테스트"
    code = c.get(f"/api/projects/{pid}/runs").json()[0]["code"]
    args = {"doe": pid, "rows": [{"run": code, "values": {"수율": 66}}]}
    pv = _rpc(m, raw, "tools/call", {"name": "enter_results", "arguments": args}).json()["result"]
    assert "확인이 필요합니다" in pv["content"][0]["text"]
    assert c.get(f"/api/projects/{pid}/runs").json()[0]["values"]["yield"] is None
    done = _rpc(m, raw, "tools/call", {"name": "enter_results", "arguments": {**args, "confirm": True}}).json()["result"]
    assert not done["isError"], done
    assert c.get(f"/api/projects/{pid}/runs").json()[0]["values"]["yield"] == 66
    with SessionLocal() as db:
        log = db.query(AuditLog).filter(AuditLog.entity_id == pid, AuditLog.action == "results.save").all()[-1]
        assert log.detail.get("via") == "mcp"
    # 위험 작업: confirm만으로는 안 되고 confirm_again까지
    d1 = _rpc(m, raw, "tools/call", {"name": "delete_doe", "arguments": {"doe": pid, "confirm": True}}).json()["result"]
    assert "한 번 더" in d1["content"][0]["text"] and c.get(f"/api/projects/{pid}").json()["deleted_at"] is None
    d2 = _rpc(m, raw, "tools/call", {"name": "delete_doe", "arguments": {"doe": pid, "confirm": True, "confirm_again": True}}).json()["result"]
    assert not d2["isError"] and c.get(f"/api/projects/{pid}").json()["deleted_at"] is not None
    # 배치 요청, 모르는 메서드
    batch = m.post("/mcp", json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "id": 2, "method": "nope"}],
                   headers={"Authorization": f"Bearer {raw}"}).json()
    assert batch[0]["result"] == {} and batch[1]["error"]["code"] == -32601
    # 토큰으로 일반 API도 (CSRF 헤더 없이) 쓸 수 있고, 폐기하면 바로 막힌다
    assert m.get("/api/auth/me", headers={"Authorization": f"Bearer {raw}"}).json()["user_key"] == "E1001"
    assert c.delete(f"/api/me/tokens/{tok['id']}").status_code == 200
    assert _rpc(m, raw, "ping").status_code == 401
    assert m.get("/api/projects", headers={"Authorization": f"Bearer {raw}"}).status_code == 401


def test_token_of_deactivated_user_is_rejected(client_for, mcp_on, monkeypatch):
    from fastapi.testclient import TestClient
    c = client_for("E1002")
    raw = c.post("/api/me/tokens", json={"name": "x"}).json()["token"]
    m = TestClient(app)
    assert _rpc(m, raw, "ping").status_code == 200
    with SessionLocal() as db:
        u = db.query(User).filter(User.user_key == "E1002").one()
        u.active = False
        db.commit()
    try:
        assert _rpc(m, raw, "ping").status_code == 401
        u_ok = client_for("E1001").post("/api/me/tokens", json={"name": "y"}).json()["token"]
        assert m.get("/api/projects", headers={"Authorization": f"Bearer {u_ok}"}).status_code == 200
        monkeypatch.setattr(get_settings(), "mcp_enabled", False)  # 기능을 끄면 이미 만든 토큰도 막힌다
        assert m.get("/api/projects", headers={"Authorization": f"Bearer {u_ok}"}).status_code == 401
    finally:
        with SessionLocal() as db:
            u = db.query(User).filter(User.user_key == "E1002").one()
            u.active = True
            db.commit()


# ---------------------------------------------------------------- LLM 연결 형식 (Ollama · OpenAI 호환)
def test_ollama_and_openai_adapters():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen[req.url.path] = json.loads(req.content) if req.content else None
        if req.url.path == "/api/chat":
            return httpx.Response(200, json={"message": {"role": "assistant", "content": "",
                                                         "tool_calls": [{"function": {"name": "get_doe", "arguments": {"doe": "CMP"}}}]}, "done": True})
        if req.url.path == "/v1/chat/completions":
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "predict", "arguments": "{\"conditions\": {\"pH\": 3}}"}}]}}]})
        if req.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "qwen-test:latest"}]})
        return httpx.Response(404)

    s = get_settings().model_copy(update={"llm_base_url": "http://ollama:11434", "llm_model": "qwen-test", "llm_provider": "ollama"})
    cl = LLMClient(s, transport=httpx.MockTransport(handler))
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "x", "name": "get_doe", "arguments": {}}]},
            {"role": "tool", "content": "{}", "tool_call_id": "x", "name": "get_doe"}]
    rep = cl.chat(msgs, [BY_NAME["get_doe"].schema()])
    assert rep.tool_calls[0].name == "get_doe" and rep.tool_calls[0].arguments == {"doe": "CMP"}
    body = seen["/api/chat"]
    assert body["model"] == "qwen-test" and body["stream"] is False and body["tools"][0]["function"]["name"] == "get_doe"
    assert body["messages"][3] == {"role": "tool", "content": "{}", "tool_name": "get_doe"}
    assert cl.ping() == (True, "연결됨")
    s2 = s.model_copy(update={"llm_provider": "openai", "llm_api_key": "k"})
    cl2 = LLMClient(s2, transport=httpx.MockTransport(handler))
    rep2 = cl2.chat(msgs, [])
    assert rep2.tool_calls[0].name == "predict" and rep2.tool_calls[0].arguments == {"conditions": {"pH": 3}}
    assert seen["/v1/chat/completions"]["messages"][3]["tool_call_id"] == "x"
