import { ArrowRight, ClipboardPaste, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { get } from "../api";
import { useAuth } from "../auth";
import { nextAction, PROJECTS_CHANGED } from "../guide/steps";
import { PROJECT_STATUS, ROLE_LABEL } from "../format";
import type { ProjectSummary } from "../types";

/** 첫 화면: 내 DOE 한눈에 보기 — 인사 + 지금 할 일 요약 + DOE 카드(진행 막대·다음에 할 일). 카드를 누르면 할 일 단계로 바로 간다 */
export default function DashboardPage() {
  const { user } = useAuth();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  useEffect(() => {
    const load = () => Promise.all([
      get<ProjectSummary[]>("/api/projects?scope=mine"),
      get<ProjectSummary[]>("/api/projects?scope=member"),
    ]).then(([a, b]) => setList([...a, ...b].sort((x, y) => y.updated_at.localeCompare(x.updated_at)))).catch(() => setList([]));
    void load();
    window.addEventListener(PROJECTS_CHANGED, load);
    return () => window.removeEventListener(PROJECTS_CHANGED, load);
  }, []);

  const live = (list ?? []).filter((p) => p.status !== "archived");
  const acts = live.map((p) => ({ p, a: nextAction(p) }));
  const todo = acts.filter((x) => x.a.mine);
  const waiting = acts.filter((x) => x.a.mine && x.a.step === 1).reduce((n, x) => n + x.p.runs_open, 0);
  const ready = acts.filter((x) => x.a.mine && x.a.step === 2).length;

  return (
    <div className="page">
      <div className="home-head">
        <div className="grow">
          <h1>안녕하세요, {user?.name ?? ""}님</h1>
          <div className="todo-pills">
            <span>지금 할 일<b>{todo.length}건</b></span>
            {waiting > 0 && <span>결과 입력 대기<b>{waiting}</b></span>}
            {ready > 0 && <span>새 추천 준비됨<b>{ready}</b></span>}
          </div>
        </div>
        <Link className="btn" to="/new?from=data"><ClipboardPaste size={15} />기존 데이터로 시작</Link>
        <Link className="btn primary" to="/new"><Plus size={15} />새 DOE</Link>
      </div>

      {list === null ? <div className="busy" style={{ marginTop: 24 }}><span className="spinner" /> 불러오는 중</div> : (
        <div className="doe-cards">
          {acts.map(({ p, a }) => {
            const step = a.step === 0 ? 1 : a.step;
            const done = p.runs_total ? Math.round((p.runs_done / p.runs_total) * 100) : 0;
            const who = [p.my_role === "owner" ? p.owner.name : `${ROLE_LABEL[p.my_role]} · ${p.owner.name}`,
              p.active_shares ? `공유 ${p.active_shares}` : null, p.member_count ? `멤버 ${p.member_count}` : null].filter(Boolean).join(" · ");
            return (
              <Link key={p.id} className="doe-card" to={`/projects/${p.id}/step/${step}`} aria-label={`${p.name} 열기`}>
                <div className="t"><b>{p.name}</b>{p.status !== "active" && <span className="chip">{PROJECT_STATUS[p.status]}</span>}</div>
                <div className="who">{who}</div>
                <div className="bar" aria-hidden="true"><i style={{ width: `${done}%` }} /></div>
                <div className="pl"><span>{p.runs_total ? `실험 ${p.runs_done} / ${p.runs_total} 완료` : "아직 실험 없음"}</span></div>
                <div className={`next ${a.mine ? "mine" : ""}`}><i className="dot" aria-hidden="true" />{a.text}<ArrowRight size={15} /></div>
              </Link>
            );
          })}
          <Link className="doe-card blank" to="/new">
            <b><Plus size={16} />새 DOE 만들기</b>
            <span>처음부터 설계하거나, 기존 실험 데이터로 시작</span>
          </Link>
        </div>
      )}
    </div>
  );
}
