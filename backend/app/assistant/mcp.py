"""MCP 서버 (Model Context Protocol, Streamable HTTP의 JSON 응답 방식).

사내 MCP 클라이언트(에이전트·IDE 등)가 `POST /mcp` 로 접속해 DDS ReDO 도구를 쓴다.
- 인증: 개인 토큰 `Authorization: Bearer redo_…` (앱 화면의 'MCP 연결'에서 발급). 토큰 주인의 권한으로만 동작한다.
- 지원: initialize, notifications/*, ping, tools/list, tools/call (JSON-RPC 2.0, 배치 포함). 서버가 먼저 보내는 알림(SSE)은 쓰지 않는다.
- 데이터를 바꾸는 도구는 confirm 없이 부르면 '바뀔 내용'만 돌려준다. 사용자에게 보여 주고 승인받은 뒤 confirm=true로 다시 부른다.
  (도구 annotations에 readOnlyHint=false 를 달아 MCP 호스트가 승인 화면을 띄우도록 한다)
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from ..models import User
from .tools import TOOLS, BY_NAME, ToolContext, run_tool

SUPPORTED = ("2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "dds-redo", "title": "DDS ReDO", "version": "0.2.0"}
INSTRUCTIONS = (
    "DDS ReDO: 산포 인지형 능동학습 DOE(공정 레시피 최적화). 도구는 접속한 사용자의 권한으로 동작한다. "
    "DOE·인자·응답·런은 화면에 보이는 이름(예: 'CMP 슬러리', '제거율', '1차-03')으로 지정한다. "
    "데이터를 바꾸는 도구는 먼저 confirm 없이 불러 바뀔 내용을 사용자에게 보여 주고, 승인을 받은 뒤 같은 인자에 confirm=true를 더해 다시 부른다. "
    "삭제·공유·멤버·소유권 도구(destructiveHint)는 '정말 실행할까요?'를 한 번 더 확인받은 뒤 confirm_again=true까지 더해 부른다. "
    "사용법 질문은 search_manual을 쓴다."
)


def _tool_list() -> list[dict]:
    out = []
    for t in TOOLS:
        schema = json.loads(json.dumps(t.params))
        if t.writes:
            schema.setdefault("properties", {})["confirm"] = {
                "type": "boolean", "description": "true면 실행. 생략하면 바뀔 내용만 미리 보여 준다 (사용자 승인 후 true로 다시 호출)"}
        if t.danger:
            schema["properties"]["confirm_again"] = {
                "type": "boolean", "description": "되돌리기 어려운 작업: 사용자에게 '정말 실행할까요?'를 한 번 더 묻고 승인받은 뒤 confirm과 함께 true"}
        out.append({"name": t.name, "title": t.title, "description": t.description, "inputSchema": schema,
                    "annotations": {"title": t.title, "readOnlyHint": not t.writes, "destructiveHint": t.danger,
                                    "idempotentHint": not t.writes, "openWorldHint": False}})
    return out


def _err(id_: Any, code: int, msg: str) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": msg}}


def _call(db: Session, user: User, params: dict) -> dict:
    name = params.get("name")
    args = dict(params.get("arguments") or {})
    if name not in BY_NAME:
        return {"content": [{"type": "text", "text": f"알 수 없는 도구입니다: {name}"}], "isError": True}
    confirm = args.pop("confirm", False) is True
    again = args.pop("confirm_again", False) is True
    res = run_tool(ToolContext(db=db, user=user), name, args, confirmed=confirm, danger_ack=again)
    if res["status"] == "needs_reconfirmation":
        pv = res["preview"]
        text = "⚠ 되돌리기 어려운 작업입니다 — 아직 실행하지 않았습니다.\n" + pv["title"] + "\n" + "\n".join(f"- {x}" for x in pv.get("lines", [])) + \
            "\n\n사용자에게 '정말 실행할까요?'를 한 번 더 묻고, 승인하면 같은 인자에 confirm=true, confirm_again=true를 더해 다시 호출하세요."
        return {"content": [{"type": "text", "text": text}], "structuredContent": {"needs_reconfirmation": True, "preview": pv}, "isError": False}
    if res["status"] == "needs_confirmation":
        pv = res["preview"]
        text = "확인이 필요합니다 — 아직 저장하지 않았습니다.\n" + pv["title"] + "\n" + "\n".join(f"- {x}" for x in pv.get("lines", [])) + \
            "\n\n사용자에게 이 내용을 보여 주고 승인을 받은 뒤, 같은 인자에 confirm=true를 더해 다시 호출하세요."
        return {"content": [{"type": "text", "text": text}], "structuredContent": {"needs_confirmation": True, "preview": pv}, "isError": False}
    if res["status"] == "error":
        return {"content": [{"type": "text", "text": res["message"]}], "isError": True}
    data = res["data"]
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=1)[:20000]}],
            "structuredContent": data if isinstance(data, dict) else {"result": data}, "isError": False}


def handle_message(db: Session, user: User, msg: Any) -> dict | None:
    """JSON-RPC 메시지 하나 처리. 알림이면 None."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or "method" not in msg:
        return _err(msg.get("id") if isinstance(msg, dict) else None, -32600, "Invalid Request")
    method, id_ = msg["method"], msg.get("id")
    if id_ is None:  # 알림 (notifications/initialized 등)
        return None
    params = msg.get("params") or {}
    if method == "initialize":
        want = params.get("protocolVersion")
        return {"jsonrpc": "2.0", "id": id_, "result": {
            "protocolVersion": want if want in SUPPORTED else SUPPORTED[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO, "instructions": INSTRUCTIONS}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": id_, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": id_, "result": {"tools": _tool_list()}}
    if method == "tools/call":
        return {"jsonrpc": "2.0", "id": id_, "result": _call(db, user, params)}
    return _err(id_, -32601, f"Method not found: {method}")
