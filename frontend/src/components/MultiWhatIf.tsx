import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { post } from "../api";
import { fmtFactor, fmtResp, pct, snap } from "../format";
import type { FactorDef, ResponseDef, RespPred } from "../types";

interface MultiPrediction { x: Record<string, number>; desirability: number; extrapolation: boolean; responses: RespPred[] }

/** 조건 시뮬레이션: 조건을 바꾸면 모든 응답을 한 번에 예측하고, 목표 달성 점수까지 보여 준다 */
export function MultiWhatIf({ projectId, factors, responses, start }: {
  projectId: number; factors: FactorDef[]; responses: ResponseDef[]; start: Record<string, number>;
}) {
  const [x, setX] = useState<Record<string, number>>(start);
  const [p, setP] = useState<MultiPrediction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = JSON.stringify(x);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      post<MultiPrediction[]>(`/api/projects/${projectId}/predict-multi`, { points: [x] })
        .then((r) => { if (alive) { setP(r[0]); setErr(null); } }).catch((e: Error) => alive && setErr(e.message));
    }, 200);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, projectId]);
  const def = (k: string) => responses.find((r) => r.key === k)!;
  const s = p ? Math.round(Math.max(0, Math.min(p.desirability, 1)) * 100) : null;
  return (
    <div className="sim">
      <div className="sim-inputs">
        {factors.map((f) => (
          <div className="slider-row" key={f.key}>
            <span>{f.name}</span>
            <input type="range" min={f.low} max={f.high} step={f.step} value={x[f.key]} aria-label={f.name}
              onChange={(e) => setX({ ...x, [f.key]: snap(Number(e.target.value), f) })} />
            <span className="row" style={{ gap: 4 }}>
              <input type="number" step={f.step} value={x[f.key]} aria-label={`${f.name} 값`} style={{ minHeight: 30, padding: "2px 6px" }}
                onChange={(e) => setX({ ...x, [f.key]: Number(e.target.value) })} onBlur={() => setX({ ...x, [f.key]: snap(x[f.key], f) })} />
              <small className="muted">{f.unit}</small>
            </span>
          </div>
        ))}
        <button className="small ghost" onClick={() => setX(start)}>추천 레시피로 되돌리기</button>
      </div>
      <div className="sim-out">
        {err && <div className="notice err">{err}</div>}
        {p && (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <span className={`score-badge ${s! >= 80 ? "good" : s! >= 50 ? "mid" : "low"}`}>목표 달성 {s}점</span>
              {p.extrapolation && <span className="chip warn"><AlertTriangle size={12} />기존 실험 범위 밖 · 예측을 믿기 어려움</span>}
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>응답</th><th className="r">예상 평균</th><th className="r">1회 측정 범위</th><th className="r">산포 σ</th><th className="r">규격 안 확률</th></tr></thead>
                <tbody>{p.responses.map((r) => {
                  const d = def(r.key);
                  return (
                    <tr key={r.key}>
                      <td>{r.name} <span className="muted small">{r.unit}</span></td>
                      <td className="r num"><b>{fmtResp(r.mean, d)}</b> <span className="muted small">({fmtResp(r.mean_lo, d)}~{fmtResp(r.mean_hi, d)})</span></td>
                      <td className="r num">{fmtResp(r.obs_lo, d)} ~ {fmtResp(r.obs_hi, d)}</td>
                      <td className="r num">{fmtResp(r.sigma, d)}</td>
                      <td className="r num">{r.spec_prob === null ? "–" : <b>{pct(r.spec_prob)}</b>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 6 }}>{factors.map((f) => `${f.name} ${fmtFactor(p.x[f.key], f)}${f.unit}`).join(" · ")}</p>
          </>
        )}
      </div>
    </div>
  );
}
