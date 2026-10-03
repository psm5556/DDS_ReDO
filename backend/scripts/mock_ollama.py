"""시험용 가짜 Ollama 서버 (E2E 테스트·시연용). 실제 LLM 없이 DDS Conversa 흐름을 확인한다.

    python -m scripts.mock_ollama --port 8013
    (백엔드) REDO_LLM_BASE_URL=http://127.0.0.1:8013  REDO_LLM_MODEL=mock

정해진 규칙으로 도구를 부른다 (Ollama /api/chat 형식):
- "상태"·"알려" → get_doe / "목록" → list_does / "어떻게"·"방법" → search_manual
- "1차-03 수율 77" → enter_results / "1차-03 지워" → delete_run
- 도구 결과를 받으면 그 내용을 짧게 요약해 답한다.
"""
from __future__ import annotations

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def reply(messages: list[dict]) -> dict:
    last = messages[-1]
    if last.get("role") == "tool":
        try:
            data = json.loads(last.get("content") or "{}")
        except json.JSONDecodeError:
            data = {}
        if isinstance(data, dict) and "error" in data:
            return {"role": "assistant", "content": f"처리하지 못했습니다: {data['error']}"}
        if isinstance(data, dict) and "factors" in data:
            fs = ", ".join(f["name"] for f in data["factors"])
            return {"role": "assistant", "content": f"**{data['name']}** — 인자 {fs}, 진행 {data['progress']}, 다음 할 일: {data['next']}"}
        if isinstance(data, dict) and "does" in data:
            return {"role": "assistant", "content": f"DOE {data['count']}개: " + ", ".join(d["name"] for d in data["does"][:5])}
        if isinstance(data, dict) and "results" in data and isinstance(data["results"], list):
            return {"role": "assistant", "content": "매뉴얼: " + (data["results"][0]["section"] if data["results"] else "찾지 못함")}
        return {"role": "assistant", "content": "확인 카드를 띄웠습니다. 내용을 보고 [실행]을 눌러 주세요."}
    text = str(last.get("content") or "")
    call = None
    m = re.search(r"(\d+차-\d+)\s*(\S+?)\s+([\d.]+)", text)
    if re.search(r"(\d+차-\d+).*지워", text):
        call = {"name": "delete_run", "arguments": {"run": re.search(r"\d+차-\d+", text).group(0)}}  # type: ignore[union-attr]
    elif m:
        call = {"name": "enter_results", "arguments": {"rows": [{"run": m.group(1), "values": {m.group(2): float(m.group(3))}}]}}
    elif "목록" in text:
        call = {"name": "list_does", "arguments": {}}
    elif "어떻게" in text or "방법" in text:
        call = {"name": "search_manual", "arguments": {"query": text}}
    elif "상태" in text or "알려" in text:
        call = {"name": "get_doe", "arguments": {}}
    if call:
        return {"role": "assistant", "content": "", "tool_calls": [{"function": call}]}
    return {"role": "assistant", "content": "무엇을 도와드릴까요?"}


MODELS = ["mock"]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/api/tags"):
            self._send(200, {"models": [{"name": m if ":" in m else f"{m}:latest", "model": m} for m in MODELS]})
        else:
            self._send(200, {"ok": True})

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path.startswith("/api/chat"):
            self._send(200, {"model": body.get("model"), "message": reply(body.get("messages") or []), "done": True})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, *a) -> None:  # 조용히
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8013)
    ap.add_argument("--models", default="mock", help="쉼표로 구분한 모델 이름 (연결 확인 /api/tags 응답)")
    args = ap.parse_args()
    MODELS[:] = [m.strip() for m in args.models.split(",") if m.strip()]
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
