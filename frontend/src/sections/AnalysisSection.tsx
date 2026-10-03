import { useCallback, useEffect, useState } from "react";
import { post } from "../api";
import { EffectsPlots, TwinMaps } from "../components/Maps";
import { baseLayout, COLORS, Plot, plotConfig } from "../components/Plot";
import { fmt, pct } from "../format";
import { usePrefs } from "../prefs";
import { useProject } from "../project";
import type { AnalysisResult, Effect, Surface, Surrogate } from "../types";
import { ReliabilityChip, ResponseSelect, SurrogateSelect } from "./shared";

export default function AnalysisSection() {
  const { project } = useProject();
  const { expert } = usePrefs();
  const cfg = project.config;
  const [rk, setRk] = useState(cfg.settings.primary_response ?? cfg.responses[0].key);
  const [sur, setSur] = useState<Surrogate>(cfg.settings.default_surrogate);
  const [res, setRes] = useState<AnalysisResult | null>(null);
  const [effects, setEffects] = useState<Effect[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const resp = cfg.responses.find((r) => r.key === rk)!;

  const run = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const a = await post<AnalysisResult>(`/api/projects/${project.id}/analysis`, { response_key: rk, surrogate: sur, validate_model: true });
      setRes(a);
      setEffects(await post<Effect[]>(`/api/projects/${project.id}/effects?response_key=${rk}&surrogate=${sur}`, { points: [a.best.x] }));
    } catch (e) { setErr((e as Error).message); setRes(null); } finally { setBusy(false); }
  }, [project.id, rk, sur]);
  useEffect(() => { void run(); }, [run]);

  const load = useCallback((x: string, y: string, fixed: Record<string, number>) =>
    post<Surface>(`/api/projects/${project.id}/surface`, { response_key: rk, surrogate: sur, x_factor: x, y_factor: y, fixed, resolution: 36 }), [project.id, rk, sur]);

  const v = res?.validation;
  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <h3>분석</h3>
          <ResponseSelect cfg={cfg} value={rk} onChange={setRk} />
          <SurrogateSelect value={sur} onChange={setSur} />
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
            {expert && v?.available && (
              <div className="metrics" style={{ marginBottom: 12 }}>
                <div className="metric"><div className="metric-label">예측 오차 RMSE ({v.method})</div><div className="metric-value">{fmt(v.rmse)}</div><div className="metric-sub">응답 변동 대비 {pct(v.rmse_relative)}</div></div>
                <div className="metric"><div className="metric-label">95% 구간 포함률</div><div className="metric-value">{pct(v.coverage95)}</div><div className="metric-sub">80~100%면 적정</div></div>
                <div className="metric"><div className="metric-label">CRPS</div><div className="metric-value">{fmt(v.crps)}</div><div className="metric-sub">낮을수록 좋음</div></div>
                <div className="metric"><div className="metric-label">계산 시간</div><div className="metric-value">{res.elapsed_sec}s</div><div className="metric-sub">{res.surrogate_version}</div></div>
              </div>
            )}
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

      {expert && v?.available && v.observed && v.predicted && (
        <div className="panel">
          <div className="panel-head"><h3>교차검증: 실측 vs 예측</h3><span className="hint">각 실험점을 빼고 만든 모델로 그 점을 예측한 결과</span></div>
          <Plot data={[
            { x: v.observed, y: v.predicted, type: "scatter", mode: "markers", marker: { color: COLORS.mean, size: 8 }, name: "실험점" },
            { x: [Math.min(...v.observed), Math.max(...v.observed)], y: [Math.min(...v.observed), Math.max(...v.observed)], type: "scatter", mode: "lines", line: { color: COLORS.epi, dash: "dot" }, name: "y = x" },
          ] as object[]} layout={{ ...baseLayout, height: 320, showlegend: false, xaxis: { title: { text: "실측 평균" } }, yaxis: { title: { text: "LOO 예측" } } }}
            config={plotConfig} style={{ width: "100%", maxWidth: 520 }} useResizeHandler />
        </div>
      )}
    </div>
  );
}
