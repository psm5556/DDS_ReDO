import { BookOpen, ChevronDown, ChevronRight, Home, Inbox, LogOut, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, Search, Share2, Star, Sun, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api, del, get, post } from "../api";
import { useAuth } from "../auth";
import { useTheme } from "../theme";
import { openManual } from "../manual";
import { ROLE_LABEL } from "../format";
import { allowedSteps, autoStep, nextAction, notifyProjectsChanged, PROJECTS_CHANGED, STEPS } from "../guide/steps";
import { useToast } from "../toast";
import type { ProjectSummary, Share } from "../types";
import { ProjectMenu } from "./ProjectMenu";
import type { useSideLayout } from "./sideLayout";

type SideLayout = ReturnType<typeof useSideLayout>;

type Filter = "all" | "fav" | "shared" | "received";
const FILTERS: [Filter, string][] = [["all", "전체"], ["fav", "즐겨찾기"], ["shared", "내가 공유"], ["received", "공유받음"]];

/** 현재 주소에서 프로젝트 ID와 열려 있는 화면(설정 / 단계 / 레시피)을 읽는다 */
function useCurrent() {
  const loc = useLocation();
  const m = loc.pathname.match(/^\/projects\/(\d+)(?:\/step\/(\d))?\/?$/);
  const pidAny = loc.pathname.match(/^\/projects\/(\d+)/)?.[1];
  return {
    pid: pidAny ? Number(pidAny) : null,
    view: !m ? null : m[2] ? Number(m[2]) : "settings",
    path: loc.pathname,
  };
}

