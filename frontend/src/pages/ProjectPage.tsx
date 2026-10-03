import { Share2, Star } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, del, get, patch } from "../api";
import { MembersShareModal } from "../components/ProjectMenu";
import GuideView from "../guide/GuideView";
import { allowedSteps, notifyProjectsChanged, resolveStep, STEPS, type Step } from "../guide/steps";
import { PROJECT_STATUS, ROLE_LABEL, when } from "../format";
import { can, ProjectContext, useProject } from "../project";
import { useToast } from "../toast";
import type { Batch, ProjectDetail } from "../types";
import WizardPage from "./WizardPage";

const ACTION: Record<string, string> = {
  "project.create": "DOE 생성", "project.update": "설정 변경", "project.duplicate": "복제", "project.delete": "삭제", "project.restore": "복구",
  "project.transfer": "소유권 이전", "member.set": "멤버 권한 변경", "member.remove": "멤버 제외", "batch.create": "실험 차수 생성",
  "batch.cancel": "실험 차수 취소", "results.save": "결과 저장", "measurement.exclude": "측정값 제외", "measurement.include": "측정값 복원",
  "share.create": "공유", "share.revoke": "공유 철회", "share.access_request": "접근 요청", "model.compare": "모델 비교",
  "data.import": "기존 데이터 가져오기", "data.export": "엑셀 다운로드", "run.delete": "런 삭제",
};

