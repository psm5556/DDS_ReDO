import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { post } from "../api";
import { fmtFactor, fmtResp, MODE_LABEL, OBJ_LABEL, pct, snap } from "../format";
import { useProject } from "../project";
import { useToast } from "../toast";
import type { Proposal, RecommendResult, Surrogate } from "../types";
import { SurrogateSelect } from "./shared";

const TYPE_LABEL: Record<string, string> = { exploit: "유망 영역 확인", explore: "탐색", replicate: "반복 측정" };

export default function RecommendSection() {
  const { project, reload } = useProject();
  const cfg = project.config;
  const st = cfg.settings;
  const nav = useNavigate();
  const toast = useToast();
  const [sur, setSur] = useState<Surrogate>(st.default_surrogate);
  const [mode, setMode] = useState(st.mode);
  const [obj, setObj] = useState(st.robust_objective);
  const [q, setQ] = useState(st.batch_size);
  const [res, setRes] = useState<RecommendResult | null>(null);
  const [items, setItems] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const resp = cfg.responses.find((r) => r.key === st.primary_response) ?? cfg.responses[0];
  const hasSpec = resp.lsl != null || resp.usl != null;

  const propose = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post<RecommendResult>(`/api/projects/${project.id}/recommend`, {
        surrogate: sur, batch_size: q, mode, robust_objective: obj, seed: Math.floor(Math.random() * 10000),
      });
      setRes(r); setItems(r.proposals);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const accept = async () => {
    if (!res) return;
    try {
      await post(`/api/projects/${project.id}/batches/accept`, {
        proposals: items, surrogate: res.surrogate, surrogate_version: res.surrogate_version,
        acquisition: { objective: res.objective, mode: res.mode, pool_size: res.pool_size },
      });
      await reload();
      toast(`${items.length}개 실험을 새 배치로 만들었습니다.`);
      nav(`/projects/${project.id}/plan`);
    } catch (e) { toast((e as Error).message, true); }
  };
  const edit = (i: number, key: string, v: string) => setItems(items.map((p, j) => (j === i ? { ...p, x: { ...p.x, [key]: Number(v) } } : p)));

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head"><h3>다음 실험 제안</h3><SurrogateSelect value={sur} onChange={setSur} /></div>
        <p className="muted small" style={{ marginBottom: 12 }}>
          지금까지의 결과로 다음에 해볼 조건을 고릅니다. 좋은 결과가 예상되는 조건(확인)과 아직 모르는 영역(탐색), 산포가 불확실한 조건의 반복 측정을 균형 있게 섞습니다.
          결과를 기다리는 런이 있어도 제안받을 수 있으며, 그 런과 겹치지 않게 고릅니다.
        </p>
        <div className="row">
          <label className="field" style={{ minWidth: 220 }}><span className="lbl">최적화 방식</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          {mode === "robust" && (
            <label className="field" style={{ minWidth: 220 }}><span className="lbl">강건 기준</span>
              <select value={obj} onChange={(e) => setObj(e.target.value as typeof obj)}>
                {Object.entries(OBJ_LABEL).map(([k, v]) => <option key={k} value={k} disabled={k === "spec_prob" && !hasSpec}>{v}</option>)}
              </select></label>
          )}
          <label className="field" style={{ width: 140 }}><span className="lbl">제안 개수</span>
            <input type="number" min={1} max={12} value={q} onChange={(e) => setQ(Math.max(1, Math.min(12, Number(e.target.value))))} /></label>
          <button className="primary big" style={{ alignSelf: "flex-end" }} disabled={busy} onClick={propose}>{busy ? "계산 중" : res ? "다시 제안받기" : "다음 실험 제안 받기"}</button>
        </div>
        {busy && <div className="busy"><span className="spinner" /> 후보 수천 개를 평가하는 중입니다. 몇 초 걸립니다.</div>}
        {err && <div className="notice warn" style={{ marginTop: 12 }}>{err}</div>}
      </div>

      {res && (
        <div className="panel">
          <div className="panel-head">
            <h3>제안된 실험 {items.length}개</h3>
            <span className="hint">기준: {res.objective} · 후보 {res.pool_size.toLocaleString()}개 평가 · {res.elapsed_sec}초</span>
          </div>
          {res.notes.map((n) => <div key={n} className="notice info" style={{ marginBottom: 8 }}>{n}</div>)}
          {res.decomposition_is_approximate && <div className="notice warn" style={{ marginBottom: 8 }}>TabPFN 제안은 평가용입니다. 산포와 불확실성의 구분이 근사값이며, 실제 공정 조건 결정에 단독으로 쓰지 마세요.</div>}
          <div className="proposals">
            {items.map((p, i) => (
              <article key={i} className={`proposal ${p.reason_type}`}>
                <div className="row">
                  <b style={{ flex: 1 }}>제안 {i + 1}</b>
                  <span className={`chip ${p.kind === "replicate" ? "sigma" : p.reason_type === "exploit" ? "mean" : ""}`}>{TYPE_LABEL[p.reason_type]}</span>
                  <button className="ghost small" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label={`제안 ${i + 1} 빼기`}>빼기</button>
                </div>
                <div className="cond">
                  {cfg.factors.map((f) => (
                    <label key={f.key}>{f.name} <span className="muted">{f.unit}</span>
                      <input type="number" step={f.step} min={f.low} max={f.high} value={p.x[f.key]}
                        onChange={(e) => edit(i, f.key, e.target.value)} onBlur={(e) => edit(i, f.key, String(snap(Number(e.target.value), f)))} />
                    </label>
                  ))}
                </div>
                <p className="why">{p.reason}</p>
                <div className="pred">
                  <span className="m">μ {fmtResp(p.mean, resp)} <span className="muted">({fmtResp(p.mean_lo, resp)}~{fmtResp(p.mean_hi, resp)})</span></span>
                  <span className="s">σ {fmtResp(p.sigma, resp)}</span>
                  {p.spec_prob !== null && <span>규격 {pct(p.spec_prob)}</span>}
                </div>
                {p.extrapolation && <span className="chip warn">기존 실험 범위 밖</span>}
                <p className="small muted">{cfg.factors.map((f) => `${f.name} ${fmtFactor(p.x[f.key], f)}${f.unit}`).join(" · ")}</p>
              </article>
            ))}
          </div>
          <div className="row end" style={{ marginTop: 16 }}>
            <span className="small muted">조건을 고치거나 뺄 수 있습니다. 값은 세팅 정밀도로 반올림됩니다.</span>
            <button className="primary big" disabled={!items.length} onClick={accept}>이 {items.length}개로 실험 배치 만들기</button>
          </div>
        </div>
      )}
    </div>
  );
}