/** DOE를 펼치면 보이는 하위 메뉴: ① 실험 데이터 입력 ② 능동학습 결과(레시피 최적화·추가 DOE) */
function SubMenu({ p }: { p: ProjectSummary }) {
  const cur = useCurrent();
  const auto = autoStep(p);
  const allowed = allowedSteps(p.my_role);
  const here = cur.pid === p.id ? cur.view : null;
  const empty = p.runs_total === 0;
  return (
    <ol className="side-steps">
      {STEPS.map((s) => {
        const disabled = !allowed.includes(s.n) || (empty && s.n !== 1);
        const todo = s.n === (auto === 0 ? 1 : auto) && allowed.includes(s.n);
        const label = empty && s.n === 1 ? "첫 DOE 생성" : s.label;
        const why = empty ? "첫 DOE를 생성한 뒤 열립니다" : `${ROLE_LABEL[p.my_role]}은(는) 이 단계를 쓰지 않습니다`;
        return (
          <li key={s.n} className={`${here === s.n ? "here" : ""} ${todo ? "todo" : ""}`}>
            {disabled ? (
              <span className="side-step off" title={why}><span className="n">{s.n}</span>{label}</span>
            ) : (
              <Link className="side-step" to={`/projects/${p.id}/step/${s.n}`} aria-current={here === s.n ? "page" : undefined}>
                <span className="n">{s.n}</span>{label}{todo && <em className="todo-tag">할 일</em>}
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Item({ p, onFav }: { p: ProjectSummary; onFav: (p: ProjectSummary) => void }) {
  const cur = useCurrent();
  const active = cur.pid === p.id;
  const [open, setOpen] = useState(active);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { if (active) setOpen(true); }, [active]);
  const a = nextAction(p);
  const closeMenu = useCallback(() => setMenu(null), []);
  return (
    <div className={`side-item ${active ? "active" : ""} ${p.status === "archived" ? "dim" : ""}`}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
      <div className="side-row">
        <button className="side-caret" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${p.name} 단계 ${open ? "접기" : "펼치기"}`}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        <i className={`side-dot ${a.mine ? "todo" : ""}`} aria-hidden="true" />
        <NavLink to={`/projects/${p.id}`} className="side-name" end title="DOE 설정 열기">{p.name}</NavLink>
        {p.is_favorite && <Star size={13} className="side-fav" fill="currentColor" aria-label="즐겨찾기" />}
        <button className="side-more" aria-label={`${p.name} 메뉴`} aria-haspopup="menu" title="멤버·공유, 즐겨찾기, 복제, 삭제"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); }}>
          <MoreHorizontal size={16} />
        </button>
      </div>
      {(p.my_role !== "owner" || p.active_shares > 0 || p.member_count > 0) && (
        <div className="side-marks">
          {p.my_role !== "owner" && <span className={`mark role-${p.my_role}`} title="내 권한">{ROLE_LABEL[p.my_role]} · {p.owner.name}</span>}
          {p.active_shares > 0 && <span className="mark share" title="이 DOE의 예측을 다른 사람에게 공유 중"><Share2 size={11} />공유 {p.active_shares}</span>}
          {p.member_count > 0 && <span className="mark" title="함께하는 멤버 수 (소유자 제외)"><Users size={11} />멤버 {p.member_count}</span>}
        </div>
      )}
      <div className={`side-next ${a.mine ? "mine" : ""}`}>{a.mine && <i className="dot" aria-hidden="true" />}{a.text}</div>
      {open && <SubMenu p={p} />}
      {menu && <ProjectMenu p={p} at={menu} onClose={closeMenu} onFav={onFav} />}
    </div>
  );
}

function ReceivedItem({ s }: { s: Share }) {
  return (
    <div className="side-item">
      <div className="side-row">
        <span className="side-caret" aria-hidden="true" />
        <Inbox size={13} className="side-dot" style={{ background: "none", width: 13, height: 13, color: "var(--ink-4)" }} />
        <NavLink to={`/shared/${s.token}`} className="side-name">{s.project_name}</NavLink>
      </div>
      <div className="side-marks">
        <span className="mark received">공유받음</span>
        <span className="mark">{s.permission === "view_simulate" ? "보기+시뮬레이션" : "보기만"}</span>
        <span className="mark">{s.mode === "snapshot" ? "스냅샷" : "실시간"}</span>
        {s.surrogate === "tabpfn" && <span className="mark warn">평가용</span>}
      </div>
      <div className="side-next">{s.created_by}님이 공유</div>
    </div>
  );
}

/** 왼쪽 사이드바: DOE 목록(검색·즐겨찾기·공유·권한 표식). 이름 = 설정, 펼치면 단계, ⋯/우클릭 = 멤버·공유 등 */
export function ProjectSidebar({ layout }: { layout?: SideLayout }) {
  const [mine, setMine] = useState<ProjectSummary[] | null>(null);
  const [member, setMember] = useState<ProjectSummary[]>([]);
  const [received, setReceived] = useState<Share[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState(false); // 좁은 화면에서 목록 펼치기
  const cur = useCurrent();
  const toast = useToast();
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const { theme, toggle: toggleTheme } = useTheme();
  const themeLabel = theme === "dark" ? "밝은 화면으로" : "어두운 화면으로";

  const load = useCallback(async () => {
    const qs = encodeURIComponent(q);
    const [a, b, c] = await Promise.all([
      get<ProjectSummary[]>(`/api/projects?scope=mine&q=${qs}`),
      get<ProjectSummary[]>(`/api/projects?scope=member&q=${qs}`),
      get<Share[]>("/api/shares/received").catch(() => [] as Share[]),
    ]);
    setMine(a); setMember(b); setReceived(c);
  }, [q]);

  useEffect(() => { const t = setTimeout(() => void load().catch(() => {}), 150); return () => clearTimeout(t); }, [load]);
  useEffect(() => {
    const h = () => void load().catch(() => {});
    window.addEventListener(PROJECTS_CHANGED, h);
    return () => window.removeEventListener(PROJECTS_CHANGED, h);
  }, [load]);
  useEffect(() => { setOpen(false); }, [cur.path]);

  const toggleFav = async (p: ProjectSummary) => {
    const flip = (xs: ProjectSummary[]) => xs.map((x) => (x.id === p.id ? { ...x, is_favorite: !p.is_favorite } : x));
    setMine((xs) => (xs ? flip(xs) : xs)); setMember(flip);
    try {
      if (p.is_favorite) await del(`/api/projects/${p.id}/favorite`);
      else await api(`/api/projects/${p.id}/favorite`, { method: "PUT" });
      notifyProjectsChanged();
    } catch (e) { toast((e as Error).message, true); void load(); }
  };

  const term = q.trim().toLowerCase();
  const all = [...(mine ?? []), ...member];
  const favs = all.filter((p) => p.is_favorite);
  const recv = received.filter((s) => !term || s.project_name.toLowerCase().includes(term));
  const show = (xs: ProjectSummary[]) =>
    filter === "fav" ? xs.filter((p) => p.is_favorite) : filter === "shared" ? xs.filter((p) => p.active_shares > 0)
      : xs.filter((p) => !p.is_favorite); // '전체'에서는 즐겨찾기 묶음에만 표시
  const current = all.find((p) => p.id === cur.pid);
  const group = (title: string, xs: ProjectSummary[], empty?: string) => (xs.length > 0 || empty) && (
    <div className="side-group">
      <h4>{title} <span className="count">{xs.length}</span></h4>
      {xs.length ? xs.map((p) => <Item key={p.id} p={p} onFav={toggleFav} />) : <p className="small muted" style={{ padding: "0 8px" }}>{empty}</p>}
    </div>
  );

  // 접힌 사이드바: 아이콘만 (펼치기 · 홈 · 새 DOE · 사용자)
  if (layout?.collapsed) {
    return (
      <aside className="sidebar rail" aria-label="DOE 목록 (접힘)">
        <button className="icon-btn rail-btn" onClick={layout.toggle} aria-label="사이드바 펼치기" title="사이드바 펼치기 (Ctrl+B)"><PanelLeftOpen size={18} /></button>
        <Link className="icon-btn rail-btn" to="/" aria-label="첫 화면" title="첫 화면"><Home size={18} /></Link>
        <Link className="icon-btn rail-btn primary" to="/new" aria-label="새 DOE 만들기" title="새 DOE 만들기"><Plus size={18} /></Link>
        <span className="grow" />
        <button className="icon-btn rail-btn" onClick={() => openManual()} aria-label="사용 매뉴얼" title="사용 매뉴얼 (새 창)"><BookOpen size={18} /></button>
        <button className="icon-btn rail-btn" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}>{theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}</button>
        {user && <span className="avatar rail-me" title={`${user.name} · ${user.department}`}>{user.name.slice(0, 1)}</span>}
      </aside>
    );
  }

  // 오른쪽 가장자리를 끌어 너비 조절 (두 번 누르면 기본 너비)
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!layout) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = layout.width;
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => layout.setWidth(w0 + ev.clientX - x0);
    const up = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside className={`sidebar ${open ? "open" : ""}`} aria-label="DOE 목록">
      <button className="side-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{current ? current.name : "DOE 목록"}</span><span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      <div className="side-brand-row">
        <Link to="/" className="side-brand" aria-label="DDS ReDO 홈"><span className="logo" aria-hidden="true">Re</span>DDS ReDO<small>레시피 최적화</small></Link>
        {layout && <button className="icon-btn side-fold" onClick={layout.toggle} aria-label="사이드바 접기" title="사이드바 접기 (Ctrl+B)"><PanelLeftClose size={17} /></button>}
      </div>
      <div className="side-body">
        <Link className="btn primary side-new" to="/new"><Plus size={15} />새 DOE 만들기</Link>
        <div className="side-search">
          <Search size={14} />
          <input type="search" placeholder="DOE 이름·설명 검색" value={q} onChange={(e) => setQ(e.target.value)} aria-label="DOE 검색" />
        </div>
        <div className="side-filters" role="tablist" aria-label="목록 필터">
          {FILTERS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
              {k === "fav" && <Star size={11} fill={filter === k ? "currentColor" : "none"} />}{l}</button>
          ))}
        </div>
        {mine === null ? <p className="small muted">불러오는 중</p> : filter === "received" ? (
          <div className="side-group">
            <h4>공유받은 예측 <span className="count">{recv.length}</span></h4>
            {recv.length ? recv.map((s) => <ReceivedItem key={s.id} s={s} />) : <p className="small muted" style={{ padding: "0 8px" }}>공유받은 예측이 없습니다.</p>}
          </div>
        ) : (
          <>
            {filter === "all" && group("즐겨찾기", favs)}
            {group("내가 만든 DOE", show(mine), filter !== "all" ? (show(mine).length + show(member).length === 0 ? "해당하는 DOE가 없습니다." : undefined)
              : all.length + recv.length > 0 ? undefined : term ? "검색 결과가 없습니다." : "아직 없습니다. 위 버튼으로 시작하세요.")}
            {group("함께하는 DOE", show(member))}
            {filter === "all" && recv.length > 0 && (
              <div className="side-group">
                <h4>공유받은 예측 <span className="count">{recv.length}</span></h4>
                {recv.map((s) => <ReceivedItem key={s.id} s={s} />)}
              </div>
            )}
          </>
        )}
      </div>
      {user && (
        <div className="side-me">
          <span className="avatar" aria-hidden="true">{user.name.slice(0, 1)}</span>
          <span className="who"><b>{user.name}</b><small>{user.department} · {user.business_unit}</small></span>
          <button className="icon-btn" onClick={() => openManual()} aria-label="사용 매뉴얼" title="사용 매뉴얼 (새 창)"><BookOpen size={15} /></button>
          <button className="icon-btn" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}>{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}</button>
          <button className="icon-btn" title="로그아웃" aria-label="로그아웃"
            onClick={async () => { await post("/api/auth/logout").catch(() => {}); await refresh(); nav("/login"); }}>
            <LogOut size={15} />
          </button>
        </div>
      )}
      {layout && (
        <div className="side-resizer" role="separator" aria-orientation="vertical" aria-label="사이드바 너비 조절"
          aria-valuenow={layout.width} aria-valuemin={200} aria-valuemax={480} tabIndex={0} title="끌어서 너비 조절 · 두 번 누르면 기본 너비"
          onPointerDown={startResize} onDoubleClick={() => layout.setWidth(264)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") { e.preventDefault(); layout.setWidth(layout.width - 16); }
            if (e.key === "ArrowRight") { e.preventDefault(); layout.setWidth(layout.width + 16); }
          }} />
      )}
    </aside>
  );
}
