import { useCallback, useEffect, useState } from "react";
import { post } from "../api";
import { EffectsPlots, TwinMaps } from "../components/Maps";
import { useProject } from "../project";
import type { AnalysisResult, Effect, Surface, Surrogate } from "../types";
import { ReliabilityChip, ResponseSelect } from "./shared";

export default function AnalysisSection() {
  const { project } = useProject();
  const cfg = project.config;
  const [rk, setRk] = useState(cfg.settings.primary_response ?? cfg.responses[0].key);
  const sur: Surrogate = cfg.settings.default_surrogate;
  const [res, setRes] = useState<AnalysisResult | null>(null);
  const [effects, setEffects] = useState<Effect[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const resp = cfg.responses.find((r) => r.key === rk)!;

  const run = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const a = await post<AnalysisResult>(`/api/projects/${project.id}/analysis`, { response_key: rk, surrogate: sur, validate_model: false });
      setRes(a);
      setEffects(await post<Effect[]>(`/api/projects/${project.id}/effects?response_key=${rk}&surrogate=${sur}`, { points: [a.best.x] }));
    } catch (e) { setErr((e as Error).message); setRes(null); } finally { setBusy(false); }
  }, [project.id, rk, sur]);
  useEffect(() => { void run(); }, [run]);

  const load = useCallback((x: string, y: string, fixed: Record<string, number>) =>
    post<Surface>(`/api/projects/${project.id}/surface`, { response_key: rk, surrogate: sur, x_factor: x, y_factor: y, fixed, resolution: 36 }), [project.id, rk, sur]);

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <h3>분석</h3>
          <ResponseSelect cfg={cfg} value={rk} onChange={setRk} />
          <button className="small" disabled={busy} onClick={run}>다시 계산</button>
        </div>
        {busy && <div className="busy"><span className="spinner" /> 모델을 만들고 검증하는 중</div>}
        {err && <div className="notice warn">{err}</div>}
        {res && (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="chip">실험점 {res.data.n_points}개 · 측정 {res.data.n_obs}회</span>
              <span className="chip">반복 측정 조건 {res.data.n_replicated_points}개</span>
              <ReliabilityChip v={res.variance_reliability} />
              {res.surrogate === "tabpfn" && <span className="chip exp">TabPFN 평가용</span>}
              {!!res.pending_runs && <span className="chip">결과 대기 {res.pending_runs}건 (분석에서 제외)</span>}
            </div>
            {res.warnings.length > 0 && <div className="notice warn" style={{ marginBottom: 12 }}><ul>{res.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          </>
        )}
      </div>

      {res && (
        <div className="panel">
          <div className="panel-head"><h3>평균과 산포 지도</h3><span className="hint">평균이 좋아도 산포가 큰 영역은 양산에서 흔들립니다.</span></div>
          <TwinMaps key={`${rk}-${sur}-${res.data_hash}`} factors={cfg.factors} resp={resp} load={load} initialFixed={res.best.x} />
        </div>
      )}

      {res && effects && (
        <div className="panel">
          <div className="panel-head"><h3>인자별 영향</h3><span className="hint">추천 레시피에서 한 인자만 바꿨을 때의 변화. 청록 = 평균, 보라 = 산포, 회색 점선 = 평균의 불확실성</span></div>
          <EffectsPlots effects={effects} resp={resp} />
        </div>
      )}

    </div>
  );
}
