"""사용 매뉴얼(docs/USER_MANUAL.md)에서 질문과 관련된 절을 찾는다 — AI 도우미가 사용법 질문에 답할 때 근거로 쓴다.
외부 검색·임베딩 없이 단어 겹침으로 고른다 (사내망, 가벼움). 매뉴얼을 고치면 다음 요청부터 바로 반영된다."""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

MANUAL = Path(__file__).resolve().parents[3] / "docs" / "USER_MANUAL.md"


def _slug(t: str) -> str:
    return re.sub(r"\s", "-", re.sub(r"[^\w\s-]", "", t.strip().lower()))


@lru_cache(maxsize=4)
def _sections(mtime: float) -> list[tuple[str, str, str]]:
    """(제목, 앵커, 본문) — 그림·표 구분선은 빼고 글만"""
    text = MANUAL.read_text(encoding="utf-8")
    out: list[tuple[str, str, str]] = []
    title, body = "", []
    for line in text.splitlines():
        m = re.match(r"^(#{2,3})\s+(.*)$", line)
        if m:
            if title:
                out.append((title, _slug(title), "\n".join(body).strip()))
            title, body = m.group(2).strip(), []
        elif title and not line.startswith("![") and not re.match(r"^\|?\s*:?-{3,}", line):
            body.append(line)
    if title:
        out.append((title, _slug(title), "\n".join(body).strip()))
    return out


def _words(s: str) -> set[str]:
    ws = set(re.findall(r"[0-9A-Za-z가-힣]{2,}", s.lower()))
    # 한국어 조사 붙은 말도 맞도록 앞 2~3글자 조각을 더한다
    return ws | {w[:2] for w in ws if len(w) >= 3} | {w[:3] for w in ws if len(w) >= 4}


def search_manual(query: str, limit: int = 3) -> list[dict]:
    if not MANUAL.is_file():
        return []
    q = _words(query)
    if not q:
        return []
    scored = []
    for title, anchor, body in _sections(MANUAL.stat().st_mtime):
        tw, bw = _words(title), _words(body)
        score = 3 * len(q & tw) + len(q & bw)
        if score:
            scored.append((score, title, anchor, body))
    scored.sort(key=lambda x: -x[0])
    return [{"section": t, "manual_link": f"/manual/index.html#{a}", "text": b[:1400]} for _, t, a, b in scored[:limit]]