/** DOE 설정 탭: 기본 정보·인자·응답·실험 계획 (+ 상태는 아래 저장 막대에) + 변경 이력 */
function SettingsView() {
  const { project, reload } = useProject();
  const toast = useToast();
  const editor = can(project.my_role, "editor");
  const [log, setLog] = useState<{ action: string; user: string | null; detail: Record<string, unknown>; at: string }[] | null>(null);
  const setStatus = async (s: string) => { await patch(`/api/projects/${project.id}`, { status: s }); await reload(); toast("상태를 바꿨습니다."); };
  return (
    <div className="stack">
      {editor ? (
        <WizardPage key={project.id} onSaved={reload} footLeft={
          <label className="row small muted" style={{ gap: 6, flexWrap: "nowrap" }}>상태
            <select value={project.status} onChange={(e) => void setStatus(e.target.value)} aria-label="DOE 상태">
              {Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
        } />
      ) : <section className="panel"><p className="muted small">설정은 편집자 이상만 바꿀 수 있습니다. 실험은 위 탭에서 진행하세요.</p></section>}
      <details className="panel more-panel" onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && !log) get<NonNullable<typeof log>>(`/api/projects/${project.id}/audit`).then(setLog).catch(() => setLog([]));
      }}>
        <summary>변경 이력 보기</summary>
        {log === null ? <div className="busy"><span className="spinner" /> 불러오는 중</div> : (
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: "auto", marginTop: 12 }}><table>
            <tbody>{log.map((l, i) => (
              <tr key={i}><td style={{ whiteSpace: "nowrap" }}>{when(l.at)}</td><td>{l.user}</td><td>{ACTION[l.action] ?? l.action}</td>
                <td className="small muted">{(l.detail.reason as string) || ""}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </details>
    </div>
  );
}

/** DOE 탭: 설정 · ① 실험 데이터 입력 · ② 능동학습 결과. ①·② 칸은 진행 상태(완료 ✓, 남은 건수)를 함께 보여 준다 */
function ProjectTabs() {
  const { project } = useProject();
  const loc = useLocation();
  const nav = useNavigate();
  const m = loc.pathname.match(/\/step\/(\d)/);
  const onSettings = !m;
  const step: Step = resolveStep(project, m ? Number(m[1]) : undefined);
  const allowed = allowedSteps(project.my_role);
  const open = project.runs_open;
  return (
    <nav className="stepper proj-tabs" aria-label="진행 단계">
      <Link className={`ptab ${onSettings ? "on" : ""}`} to={`/projects/${project.id}`} aria-current={onSettings ? "page" : undefined}>설정</Link>
      <ol>
        {STEPS.map((s) => {
          let state = onSettings ? "" : step === 0 ? (s.n === 1 ? "now" : "todo") : s.n === step ? "now" : s.n < step ? "done" : "todo";
          if (s.n === 1 && open > 0 && project.runs_total > 0 && state !== "now") state = "partial"; // 결과가 남아 있으면 완료가 아님
          const ok = project.runs_total > 0 && allowed.includes(s.n);
          const label = project.runs_total === 0 && s.n === 1 ? "첫 DOE 생성" : s.label;
          return (
            <li key={s.n} className={state}>
              <button className="step-btn" disabled={!ok && !(s.n === 1 && project.runs_total === 0 && allowed.includes(1))}
                aria-current={state === "now" ? "step" : undefined} onClick={() => nav(`/projects/${project.id}/step/${s.n}`)}>
                <span className="num">{state === "done" ? "✓" : s.n}</span>
                <span className="txt">{label}<small>{s.n === 1 && open > 0 && project.runs_total > 0 ? `결과 ${open}건 남음` : ""}</small></span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** DOE 머리글: 경로 · 이름 · 한 줄 요약(차수·완료 실험·소유자·멤버) + 즐겨찾기 · 멤버·공유 */
function ProjectHead() {
  const { project, reload } = useProject();
  const toast = useToast();
  const [round, setRound] = useState<number | null>(null);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    get<Batch[]>(`/api/projects/${project.id}/batches`).then((bs) => setRound(bs.length ? Math.max(...bs.map((b) => b.seq)) : null)).catch(() => {});
  }, [project.id, project.runs_total]);
  const fav = async () => {
    try {
      if (project.is_favorite) await del(`/api/projects/${project.id}/favorite`);
      else await api(`/api/projects/${project.id}/favorite`, { method: "PUT" });
      await reload();
    } catch (e) { toast((e as Error).message, true); }
  };
  const meta = [
    round !== null ? `${round}차` : "실험 전",
    project.runs_total ? `실험 ${project.runs_done}/${project.runs_total}회 완료` : null,
    `소유자 ${project.owner.name}`,
    project.member_count ? `멤버 ${project.member_count}명` : null,
    project.my_role !== "owner" ? `내 권한 ${ROLE_LABEL[project.my_role]}` : null,
    project.status !== "active" ? PROJECT_STATUS[project.status] : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="proj-head">
      <div className="grow">
        <div className="crumb"><Link to="/">내 DOE</Link> / {project.name}</div>
        <h1>{project.name}</h1>
        <p className="proj-sub">{meta}</p>
      </div>
      <button className={`icon-btn ${project.is_favorite ? "on" : ""}`} onClick={() => void fav()}
        aria-label={project.is_favorite ? "즐겨찾기 해제" : "즐겨찾기 추가"} title={project.is_favorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}>
        <Star size={17} fill={project.is_favorite ? "currentColor" : "none"} />
      </button>
      <button onClick={() => setSharing(true)}><Share2 size={14} />{project.my_role === "owner" ? "멤버·공유" : "멤버 보기"}</button>
      {sharing && <MembersShareModal projectId={project.id} onClose={() => { setSharing(false); void reload(); }} />}
    </div>
  );
}

/** 프로젝트 화면: 설정 · ① 실험 데이터 입력 · ② 능동학습 결과. 그 밖의 예전 주소는 알맞은 화면으로 보낸다. */
export default function ProjectPage() {
  const { pid } = useParams();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setProject(await get<ProjectDetail>(`/api/projects/${pid}`));
      setErr(null);
      notifyProjectsChanged();
    } catch (e) { setErr((e as Error).message); }
  }, [pid]);
  useEffect(() => { setProject(null); void reload(); }, [reload]);

  if (err) return <div className="page"><div className="notice err">{err}</div></div>;
  if (!project || String(project.id) !== pid) return <div className="page"><div className="busy"><span className="spinner" /> 불러오는 중</div></div>;
  return (
    <ProjectContext.Provider value={{ project, reload }}>
      <div className="page">
        <ProjectHead />
        <ProjectTabs />
        {project.warnings.map((w) => <div key={w} className="notice warn" style={{ marginBottom: 12 }}>{w}</div>)}
        <Routes>
          <Route index element={<SettingsView />} />
          <Route path="step/:n" element={<GuideView />} />
          {["step/3", "recipe"].map((p) => <Route key={p} path={p} element={<Navigate to={`/projects/${pid}/step/2`} replace />} />)}
          {["experiments", "results", "plan"].map((p) => <Route key={p} path={p} element={<Navigate to={`/projects/${pid}/step/1`} replace />} />)}
          {["analysis", "compare"].map((p) => <Route key={p} path={p} element={<Navigate to={`/projects/${pid}/step/2`} replace />} />)}
          <Route path="recommend" element={<Navigate to={`/projects/${pid}/step/3`} replace />} />
          <Route path="*" element={<Navigate to={`/projects/${pid}`} replace />} />
        </Routes>
      </div>
    </ProjectContext.Provider>
  );
}
