import { useEffect, useState } from "react";
import { fmtFactor, snap } from "../format";
import type { FactorDef, Prediction, ResponseDef } from "../types";
import { OutcomeLines, RangeBar } from "./Outcome";

/** 조건 시뮬레이터: 인자를 바꾸면 예상 평균·산포·규격 만족 확률을 보여준다 */
export function WhatIf({ factors, resp, start, predict, approx }: {
  factors: FactorDef[]; resp: ResponseDef; start: Record<string, number>;
  predict: (x: Record<string, number>) => Promise<Prediction>; approx?: boolean;
}) {
  const [x, setX] = useState<Record<string, number>>(start);
  const [p, setP] = useState<Prediction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = JSON.stringify(x);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      predict(x).then((r) => { if (alive) { setP(r); setErr(null); } }).catch((e: Error) => alive && setErr(e.message));
    }, 200);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div className="grid-2">
      <div>
        {factors.map((f) => (
          <div className="slider-row" key={f.key} style={{ gridTemplateColumns: "110px 1fr 110px", marginBottom: 6 }}>
            <span>{f.name}</span>
            <input type="range" min={f.low} max={f.high} step={f.step} value={x[f.key]} aria-label={f.name}
              onChange={(e) => setX({ ...x, [f.key]: snap(Number(e.target.value), f) })} />
            <span className="row" style={{ gap: 4 }}>
              <input type="number" step={f.step} value={x[f.key]} style={{ minHeight: 30, padding: "2px 6px" }} aria-label={`${f.name} 값`}
                onChange={(e) => setX({ ...x, [f.key]: Number(e.target.value) })} onBlur={() => setX({ ...x, [f.key]: snap(x[f.key], f) })} />
            </span>
          </div>
        ))}
        <button className="small ghost" onClick={() => setX(start)}>추천 레시피로 되돌리기</button>
        <p className="small muted" style={{ marginTop: 4 }}>{factors.map((f) => `${f.name} ${fmtFactor(x[f.key], f)}${f.unit}`).join(" · ")}</p>
      </div>
      <div>
        {err && <div className="notice err">{err}</div>}
        {p && (
          <>
            {p.extrapolation && <div className="notice warn" style={{ marginBottom: 8 }}>기존 실험 범위 밖의 조건이라 예측을 믿기 어렵습니다.</div>}
            <OutcomeLines p={p} resp={resp} approx={approx} />
            <RangeBar p={p} resp={resp} />
          </>
        )}
      </div>
    </div>
  );
}
