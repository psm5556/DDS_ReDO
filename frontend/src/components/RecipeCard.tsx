import { fmtFactor, pct } from "../format";
import type { Best, FactorDef, ResponseDef } from "../types";
import { OutcomeLines, RangeBar } from "./Outcome";

export function RecipeCard({ best, factors, resp, tentative, approx }: {
  best: Best; factors: FactorDef[]; resp: ResponseDef; tentative: boolean; approx?: boolean;
}) {
  return (
    <div className="recipe">
      <div className="settings">
        <div className="row" style={{ marginBottom: 14 }}>
          <h3 style={{ flex: 1 }}>추천 레시피</h3>
          {tentative ? <span className="chip warn">후보 · 데이터 더 필요</span> : <span className="chip ok">현재 최선</span>}
        </div>
        <dl>
          {factors.map((f) => (
            <div key={f.key} style={{ display: "contents" }}>
              <dt>{f.name}</dt><dd>{fmtFactor(best.x[f.key], f)}<small>{f.unit}</small></dd>
            </div>
          ))}
        </dl>
        <p className="small muted" style={{ marginTop: 14 }}>기준: {best.objective}{best.already_tested ? " · 이미 실험한 조건" : " · 아직 실험하지 않은 조건"}</p>
        {best.extrapolation && <div className="notice warn" style={{ marginTop: 8 }}>기존 실험 범위 밖입니다. 확인 실험이 꼭 필요합니다.</div>}
      </div>
      <div className="outcome">
        {best.spec_prob !== null && (
          <div style={{ marginBottom: 10 }}>
            <div className="small muted">규격({resp.lsl ?? "–"} ~ {resp.usl ?? "–"} {resp.unit}) 만족 확률</div>
            <div className={`prob-big ${best.spec_prob < 0.9 ? "low" : ""}`}>{pct(best.spec_prob)}</div>
          </div>
        )}
        <OutcomeLines p={best} resp={resp} approx={approx} />
        <RangeBar p={best} resp={resp} />
      </div>
    </div>
  );
}
