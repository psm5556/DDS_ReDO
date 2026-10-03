import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { get, post } from "../api";
import { GOAL_LABEL, MODE_LABEL, OBJ_LABEL, when } from "../format";
import { can, useProject } from "../project";
import { useToast } from "../toast";
import type { Batch } from "../types";

const KIND: Record<string, string> = { initial: "초기 설계", active: "능동학습 제안", manual: "직접 추가", confirmation: "확인 실험" };

export default function OverviewSection() {
  const { project, reload } = useProject();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  const cfg = project.config;
  const st = cfg.settings;
  const role = project.my_role;
  useEffect(() => { get<Batch[]>(`/api/projects/${project.id}/batches`).then(setBatches).catch(() => {}); }, [project.id, project.runs_total]);

  const d = cfg.factors.length;
  const initPts = st.initial_points ?? Math.max(2 * d + 2, 10);
  const rep = Math.round(st.replicate_fraction * initPts);
  const initRuns = initPts - rep + rep * st.replicates_per_point;
  const primary = cfg.responses.find((r) => r.key === st.primary_response) ?? cfg.responses[0];
  const budgetPct = Math.min(100, (project.runs_done / Math.max(st.budget_runs, 1)) * 100);

  const makeInitial = async () => {
    setBusy(true);
    try {
      await post(`/api/projects/${project.id}/design/initial`, { seed: Math.floor(Math.random() * 1000) });
      await reload();
      toast("초기 실험 계획을 만들었습니다.");
      nav(`/projects/${project.id}/plan`);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  let next: React.ReactNode;
  if (project.runs_total === 0) {
    next = (
      <>
        <h3>첫 단계: 초기 실험 계획 만들기</h3>
        <p className="muted" style={{ margin: "6px 0 14px" }}>
          인자 공간 전체를 고르게 살펴보는 {initPts}개 조건, 총 {initRuns}회 실험을 만듭니다. 이 중 {rep}개 조건은 산포 추정을 위해 {st.replicates_per_point}회씩 반복합니다.
          실행 순서는 무작위로 섞입니다.
        </p>
        {can(role, "editor") ? <button className="primary big" disabled={busy} onClick={makeInitial}>{busy ? "만드는 중" : "초기 실험 계획 만들기"}</button>
          : <p className="small muted">편집자 이상이 초기 실험 계획을 만들 수 있습니다.</p>}
      </>
    );
  } else if (project.runs_open > 0) {
    next = (
      <>
        <h3>결과 입력을 기다리는 실험 {project.runs_open}건</h3>
        <p className="muted" style={{ margin: "6px 0 14px" }}>
          실험을 마친 런부터 결과를 입력하세요. 일부만 입력해도 분석과 다음 제안을 받을 수 있습니다.
        </p>
        <div className="row">
          {can(role, "runner") && <Link className="btn primary big" to={`/projects/${project.id}/results`}>결과 입력하기</Link>}
          <Link className="btn" to={`/projects/${project.id}/plan`}>실험 시트 보기·인쇄</Link>
        </div>
      </>
    );
  } else {
    next = (
      <>
        <h3>모든 실험 결과가 입력되었습니다</h3>
        <p className="muted" style={{ margin: "6px 0 14px" }}>지금까지의 결과로 다음에 해볼 조건을 제안받거나, 현재 최적 레시피를 확인하세요.</p>
        <div className="row">
          {can(role, "editor") && <Link className="btn primary big" to={`/projects/${project.id}/recommend`}>다음 실험 제안 받기</Link>}
          <Link className="btn" to={`/projects/${project.id}/recipe`}>최적 레시피 보기</Link>
        </div>
      </>
    );
  }

  return (
    <div className="stack">
      <section className="panel">{next}</section>
      <section className="grid-2">
        <div className="panel">
          <div className="panel-head"><h3>진행 상황</h3></div>
          <div className="metrics">
            <div className="metric"><div className="metric-label">완료한 실험</div><div className="metric-value">{project.runs_done}</div><div className="metric-sub">예산 {st.budget_runs}회 중</div></div>
            <div className="metric"><div className="metric-label">남은 실험</div><div className="metric-value">{project.runs_open}</div></div>
            <div className="metric"><div className="metric-label">배치</div><div className="metric-value">{project.batches}</div></div>
          </div>
          <div className="progress" style={{ marginTop: 12 }}><span className="d" style={{ width: `${budgetPct}%` }} /></div>
          {project.runs_done >= st.budget_runs && <div className="notice warn" style={{ marginTop: 10 }}>실험 예산을 모두 사용했습니다. 최적 레시피를 확인하고 확인 실험을 진행하세요.</div>}
        </div>
        <div className="panel">
          <div className="panel-head"><h3>목표</h3>{can(role, "editor") && <Link className="small" to={`/projects/${project.id}/settings`}>설정 변경</Link>}</div>
          <p><b>{primary.name}</b> · {GOAL_LABEL[primary.goal]}{primary.goal === "target" ? ` ${primary.target}${primary.unit}` : ""}</p>
          {(primary.lsl != null || primary.usl != null) && <p className="small muted">규격 {primary.lsl ?? "–"} ~ {primary.usl ?? "–"} {primary.unit}</p>}
          <p className="small" style={{ marginTop: 8 }}>{MODE_LABEL[st.mode]}{st.mode === "robust" ? ` · ${OBJ_LABEL[st.robust_objective]}` : ""}</p>
          <p className="small muted" style={{ marginTop: 8 }}>인자: {cfg.factors.map((f) => `${f.name} ${f.low}~${f.high}${f.unit}`).join(" · ")}</p>
          {project.description && <p className="small" style={{ marginTop: 8 }}>{project.description}</p>}
        </div>
      </section>
      {batches.length > 0 && (
        <section className="panel">
          <div className="panel-head"><h3>배치 이력</h3></div>
          <div className="table-wrap"><table>
            <thead><tr><th>배치</th><th>종류</th><th>모델</th><th className="r">진행</th><th>만든 사람</th><th>만든 때</th></tr></thead>
            <tbody>{batches.map((b) => (
              <tr key={b.id}><td>{b.seq}차</td><td>{KIND[b.kind] ?? b.kind}</td>
                <td>{b.surrogate ? (b.surrogate === "gp" ? "GP" : <span className="chip exp">TabPFN</span>) : "–"}</td>
                <td className="r">{b.runs_done}/{b.runs_total}</td><td>{b.created_by}</td><td>{when(b.created_at)}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
    </div>
  );
}
