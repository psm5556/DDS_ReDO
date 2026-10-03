import { useState } from "react";
import { post } from "../api";
import { fmt, fmtFactor, fmtResp, pct } from "../format";
import { useProject } from "../project";
import type { AnalysisResult } from "../types";
import { ResponseSelect } from "./shared";

interface CompareModel { name: string; label: string; available: boolean; status: string; result?: AnalysisResult; elapsed_sec?: number; }

/** GP vs TabPFN 비교 (전문가 모드, CLAUDE.md 6.4절) */
export default function CompareSection() {
  const { project } = useProject();
  const cfg = project.config;
  const [rk, setRk] = useState(cfg.settings.primary_response ?? cfg.responses[0].key);
  const [models, setModels] = useState<CompareModel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const resp = cfg.responses.find((r) => r.key === rk)!;
  const run = async () => {
    setBusy(true); setErr(null);
    try { setModels((await post<{ models: CompareModel[] }>(`/api/projects/${project.id}/compare`, { response_key: rk })).models); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const rows: [string, (r: AnalysisResult, m: CompareModel) => React.ReactNode][] = [
    ["검증 방법", (r) => r.validation?.method ?? "–"],
    ["예측 오차 RMSE", (r) => fmt(r.validation?.rmse)],
    ["95% 구간 포함률", (r) => pct(r.validation?.coverage95)],
    ["CRPS (낮을수록 좋음)", (r) => fmt(r.validation?.crps)],
    ["불확실성 분해", (r) => (r.decomposition_is_approximate ? "근사" : "정확 (모델 구조상)")],
    ["계산 시간", (_r, m) => `${m.elapsed_sec ?? "–"}초`],
    ...cfg.factors.map((f) => [`추천: ${f.name}`, (r: AnalysisResult) => `${fmtFactor(r.best.x[f.key], f)} ${f.unit}`] as [string, (r: AnalysisResult) => React.ReactNode]),
    ["추천 레시피 μ", (r) => fmtResp(r.best.mean, resp)],
    ["추천 레시피 σ", (r) => fmtResp(r.best.sigma, resp)],
    ["규격 만족 확률", (r) => pct(r.best.spec_prob)],
    ["모델 버전", (r) => <span className="small muted">{r.surrogate_version}</span>],
  ];
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>모델 비교: Gaussian Process vs TabPFN</h3>
        <ResponseSelect cfg={cfg} value={rk} onChange={setRk} />
        <button className="primary" disabled={busy} onClick={run}>{busy ? "계산 중" : "같은 데이터로 비교"}</button>
      </div>
      <p className="small muted" style={{ marginBottom: 12 }}>
        같은 실험 데이터로 두 모델의 교차검증 성능과 추천 결과를 나란히 봅니다. TabPFN은 사내 검증이 끝나기 전까지 평가용입니다 (가중치 라이선스 확인 필요).
      </p>
      {err && <div className="notice err">{err}</div>}
      {models && (
        <div className="table-wrap"><table>
          <thead><tr><th>항목</th>{models.map((m) => <th key={m.name}>{m.label}{m.name === "tabpfn" && <span className="chip exp" style={{ marginLeft: 6 }}>실험적</span>}</th>)}</tr></thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label}><td>{label}</td>{models.map((m) => <td key={m.name}>{m.result ? f(m.result, m) : "–"}</td>)}</tr>
            ))}
            <tr><td>상태</td>{models.map((m) => <td key={m.name} className="small">{m.available ? "계산 완료" : <span style={{ color: "var(--warn)" }}>{m.status}</span>}</td>)}</tr>
          </tbody>
        </table></div>
      )}
    </div>
  );
}
