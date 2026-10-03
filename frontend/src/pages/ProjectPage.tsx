import { Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { get, patch } from "../api";
import GuideView from "../guide/GuideView";
import { notifyProjectsChanged } from "../guide/steps";
import { PROJECT_STATUS, ROLE_LABEL, when } from "../format";
import { can, ProjectContext, useProject } from "../project";
import { useToast } from "../toast";
import type { ProjectDetail } from "../types";
import WizardPage from "./WizardPage";

const ACTION: Record<string, string> = {
  "project.create": "DOE 생성", "project.update": "설정 변경", "project.duplicate": "복제", "project.delete": "삭제", "project.restore": "복구",
  "project.transfer": "소유권 이전", "member.set": "멤버 권한 변경", "member.remove": "멤버 제외", "batch.create": "실험 차수 생성",
  "batch.cancel": "실험 차수 취소", "results.save": "결과 저장", "measurement.exclude": "측정값 제외", "measurement.include": "측정값 복원",
  "share.create": "공유", "share.revoke": "공유 철회", "share.access_request": "접근 요청", "model.compare": "모델 비교",
};

/** DOE 설정 (사이드바에서 DOE 이름을 누르면 열림): 기본 정보·인자·응답·실험 계획 설정 + 상태 + 변경 이력 */
function SettingsView() {
  const { project, reload } = useProject();
  const toast = useToast();
  const editor = can(project.my_role, "editor");
  const [log, setLog] = useState<{ action: string; user: string | null; detail: Record<string, unknown>; at: string }[] | null>(null);
  const setStatus = async (s: string) => { await patch(`/api/projects/${project.id}`, { status: s }); await reload(); toast("상태를 바꿨습니다."); };
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <h3><Settings size={16} style={{ verticalAlign: "-2px", marginRight: 6 }} />DOE 설정</h3>
          {editor && (
            <label className="row small" style={{ gap: 6 }}>상태
              <select value={project.status} onChange={(e) => void setStatus(e.target.value)} style={{ width: "auto" }}>
                {Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></label>
          )}
        </div>
        {editor ? <WizardPage key={project.id} onSaved={reload} />
          : <p className="muted small">설정은 편집자 이상만 바꿀 수 있습니다. 실험은 왼쪽 메뉴의 단계에서 진행하세요.</p>}
      </section>
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

/** 프로젝트 화면: DOE 설정(기본) · ① 실험 데이터 입력 · ② 능동학습 결과. 그 밖의 예전 주소는 알맞은 화면으로 보낸다. */
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
        <div className="page-head">
          <div className="grow">
            <h1>{project.name}</h1>
            <p className="small">
              소유자 {project.owner.name} ({project.owner.department}) · {PROJECT_STATUS[project.status]} · 내 권한: {ROLE_LABEL[project.my_role]}
            </p>
          </div>
        </div>
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
