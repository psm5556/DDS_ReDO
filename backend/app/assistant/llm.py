"""사내 LLM 연결 — Ollama(/api/chat) 또는 OpenAI 호환(/v1/chat/completions). 도구 호출(tool calling)을 쓴다.
외부 인터넷이 아니라 사내에서 서빙하는 주소(REDO_LLM_BASE_URL)로만 보낸다.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..config import Settings


class LLMError(Exception):
    """LLM 서버 연결·응답 오류 (사용자에게 보여 줄 수 있는 문장)"""


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict


@dataclass
class LLMReply:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)


def _args(v: Any) -> dict:
    if isinstance(v, dict):
        return v
    if isinstance(v, str) and v.strip():
        try:
            d = json.loads(v)
            return d if isinstance(d, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


class LLMClient:
    def __init__(self, s: Settings, transport: httpx.BaseTransport | None = None):
        self.s = s
        self.base = s.llm_base_url.rstrip("/")
        headers = {"Authorization": f"Bearer {s.llm_api_key}"} if s.llm_api_key else {}
        self.http = httpx.Client(timeout=s.llm_timeout_sec, headers=headers, transport=transport)

    # ---- 메시지 형식 변환: 내부 형식 {role, content, tool_calls?, tool_call_id?, name?}
    def _to_ollama(self, messages: list[dict]) -> list[dict]:
        out = []
        for m in messages:
            if m["role"] == "assistant" and m.get("tool_calls"):
                out.append({"role": "assistant", "content": m.get("content") or "",
                            "tool_calls": [{"function": {"name": c["name"], "arguments": c["arguments"]}} for c in m["tool_calls"]]})
            elif m["role"] == "tool":
                out.append({"role": "tool", "content": m["content"], "tool_name": m.get("name", "")})
            else:
                out.append({"role": m["role"], "content": m["content"]})
        return out

    def _to_openai(self, messages: list[dict]) -> list[dict]:
        out = []
        for m in messages:
            if m["role"] == "assistant" and m.get("tool_calls"):
                out.append({"role": "assistant", "content": m.get("content") or None,
                            "tool_calls": [{"id": c["id"], "type": "function",
                                            "function": {"name": c["name"], "arguments": json.dumps(c["arguments"], ensure_ascii=False)}}
                                           for c in m["tool_calls"]]})
            elif m["role"] == "tool":
                out.append({"role": "tool", "content": m["content"], "tool_call_id": m.get("tool_call_id", "")})
            else:
                out.append({"role": m["role"], "content": m["content"]})
        return out

    def chat(self, messages: list[dict], tools: list[dict]) -> LLMReply:
        try:
            if self.s.llm_provider == "openai":
                r = self.http.post(f"{self.base}/v1/chat/completions", json={
                    "model": self.s.llm_model, "messages": self._to_openai(messages), "tools": tools,
                    "temperature": self.s.llm_temperature, "stream": False})
                r.raise_for_status()
                msg = r.json()["choices"][0]["message"]
                calls = [ToolCall(c.get("id") or uuid.uuid4().hex[:8], c["function"]["name"], _args(c["function"].get("arguments")))
                         for c in (msg.get("tool_calls") or [])]
                return LLMReply(msg.get("content") or "", calls)
            r = self.http.post(f"{self.base}/api/chat", json={
                "model": self.s.llm_model, "messages": self._to_ollama(messages), "tools": tools, "stream": False,
                "options": {"temperature": self.s.llm_temperature, "num_ctx": self.s.llm_num_ctx}})
            r.raise_for_status()
            msg = r.json().get("message") or {}
            calls = [ToolCall(uuid.uuid4().hex[:8], c["function"]["name"], _args(c["function"].get("arguments")))
                     for c in (msg.get("tool_calls") or []) if c.get("function", {}).get("name")]
            return LLMReply(msg.get("content") or "", calls)
        except httpx.TimeoutException as e:
            raise LLMError("사내 LLM 응답이 너무 늦습니다. 잠시 후 다시 시도하세요.") from e
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            if code == 404:
                raise LLMError(f"사내 LLM에서 모델 '{self.s.llm_model}'을(를) 찾지 못했습니다. 모델 이름을 확인하세요.") from e
            raise LLMError(f"사내 LLM 서버 오류({code})입니다.") from e
        except (httpx.HTTPError, KeyError, ValueError) as e:
            raise LLMError("사내 LLM 서버에 연결하지 못했습니다. 주소(REDO_LLM_BASE_URL)를 확인하세요.") from e

    def ping(self) -> tuple[bool, str]:
        """연결 확인: 서버가 살아 있고 모델이 있는지"""
        try:
            if self.s.llm_provider == "openai":
                r = self.http.get(f"{self.base}/v1/models", timeout=5)
                r.raise_for_status()
                ids = [m.get("id") for m in r.json().get("data", [])]
            else:
                r = self.http.get(f"{self.base}/api/tags", timeout=5)
                r.raise_for_status()
                ids = [m.get("name") or m.get("model") for m in r.json().get("models", [])]
            ok = any(i == self.s.llm_model or (i or "").split(":")[0] == self.s.llm_model.split(":")[0] for i in ids)
            return (True, "연결됨") if ok else (False, f"서버에 모델 '{self.s.llm_model}'이(가) 없습니다.")
        except Exception:  # noqa: BLE001 — 상태 표시용
            return False, "사내 LLM 서버에 연결하지 못했습니다."
