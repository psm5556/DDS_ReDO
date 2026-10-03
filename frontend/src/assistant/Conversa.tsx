import { AlertTriangle, ArrowUp, Check, Link2, Loader2, PanelRightClose, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { get, post } from "../api";
import { notifyDataChanged, notifyProjectsChanged } from "../guide/steps";
import { openManual } from "../manual";
import { startPanelResize, type PanelLayout } from "../components/sideLayout";
import { McpConnectModal } from "./McpConnect";

/** DDS Conversa — 사내 LLM으로 앱을 말로 조작하는 도우미. 오른쪽 사이드바로 붙어 있고, 왼쪽 사이드바처럼
 *  접기(Ctrl+J, 아이콘 막대로)와 왼쪽 가장자리 드래그로 너비 조절(320~720px, 두 번 누르면 기본 400px)이 된다.
 *  데이터를 바꾸는 요청은 '확인 카드'로 멈추고, 사용자가 [실행]을 눌러야 저장된다.
 *  되돌리기 어려운 작업(삭제·공유·멤버·소유권)은 "정말 실행할까요?"를 한 번 더 묻는다. */

interface Pending { token: string; tool: string; title: string; lines: string[]; danger?: boolean; warning?: string | null }
interface UiAction { type: "navigate" | "open_manual"; path?: string; section?: string }
interface Msg { role: "user" | "assistant"; content: string; pending?: Pending; state?: "done" | "cancelled" | "error"; error?: boolean }
interface Status { enabled: boolean; reachable: boolean; model: string | null; message: string; title: string; tools: { name: string; title: string; writes: boolean; danger: boolean }[] }

const STORE = "redo.conversa";
const OPEN_EVENT = "redo:conversa-open";
/** 사이드바 버튼 등에서 DDS Conversa 창을 연다 */
export const openConversa = () => window.dispatchEvent(new Event(OPEN_EVENT));

/** **굵게**와 줄바꿈만 처리 (HTML을 직접 넣지 않는다) */
function Rich({ text }: { text: string }) {
  return (
    <>{text.split("\n").map((line, i) => (
      <span key={i}>{i > 0 && <br />}{line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
        part.startsWith("**") && part.endsWith("**") ? <b key={j}>{part.slice(2, -2)}</b> : <span key={j}>{part}</span>)}</span>
    ))}</>
  );
}

function suggestions(path: string): string[] {
  if (/\/projects\/\d+\/step\/2/.test(path)) return ["추천 레시피를 쉽게 설명해 줘", "다음 실험 4건 제안해 줘", "규격 확률이 낮은 응답을 개선하려면?"];
  if (/\/projects\/\d+\/step\/1/.test(path)) return ["남은 실험 보여 줘", "1차-01 결과 입력하는 법 알려 줘", "결과를 한꺼번에 붙여넣는 방법은?"];
  if (/\/projects\/\d+/.test(path)) return ["이 DOE 상태 알려 줘", "추천 레시피 보여 줘", "멤버와 공유 현황 알려 줘"];
  return ["내 DOE 목록 보여 줘", "지금 할 일이 뭐야?", "새 DOE 만드는 법 알려 줘"];
}

