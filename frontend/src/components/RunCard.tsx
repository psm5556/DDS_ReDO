import { useState } from "react";
import { fmtFactor, fmtResp, STATUS_LABEL } from "../format";
import type { FactorDef, ResponseDef, Run } from "../types";

export const FAIL_REASONS = ["장비 이상", "시료 불량", "조건 세팅 불가", "측정 오류", "안전 문제", "기타"];

export interface RowPatch {
  run_id: number; actual?: Record<string, number>; values?: Record<string, number | null>;
  status?: string; fail_reason?: string; deviation_note?: string;
}

/** 태블릿·모바일용 런 1건 입력 카드 (CLAUDE.md 7.2절) */
export function RunCard({ run, factors, responses, onSave, warnings, readOnly }: {
  run: Run; factors: FactorDef[]; responses: ResponseDef[]; onSave: (p: RowPatch) => Promise<void>;
  warnings?: string[]; readOnly?: boolean;
}) {
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(responses.map((r) => [r.key, run.values[r.key] == null ? "" : String(run.values[r.key])])));
  const [act, setAct] = useState<Record<string, string>>(() =>
    Object.fromEntries(factors.map((f) => [f.key, String(run.actual[f.key] ?? run.planned[f.key])])));
  const [note, setNote] = useState(run.deviation_note);
  const [showActual, setShowActual] = useState(factors.some((f) => run.actual[f.key] !== run.planned[f.key]));
  const [failMode, setFailMode] = useState<null | "failed" | "infeasible">(null);
  const [reason, setReason] = useState(FAIL_REASONS[0]);
  const [busy, setBusy] = useState(false);
  const bad = (s: string) => s.trim() !== "" && !Number.isFinite(Number(s));
  const anyBad = Object.values(vals).some(bad) || Object.values(act).some((s) => s.trim() === "" || bad(s));

  const save = async (extra?: Partial<RowPatch>) => {
    setBusy(true);
    try {
      await onSave({
        run_id: run.id,
        values: Object.fromEntries(responses.map((r) => [r.key, vals[r.key].trim() === "" ? null : Number(vals[r.key])])),
        actual: Object.fromEntries(factors.map((f) => [f.key, Number(act[f.key])])),
        deviation_note: note,
        ...extra,
      });
    } finally { setBusy(false); }
  };

  return (
    <div className="run-card">
      <div className="row">
        <h3 className="num" style={{ flex: 1 }}>{run.code}</h3>
        <span className={`chip status-${run.status}`}>{STATUS_LABEL[run.status]}</span>
        {run.replicate_no > 1 || run.is_replicate_of_existing ? <span className="chip sigma">반복</span> : null}
      </div>
      <p className="small muted">실행 순서 {run.run_order}번 · {run.batch_seq}차 배치</p>
      <div className="cond">
        {factors.map((f) => <div key={f.key}><span className="small muted">{f.name}</span><b className="num">{fmtFactor(run.planned[f.key], f)} <small>{f.unit}</small></b></div>)}
      </div>
      {!readOnly && (
        <>
          <div className="grid-2">
            {responses.map((r) => (
              <label className="field" key={r.key}><span className="lbl">{r.name} {r.unit && <span className="muted">[{r.unit}]</span>}</span>
                <input type="number" inputMode="decimal" value={vals[r.key]} className={bad(vals[r.key]) ? "invalid" : ""}
                  onChange={(e) => setVals({ ...vals, [r.key]: e.target.value })} />
                {r.input_min != null && r.input_max != null && <span className="help">허용 범위 {r.input_min} ~ {r.input_max}</span>}
              </label>
            ))}
          </div>
          <button className="link-btn small" style={{ marginTop: 8 }} onClick={() => setShowActual(!showActual)}>
            {showActual ? "실제 세팅값 입력 닫기" : "계획과 다르게 세팅했나요? 실제값 입력"}
          </button>
          {showActual && (
            <div className="grid-2" style={{ marginTop: 8 }}>
              {factors.map((f) => (
                <label className="field" key={f.key}><span className="lbl">{f.name} 실제값 [{f.unit}]</span>
                  <input type="number" inputMode="decimal" value={act[f.key]} className={bad(act[f.key]) ? "invalid" : ""}
                    onChange={(e) => setAct({ ...act, [f.key]: e.target.value })} />
                </label>
              ))}
              <label className="field" style={{ gridColumn: "1 / -1" }}><span className="lbl">메모 (차이가 생긴 이유 등)</span>
                <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
            </div>
          )}
          {warnings && warnings.length > 0 && <div className="notice warn" style={{ marginTop: 10 }}><ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          {failMode ? (
            <div className="panel" style={{ marginTop: 10, background: "var(--panel-2)" }}>
              <label className="field"><span className="lbl">{failMode === "failed" ? "실패" : "실행 불가"} 사유</span>
                <select value={reason} onChange={(e) => setReason(e.target.value)}>{FAIL_REASONS.map((r) => <option key={r}>{r}</option>)}</select>
              </label>
              <div className="row end" style={{ marginTop: 10 }}>
                <button onClick={() => setFailMode(null)}>취소</button>
                <button className="danger" disabled={busy} onClick={() => save({ status: failMode, fail_reason: reason, values: {} })}>
                  {failMode === "failed" ? "실패로 표시" : "실행 불가로 표시"}</button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary big" style={{ flex: 1 }} disabled={busy || anyBad} onClick={() => save()}>{busy ? "저장 중" : "저장"}</button>
              <button onClick={() => setFailMode("failed")}>실패</button>
              <button onClick={() => setFailMode("infeasible")}>실행 불가</button>
            </div>
          )}
        </>
      )}
      {readOnly && <p className="small">{responses.map((r) => `${r.name} ${fmtResp(run.values[r.key], r)}${r.unit}`).join(" · ")}</p>}
    </div>
  );
}
