import { AlertTriangle, ArrowUp, Check, History, Link2, Loader2, PanelRightClose, Pencil, Search, Sparkles, SquarePen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { del, get, patch, post } from "../api";
import { useAuth } from "../auth";
import { notifyDataChanged, notifyProjectsChanged } from "../guide/steps";
import { openManual } from "../manual";
import { startPanelResize, type PanelLayout } from "../components/sideLayout";
import { McpConnectModal } from "./McpConnect";

/** DDS Conversa — 사내 LLM으로 앱을 말로 조작하는 도우미. 오른쪽 사이드바로 붙어 있고, 왼쪽 사이드바처럼
 *  접기(Ctrl+J, 아이콘 막대로)와 왼쪽 가장자리 드래그로 너비 조절(320~720px, 두 번 누르면 기본 400px)이 된다.
 *  대화는 계정별로 서버에 저장되어 언제든 '대화 목록'에서 다시 불러 이어 갈 수 있다.
 *  데이터를 바꾸는 요청은 '확인 카드'로 멈추고, 사용자가 [실행]을 눌러야 저장된다.
 *  되돌리기 어려운 작업(삭제·공유·멤버·소유권)은 "정말 실행할까요?"를 한 번 더 묻는다. */

interface Pending { token: string; tool: string; title: string; lines: string[]; danger?: boolean; warning?: string | null }
interface UiAction { type: "navigate" | "open_manual"; path?: string; section?: string }
type CardState = "done" | "cancelled" | "error" | "expired";
interface Msg { id?: number; role: "user" | "assistant"; content: string; pending?: Pending | null; state?: CardState | null; error?: boolean }
interface Conv { id: number; title: string; created_at: string; updated_at: string; message_count: number }
interface Status {
  enabled: boolean; reachable: boolean; model: string | null; message: string; title: string;
  mcp?: { enabled: boolean; path: string };
  tools: { name: string; title: string; writes: boolean; danger: boolean }[];
}

const OPEN_EVENT = "redo:conversa-open";
/** 사이드바 버튼 등에서 DDS Conversa 창을 연다 */
export const openConversa = () => window.dispatchEvent(new Event(OPEN_EVENT));

/** 이 브라우저에서 마지막으로 보던 대화 (계정별). 저장 못 해도 동작한다 */
const currentKey = (userKey: string) => `redo.conversa.current.${userKey}`;
const loadCurrent = (userKey: string) => { try { return Number(localStorage.getItem(currentKey(userKey))) || null; } catch { return null; } };
const saveCurrent = (userKey: string, id: number | null) => {
  try { if (id) localStorage.setItem(currentKey(userKey), String(id)); else localStorage.removeItem(currentKey(userKey)); } catch { /* 무시 */ }
};

/** 서버 시각(UTC)을 '오늘 14:20' / '어제' / '10월 3일'로 */
function when(iso: string): string {
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (diff === 1) return "어제";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

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
  const { user } = useAuth();
  const userKey = user?.user_key ?? "";
  const open = !layout.collapsed;
  const [status, setStatus] = useState<Status | null>(null);
  const [conv, setConv] = useState<Conv | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [view, setView] = useState<"chat" | "list">("chat");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mcp, setMcp] = useState(false);
  const [ask, setAsk] = useState<number | null>(null); // 위험 작업 '정말 실행할까요?' 단계인 메시지 번호
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const projectId = useMemo(() => Number(loc.pathname.match(/^\/projects\/(\d+)/)?.[1]) || null, [loc.pathname]);
  const mcpOn = !!status?.mcp?.enabled; // 앱 밖 AI(MCP) 연결은 서버에서 켠 경우에만 보인다
  const seq = useRef(0); // 늦게 도착한 '대화 불러오기' 응답이 그 뒤의 화면(새 대화·다른 대화)을 덮지 않게

  const openConv = useCallback(async (id: number) => {
    const my = ++seq.current;
    try {
      const r = await get<{ conversation: Conv; messages: Msg[] }>(`/api/assistant/conversations/${id}`);
      if (my !== seq.current) return;
      setConv(r.conversation);
      setMsgs(r.messages);
      saveCurrent(userKey, id);
    } catch {
      if (my !== seq.current) return;
      setConv(null); setMsgs([]); saveCurrent(userKey, null); // 지워졌거나 다른 계정의 대화
    }
    setAsk(null);
    setView("chat");
  }, [userKey]);

  // 계정이 정해지면 그 계정이 마지막으로 보던 대화를 불러온다
  useEffect(() => {
    seq.current++;
    setConv(null); setMsgs([]); setView("chat");
    if (!userKey) return;
    const id = loadCurrent(userKey);
    if (id) void openConv(id);
  }, [userKey, openConv]);
  useEffect(() => { if (open && !status) get<Status>("/api/assistant/status").then(setStatus).catch(() => {}); }, [open, status]);
  useEffect(() => { if (view === "chat") listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy, ask, view]);
  useEffect(() => { if (open && view === "chat") setTimeout(() => inputRef.current?.focus(), 50); }, [open, view]);
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

  const newChat = () => { seq.current++; setConv(null); setMsgs([]); setAsk(null); setView("chat"); saveCurrent(userKey, null); };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    const my = ++seq.current;
    const before = msgs;
    setMsgs([...before, { role: "user", content: t }]); // 바로 보이게 (저장되면 서버 것으로 바뀜)
    setInput("");
    setBusy(true);
    try {
      const r = await post<{ conversation: Conv; messages: Msg[]; ui_actions: UiAction[] }>("/api/assistant/chat",
        { message: t, conversation_id: conv?.id ?? null, project_id: projectId, path: loc.pathname });
      if (my === seq.current) { // 기다리는 사이 다른 대화로 옮겼으면 화면은 그대로 (대화는 서버에 저장됨)
        setConv(r.conversation);
        saveCurrent(userKey, r.conversation.id);
        setMsgs([...before, ...r.messages]);
      }
      runUi(r.ui_actions);
    } catch (e) {
      if (my === seq.current) setMsgs([...before, { role: "user", content: t }, { role: "assistant", content: (e as Error).message, error: true }]);
    } finally { setBusy(false); }
  };

  const decide = async (i: number, run: boolean, dangerAck = false) => {
    const before = msgs;
    const msg = before[i];
    const p = msg.pending!;
    const mark = (state: CardState) => before.map((x, j) => (j === i ? { ...x, state } : x));
    if (!run) {
      setAsk(null);
      setMsgs(mark("cancelled"));
      if (msg.id) post(`/api/assistant/messages/${msg.id}/cancel`).catch(() => {});
      return;
    }
    if (p.danger && !dangerAck) { setAsk(i); return; }
    setAsk(null);
    setBusy(true);
    const my = seq.current;
    try {
      const r = await post<{ ok: boolean; ui_actions: UiAction[]; message?: Msg }>("/api/assistant/confirm",
        { token: p.token, danger_ack: dangerAck, message_id: msg.id ?? null });
      if (my === seq.current) setMsgs([...mark("done"), r.message ?? { role: "assistant", content: `✓ 실행했습니다: ${p.title}` }]);
      notifyDataChanged();
      notifyProjectsChanged();
      runUi(r.ui_actions);
    } catch (e) {
      if (my === seq.current) setMsgs([...mark("error"), { role: "assistant", content: (e as Error).message, error: true }]);
    } finally { setBusy(false); }
  };

  const disabled = status !== null && !status.enabled;

  if (!open) {
    return (
      <aside className="conversa rail" aria-label="DDS Conversa (접힘)">
        <button className="icon-btn cv-rail-btn" onClick={() => setCollapsed(false)} aria-label="DDS Conversa 펼치기" title="DDS Conversa 펼치기 (Ctrl+J)"><Sparkles size={18} /></button>
        <button className="cv-rail-label" onClick={() => setCollapsed(false)} tabIndex={-1} aria-hidden="true">DDS Conversa</button>
      </aside>
    );
  }

  return (
    <>
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
          {mcpOn && <button className="icon-btn" title="MCP 연결 (사내 에이전트·IDE에서 쓰기)" aria-label="MCP 연결" onClick={() => setMcp(true)}><Link2 size={16} /></button>}
          <button className={`icon-btn ${view === "list" ? "on" : ""}`} title="대화 목록" aria-label="대화 목록" aria-pressed={view === "list"}
            onClick={() => setView((v) => (v === "list" ? "chat" : "list"))}><History size={16} /></button>
          <button className="icon-btn" title="새 대화" aria-label="새 대화" onClick={newChat}><SquarePen size={15} /></button>
          <button className="icon-btn" title="접기 (Ctrl+J)" aria-label="DDS Conversa 접기" onClick={() => setCollapsed(true)}><PanelRightClose size={16} /></button>
        </header>

        {view === "list" ? (
          <ConvList currentId={conv?.id ?? null} onOpen={(id) => void openConv(id)} onNew={newChat}
            onRenamed={(c) => { if (conv?.id === c.id) setConv(c); }}
            onDeleted={(id) => { if (conv?.id === id) { setConv(null); setMsgs([]); saveCurrent(userKey, null); } }} />
        ) : (
          <>
            {conv && <div className="cv-convbar" title={conv.title}><span>{conv.title}</span></div>}
            <div className="cv-body" ref={listRef}>
              {disabled ? (
                <div className="cv-empty">
                  <Sparkles size={26} />
                  <b>사내 LLM이 아직 연결되지 않았습니다</b>
                  <p>{status?.message}</p>
                  <p className="small muted">관리자: 서버 환경변수 <code>REDO_LLM_BASE_URL</code>(예: http://ollama.사내:11434)과 <code>REDO_LLM_MODEL</code>을 등록하면 바로 쓸 수 있습니다.</p>
                </div>
              ) : msgs.length === 0 ? (
                <div className="cv-empty">
                  <Sparkles size={26} />
                  <b>무엇을 도와드릴까요?</b>
                  <p>DOE 조회, 결과 입력, 추천 레시피 설명, 다음 실험 확정, 사용법 안내를 말로 요청하세요. 저장·삭제처럼 데이터가 바뀌는 일은 실행 전에 꼭 확인을 받습니다.</p>
                  <div className="cv-suggest">{suggestions(loc.pathname).map((s) => <button key={s} className="small" onClick={() => void send(s)}>{s}</button>)}</div>
                  <p className="small muted">지난 대화는 위의 <History size={12} style={{ verticalAlign: "-2px" }} /> 대화 목록에서 언제든 다시 열 수 있습니다.</p>
                </div>
              ) : msgs.map((m, i) => (
                <div key={m.id ?? `t${i}`} className={`cv-msg ${m.role} ${m.error ? "err" : ""}`}>
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
          </>
        )}
        <p className="cv-foot">사내 LLM으로만 처리 · 내 권한 안에서만 동작 · 대화는 내 계정에 저장</p>
      </aside>
      {mcp && mcpOn && <McpConnectModal onClose={() => setMcp(false)} />}
    </>
  );
}

/** 내 대화 목록: 검색, 열기, 이름 바꾸기, 삭제(한 번 더 눌러 확인) */
function ConvList({ currentId, onOpen, onNew, onRenamed, onDeleted }: {
  currentId: number | null; onOpen: (id: number) => void; onNew: () => void; onRenamed: (c: Conv) => void; onDeleted: (id: number) => void;
}) {
  const [list, setList] = useState<Conv[] | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [arm, setArm] = useState<number | null>(null); // 삭제 확인 대기
  useEffect(() => { get<Conv[]>("/api/assistant/conversations").then(setList).catch(() => setList([])); }, []);
  const shown = (list ?? []).filter((c) => !q.trim() || c.title.toLowerCase().includes(q.trim().toLowerCase()));

  const rename = async (c: Conv) => {
    const t = title.trim();
    setEditing(null);
    if (!t || t === c.title) return;
    const r = await patch<Conv>(`/api/assistant/conversations/${c.id}`, { title: t });
    setList((l) => (l ?? []).map((x) => (x.id === c.id ? r : x)));
    onRenamed(r);
  };
  const remove = async (id: number) => {
    await del(`/api/assistant/conversations/${id}`);
    setList((l) => (l ?? []).filter((x) => x.id !== id));
    setArm(null);
    onDeleted(id);
  };

  return (
    <div className="cv-list" role="region" aria-label="대화 목록">
      <div className="cv-list-top">
        <label className="cv-search"><Search size={14} />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="대화 찾기" aria-label="대화 찾기" /></label>
        <button className="small" onClick={onNew}><SquarePen size={14} />새 대화</button>
      </div>
      {list === null ? <div className="cv-list-empty"><Loader2 size={16} className="spin" /></div>
        : shown.length === 0 ? <div className="cv-list-empty">{list.length ? "찾는 대화가 없습니다." : "아직 저장된 대화가 없습니다."}</div>
        : (
          <ul>
            {shown.map((c) => (
              <li key={c.id} className={`cv-conv ${c.id === currentId ? "active" : ""}`}>
                {editing === c.id ? (
                  <input className="cv-rename" autoFocus value={title} maxLength={120} aria-label="대화 이름"
                    onChange={(e) => setTitle(e.target.value)} onBlur={() => void rename(c)}
                    onKeyDown={(e) => { if (e.key === "Enter") void rename(c); if (e.key === "Escape") setEditing(null); }} />
                ) : (
                  <button className="cv-conv-open" onClick={() => onOpen(c.id)} aria-current={c.id === currentId ? "true" : undefined}>
                    <span className="t">{c.title}</span>
                    <span className="m">{when(c.updated_at)} · 메시지 {c.message_count}</span>
                  </button>
                )}
                {editing !== c.id && (arm === c.id ? (
                  <span className="cv-conv-arm">
                    <button className="small" onClick={() => setArm(null)}>취소</button>
                    <button className="small danger-solid" onClick={() => void remove(c.id)}>삭제</button>
                  </span>
                ) : (
                  <span className="cv-conv-acts">
                    <button className="icon-btn" title="이름 바꾸기" aria-label={`${c.title} 이름 바꾸기`} onClick={() => { setEditing(c.id); setTitle(c.title); }}><Pencil size={13} /></button>
                    <button className="icon-btn" title="삭제" aria-label={`${c.title} 삭제`} onClick={() => setArm(c.id)}><Trash2 size={13} /></button>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

function PendingCard({ p, state, asking, busy, onRun, onCancel, onAck }: {
  p: Pending; state?: CardState | null; asking: boolean; busy: boolean; onRun: () => void; onCancel: () => void; onAck: () => void;
}) {
  const done: ReactNode = state === "done" ? <span className="cv-state ok"><Check size={13} />실행함</span>
    : state === "cancelled" ? <span className="cv-state">취소함</span>
    : state === "error" ? <span className="cv-state err">실행하지 못함</span>
    : state === "expired" ? <span className="cv-state">확인 시간(10분)이 지났습니다 — 필요하면 다시 요청하세요</span> : null;
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