export function Conversa({ layout }: { layout: PanelLayout }) {
  const loc = useLocation();
  const nav = useNavigate();
  const open = !layout.collapsed;
  const [status, setStatus] = useState<Status | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(STORE) || "[]") as Msg[]; } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mcp, setMcp] = useState(false);
  const [ask, setAsk] = useState<number | null>(null); // 위험 작업 '정말 실행할까요?' 단계인 메시지 번호
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const projectId = useMemo(() => Number(loc.pathname.match(/^\/projects\/(\d+)/)?.[1]) || null, [loc.pathname]);

  useEffect(() => { try { sessionStorage.setItem(STORE, JSON.stringify(msgs.slice(-40))); } catch { /* 저장 못 해도 동작 */ } }, [msgs]);
  useEffect(() => { if (open && !status) get<Status>("/api/assistant/status").then(setStatus).catch(() => {}); }, [open, status]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy, ask]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50); }, [open]);
  const { setCollapsed } = layout;
  useEffect(() => { // 사이드바 버튼 등에서 열기
    const h = () => setCollapsed(false);
    window.addEventListener(OPEN_EVENT, h);
    return () => window.removeEventListener(OPEN_EVENT, h);
  }, [setCollapsed]);

  const runUi = useCallback((acts: UiAction[] = []) => {
    for (const a of acts) {
      if (a.type === "navigate" && a.path !== undefined) nav(a.path);
      if (a.type === "open_manual") openManual(a.section || undefined);
    }
  }, [nav]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    const history = [...msgs.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })), { role: "user" as const, content: t }];
    setMsgs((m) => [...m, { role: "user", content: t }]);
    setInput("");
    setBusy(true);
    try {
      const r = await post<{ reply: string; pending: Pending | null; ui_actions: UiAction[] }>("/api/assistant/chat",
        { messages: history.slice(-20), project_id: projectId, path: loc.pathname });
      setMsgs((m) => [...m, { role: "assistant", content: r.reply, pending: r.pending ?? undefined }]);
      runUi(r.ui_actions);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: (e as Error).message, error: true }]);
    } finally { setBusy(false); }
  };

  const decide = async (i: number, run: boolean, dangerAck = false) => {
    const p = msgs[i].pending!;
    if (!run) { setAsk(null); setMsgs((m) => m.map((x, j) => (j === i ? { ...x, state: "cancelled" } : x))); return; }
    if (p.danger && !dangerAck) { setAsk(i); return; }
    setAsk(null);
    setBusy(true);
    try {
      const r = await post<{ ok: boolean; ui_actions: UiAction[] }>("/api/assistant/confirm", { token: p.token, danger_ack: dangerAck });
      setMsgs((m) => [...m.map((x, j) => (j === i ? { ...x, state: "done" as const } : x)), { role: "assistant", content: `✓ 실행했습니다: ${p.title}` }]);
      notifyDataChanged();
      notifyProjectsChanged();
      runUi(r.ui_actions);
    } catch (e) {
      setMsgs((m) => [...m.map((x, j) => (j === i ? { ...x, state: "error" as const } : x)), { role: "assistant", content: (e as Error).message, error: true }]);
    } finally { setBusy(false); }
  };

  const disabled = status !== null && !status.enabled;

  if (!open) {
    return (
      <aside className="conversa rail" aria-label="DDS Conversa (접힘)">
        <button className="icon-btn cv-rail-btn" onClick={() => setCollapsed(false)} aria-label="DDS Conversa 펼치기" title="DDS Conversa 펼치기 (Ctrl+J)"><Sparkles size={18} /></button>
        <button className="cv-rail-label" onClick={() => setCollapsed(false)} tabIndex={-1} aria-hidden="true">DDS Conversa</button>
        {mcp && <McpConnectModal onClose={() => setMcp(false)} />}
      </aside>
    );
  }

  return (
    <>
      {open && (
        <aside className="conversa" role="complementary" aria-label="DDS Conversa">
          <div className="side-resizer cv-resizer" role="separator" aria-orientation="vertical" aria-label="DDS Conversa 너비 조절"
            aria-valuenow={layout.width} aria-valuemin={layout.min} aria-valuemax={layout.max} tabIndex={0} title="끌어서 너비 조절 · 두 번 누르면 기본 너비"
            onPointerDown={(e) => startPanelResize(e, layout, "left")} onDoubleClick={layout.reset}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") { e.preventDefault(); layout.setWidth(layout.width + 16); }
              if (e.key === "ArrowRight") { e.preventDefault(); layout.setWidth(layout.width - 16); }
            }} />
          <header className="cv-head">
            <span className="cv-logo"><Sparkles size={15} /></span>
            <div className="grow"><b>DDS Conversa</b>
              <small>{status ? (status.enabled ? `${status.model}${status.reachable ? "" : " · 연결 안 됨"}` : "사내 LLM 미등록") : "확인 중…"}</small></div>
            <button className="icon-btn" title="MCP 연결 (사내 에이전트·IDE에서 쓰기)" aria-label="MCP 연결" onClick={() => setMcp(true)}><Link2 size={16} /></button>
            <button className="icon-btn" title="대화 지우기" aria-label="대화 지우기" onClick={() => { setMsgs([]); setAsk(null); }} disabled={!msgs.length}><Trash2 size={15} /></button>
            <button className="icon-btn" title="접기 (Ctrl+J)" aria-label="DDS Conversa 접기" onClick={() => setCollapsed(true)}><PanelRightClose size={16} /></button>
          </header>

          <div className="cv-body" ref={listRef}>
            {disabled ? (
              <div className="cv-empty">
                <Sparkles size={26} />
                <b>사내 LLM이 아직 연결되지 않았습니다</b>
                <p>{status?.message}</p>
                <p className="small muted">관리자: 서버 환경변수 <code>REDO_LLM_BASE_URL</code>(예: http://ollama.사내:11434)과 <code>REDO_LLM_MODEL</code>을 등록하면 바로 쓸 수 있습니다.</p>
                <button className="small" onClick={() => setMcp(true)}><Link2 size={14} />MCP 연결은 지금도 쓸 수 있습니다</button>
              </div>
            ) : msgs.length === 0 ? (
              <div className="cv-empty">
                <Sparkles size={26} />
                <b>무엇을 도와드릴까요?</b>
                <p>DOE 조회, 결과 입력, 추천 레시피 설명, 다음 실험 확정, 사용법 안내를 말로 요청하세요. 저장·삭제처럼 데이터가 바뀌는 일은 실행 전에 꼭 확인을 받습니다.</p>
                <div className="cv-suggest">{suggestions(loc.pathname).map((s) => <button key={s} className="small" onClick={() => void send(s)}>{s}</button>)}</div>
              </div>
            ) : msgs.map((m, i) => (
              <div key={i} className={`cv-msg ${m.role} ${m.error ? "err" : ""}`}>
                <div className="bubble"><Rich text={m.content} /></div>
                {m.pending && (
                  <PendingCard p={m.pending} state={m.state} asking={ask === i} busy={busy}
                    onRun={() => void decide(i, true)} onCancel={() => void decide(i, false)} onAck={() => void decide(i, true, true)} />
                )}
              </div>
            ))}
            {busy && <div className="cv-msg assistant"><div className="bubble thinking"><Loader2 size={14} className="spin" />생각하는 중…</div></div>}
          </div>

          <form className="cv-input" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
            <textarea ref={inputRef} value={input} rows={1} placeholder={disabled ? "사내 LLM 연결 후 사용할 수 있습니다" : "예: 1차-03 제거율 412, 디싱 18 입력해 줘"}
              disabled={disabled || busy} aria-label="DDS Conversa에게 요청"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input); } }} />
            <button type="submit" className="primary cv-send" disabled={disabled || busy || !input.trim()} aria-label="보내기"><ArrowUp size={16} /></button>
          </form>
          <p className="cv-foot">사내 LLM으로 처리되며 외부로 보내지 않습니다 · 내 권한 안에서만 동작</p>
        </aside>
      )}
      {mcp && <McpConnectModal onClose={() => setMcp(false)} />}
    </>
  );
}

