import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { post } from "../api";
import { RecipeCard } from "../components/RecipeCard";
import { WhatIf } from "../components/WhatIf";
import { can, useProject } from "../project";
import { useToast } from "../toast";
import type { AnalysisResult, Prediction, Surrogate } from "../types";
import { ResponseSelect, SurrogateSelect } from "./shared";

export default function RecipeSection() {
  const { project, reload } = useProject();
  const cfg = project.config;
  const nav = useNavigate();
  const toast = useToast();
  const [rk, setRk] = useState(cfg.settings.primary_response ?? cfg.responses[0].key);
  const [sur, setSur] = useState<Surrogate>(cfg.settings.default_surrogate);
  const [res, setRes] = useState<AnalysisResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reps, setReps] = useState(3);
  const resp = cfg.responses.find((r) => r.key === rk)!;

  useEffect(() => {
    setRes(null); setErr(null);
    post<AnalysisResult>(`/api/projects/${project.id}/analysis`, { response_key: rk, surrogate: sur, validate_model: true })
      .then(setRes).catch((e: Error) => setErr(e.message));
  }, [project.id, rk, sur]);

  const predict = useCallback(async (x: Record<string, number>) =>
    (await post<Prediction[]>(`/api/projects/${project.id}/predict`, { response_key: rk, surrogate: sur, points: [x] }))[0], [project.id, rk, sur]);

  const confirmRuns = async () => {
    if (!res) return;
    try {
      await post(`/api/projects/${project.id}/batches/manual`, { points: Array.from({ length: reps }, () => res.best.x), kind: "confirmation", note: "추천 레시피 확인 실험" });
      await reload();
      toast(`확인 실험 ${reps}회를 계획했습니다.`);
      nav(`/projects/${project.id}/plan`);
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <h3>최적 레시피</h3>
          <ResponseSelect cfg={cfg} value={rk} onChange={setRk} />
          <SurrogateSelect value={sur} onChange={setSur} />
          {project.my_role === "owner" && <button className="small" onClick={() => nav(`/projects/${project.id}/share`)}>예측 결과 공유</button>}
        </div>
        {!res && !err && <div className="busy"><span className="spinner" /> 계산하는 중</div>}
        {err && <div className="notice warn">{err}</div>}
        {res && (
          <>
            {res.warnings.length > 0 && <div className="notice warn" style={{ marginBottom: 12 }}><ul>{res.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
            <RecipeCard best={res.best} factors={cfg.factors} resp={resp} tentative={res.best_is_tentative} approx={res.decomposition_is_approximate} />
            {can(project.my_role, "editor") && (
              <div className="row" style={{ marginTop: 14 }}>
                <span className="small">이 레시피를</span>
                <select value={reps} onChange={(e) => setReps(Number(e.target.value))} style={{ width: "auto" }}>{[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}회</option>)}</select>
                <span className="small">반복해서</span>
                <button className="primary" onClick={confirmRuns}>확인 실험 계획 만들기</button>
                <span className="small muted">예측대로 재현되는지, 산포가 예상만큼 작은지 확인합니다.</span>
              </div>
            )}
          </>
        )}
      </div>
      {res && (
        <div className="panel">
          <div className="panel-head"><h3>조건 시뮬레이션</h3><span className="hint">조건을 바꿔 보며 예상 결과를 확인하세요. 실험 계획에는 반영되지 않습니다.</span></div>
          <WhatIf key={`${rk}-${sur}-${res.data_hash}`} factors={cfg.factors} resp={resp} start={res.best.x} predict={predict} approx={res.decomposition_is_approximate} />
        </div>
      )}
    </div>
  );
}
