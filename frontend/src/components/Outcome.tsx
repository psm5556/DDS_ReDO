import { fmtResp, pct } from "../format";
import type { ResponseDef } from "../types";

interface Pred {
  mean: number; mean_lo: number; mean_hi: number; sigma: number; sigma_lo: number; sigma_hi: number;
  obs_lo: number; obs_hi: number; spec_prob: number | null;
}

/** 평균 ± (모델 불확실성), 단일 측정 예상 범위(산포 포함), 규격을 한 줄에 보여주는 막대 */
export function RangeBar({ p, resp }: { p: Pred; resp: ResponseDef }) {
  const vals = [p.obs_lo, p.obs_hi, p.mean_lo, p.mean_hi, resp.lsl, resp.usl, resp.target]
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const w = (a: number, b: number) => `${((b - a) / (hi - lo)) * 100}%`;
  const sl = resp.lsl ?? lo, su = resp.usl ?? hi;
  return (
    <div>
      <div className="range-bar" aria-hidden="true">
        <div className="track" />
        {(resp.lsl != null || resp.usl != null) && <div className="spec" style={{ left: x(sl), width: w(sl, su) }} />}
        <div className="obs" style={{ left: x(p.obs_lo), width: w(p.obs_lo, p.obs_hi) }} />
        <div className="ci" style={{ left: x(p.mean_lo), width: w(p.mean_lo, p.mean_hi) }} />
        <div className="mu" style={{ left: x(p.mean) }} />
      </div>
      <div className="range-legend">
        {(resp.lsl != null || resp.usl != null) && <span><i style={{ background: "var(--ok-soft)", borderLeft: "2px solid var(--ok)", borderRight: "2px solid var(--ok)" }} />규격</span>}
        <span><i style={{ background: "var(--sigma-soft)", border: "1px solid var(--sigma)" }} />1회 측정 예상 범위 (산포 포함)</span>
        <span><i style={{ borderTop: "2px dashed var(--epi)", height: 0 }} />평균의 불확실성</span>
      </div>
    </div>
  );
}

export function OutcomeLines({ p, resp, approx }: { p: Pred; resp: ResponseDef; approx?: boolean }) {
  const u = resp.unit ? ` ${resp.unit}` : "";
  return (
    <div>
      <div className="outcome-line">
        <span className="sym m">μ</span><span className="lbl">예상 평균</span>
        <span className="val">{fmtResp(p.mean, resp)}{u}</span>
        <span className="rng">{fmtResp(p.mean_lo, resp)} ~ {fmtResp(p.mean_hi, resp)}</span>
      </div>
      <div className="outcome-line">
        <span className="sym s">σ</span><span className="lbl">예상 산포 (반복 시 흩어짐)</span>
        <span className="val">{fmtResp(p.sigma, resp)}{u}</span>
        <span className="rng">{fmtResp(p.sigma_lo, resp)} ~ {fmtResp(p.sigma_hi, resp)}</span>
      </div>
      <div className="outcome-line">
        <span className="sym">↔</span><span className="lbl">1회 측정 시 95% 예상 범위</span>
        <span className="val small">{fmtResp(p.obs_lo, resp)} ~ {fmtResp(p.obs_hi, resp)}{u}</span>
      </div>
      {p.spec_prob !== null && (
        <div className="outcome-line">
          <span className="sym p">✓</span><span className="lbl">규격 만족 확률</span>
          <span className="val">{pct(p.spec_prob)}</span>
        </div>
      )}
      {approx && <p className="small muted" style={{ marginTop: 6 }}>TabPFN 결과: 산포와 평균 불확실성의 구분은 근사값입니다.</p>}
    </div>
  );
}