function PendingCard({ p, state, asking, busy, onRun, onCancel, onAck }: {
  p: Pending; state?: Msg["state"]; asking: boolean; busy: boolean; onRun: () => void; onCancel: () => void; onAck: () => void;
}) {
  const done: ReactNode = state === "done" ? <span className="cv-state ok"><Check size={13} />실행함</span>
    : state === "cancelled" ? <span className="cv-state">취소함</span> : state === "error" ? <span className="cv-state err">실행하지 못함</span> : null;
  return (
    <div className={`cv-card ${p.danger ? "danger" : ""}`} role="group" aria-label={`확인: ${p.title}`}>
      <div className="cv-card-title">{p.danger && <AlertTriangle size={15} />}{p.title}</div>
      {p.lines.length > 0 && <ul>{p.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {p.danger && p.warning && !done && <p className="cv-warn">{p.warning}</p>}
      {done ?? (asking ? (
        <div className="cv-ask">
          <b>정말 실행할까요? 되돌리기 어렵습니다.</b>
          <div className="row"><button className="small" onClick={onCancel} disabled={busy}>아니오</button>
            <button className="small danger-solid" onClick={onAck} disabled={busy}>네, 실행합니다</button></div>
        </div>
      ) : (
        <div className="row cv-actions">
          <button className="small" onClick={onCancel} disabled={busy}>취소</button>
          <button className={`small ${p.danger ? "danger" : "primary"}`} onClick={onRun} disabled={busy}>실행</button>
        </div>
      ))}
    </div>
  );
}
