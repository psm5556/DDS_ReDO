import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { get } from "../api";
import { fmtFactor, STATUS_LABEL } from "../format";
import type { Batch, ProjectDetail, Run } from "../types";

const isOpen = (r: Run) => r.status === "planned" || r.status === "running";
const SURROGATE_LABEL: Record<string, string> = { gp: "Gaussian Process", tabpfn: "TabPFN (실험적·평가용)" };

/** A4 인쇄용 실험 시트 (CLAUDE.md 7.2절): 런별 QR로 해당 런 입력 화면에 바로 진입 */
export default function PrintPage() {
  const { pid } = useParams();
  const [params] = useSearchParams();
  const batchId = params.get("batch") ? Number(params.get("batch")) : null;
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [qr, setQr] = useState<Record<number, string>>({});
  const [includeDone, setIncludeDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      get<ProjectDetail>(`/api/projects/${pid}`),
      get<Run[]>(`/api/projects/${pid}/runs${batchId ? `?batch_id=${batchId}` : ""}`),
      get<Batch[]>(`/api/projects/${pid}/batches`),
    ]).then(([p, r, b]) => { setProject(p); setRuns(r); setBatches(b); })
      .catch((e: Error) => setErr(e.message));
  }, [pid, batchId]);

  const shown = useMemo(() => (runs ?? [])
    .filter((r) => includeDone || isOpen(r))
    .sort((a, b) => a.batch_seq - b.batch_seq || a.run_order - b.run_order), [runs, includeDone]);

  useEffect(() => {
    let alive = true;
    const origin = window.location.origin;
    Promise.all(shown.filter((r) => !qr[r.id]).map(async (r) =>
      [r.id, await QRCode.toDataURL(`${origin}/projects/${pid}/runs/${r.id}`, { margin: 1, width: 160, errorCorrectionLevel: "M" })] as const))
      .then((pairs) => { if (alive && pairs.length) setQr((q) => ({ ...q, ...Object.fromEntries(pairs) })); })
      .catch(() => { /* QR 생성 실패 시 런 ID로 입력 가능 */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, pid]);

  if (err) return <div className="page"><div className="notice err">{err}</div></div>;
  if (!project || !runs) return <div className="page"><div className="busy"><span className="spinner" /> 불러오는 중</div></div>;

  const { factors, responses } = project.config;
  const batch = batchId ? batches.find((b) => b.id === batchId) : null;
  const batchLabel = batch ? `${batch.seq}차 배치` : "전체 배치";
  const surrogates = [...new Set((batch ? [batch] : batches.filter((b) => shown.some((r) => r.batch_id === b.id)))
    .map((b) => b.surrogate).filter((s): s is string => !!s))];
  const today = new Date().toLocaleDateString("ko-KR");
  const allQr = shown.every((r) => qr[r.id]);

  return (
    <>
      <div className="no-print row" style={{ padding: "12px 20px", borderBottom: "1px solid var(--line-2)", background: "var(--panel)" }}>
        <Link to={`/projects/${project.id}/step/1`}>← 실험하기로</Link>
        <div style={{ flex: 1 }} />
        <label className="check small">
          <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />
          완료·실패한 런도 포함
        </label>
        <button className="primary" disabled={!allQr || shown.length === 0} onClick={() => window.print()}>
          {allQr ? "인쇄" : "QR 생성 중…"}
        </button>
      </div>

      <div className="print-sheet">
        <div className="row" style={{ alignItems: "flex-start", marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0 }}>실험 시트 · {project.name}</h2>
            <p className="small" style={{ margin: "4px 0 0" }}>
              {batchLabel} · {shown.length}건 · 인쇄일 {today} · 소유자 {project.owner.name}
              {surrogates.length > 0 && <> · 제안 모델: {surrogates.map((s) => SURROGATE_LABEL[s] ?? s).join(", ")}</>}
            </p>
          </div>
        </div>
        <p className="small" style={{ margin: "0 0 8px" }}>
          ※ 실행 순서는 시간에 따른 장비·환경 변화가 결과에 섞이지 않도록 무작위로 정했습니다. 가능하면 순서대로 진행하세요.
          계획과 다르게 세팅했다면 실제값을 메모란에 적으세요. QR을 스캔하면 해당 런의 입력 화면이 열립니다.
        </p>

        {shown.length === 0 ? (
          <p className="muted">인쇄할 미완료 런이 없습니다.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>순서</th>
                <th>런 ID</th>
                {factors.map((f) => (
                  <th key={f.key} className="r">{f.name}<br /><span className="unit">[{f.unit}] · {f.step} 단위</span></th>
                ))}
                <th>반복</th>
                {responses.map((r) => (
                  <th key={r.key}>{r.name}{r.unit && <><br /><span className="unit">[{r.unit}]</span></>}</th>
                ))}
                <th style={{ width: "22%" }}>메모 (실제 세팅값·특이사항)</th>
                <th>QR</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} style={{ breakInside: "avoid" }}>
                  <td className="num">{batchId ? r.run_order : `${r.batch_seq}-${r.run_order}`}</td>
                  <td className="num code"><b>{r.code}</b>{!isOpen(r) && <><br /><small>{STATUS_LABEL[r.status]}</small></>}</td>
                  {factors.map((f) => <td key={f.key} className="r num">{fmtFactor(r.planned[f.key], f)}</td>)}
                  <td>{r.replicate_no > 1 || r.is_replicate_of_existing ? `반복 ${r.replicate_no}` : "–"}</td>
                  {responses.map((x) => <td key={x.key} className="write" />)}
                  <td className="write" />
                  <td className="qr">{qr[r.id] ? <img src={qr[r.id]} alt={`${r.code} 입력 화면 QR`} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="small" style={{ marginTop: 10 }}>실험자: ____________ &nbsp;&nbsp; 실험일: ____________ &nbsp;&nbsp; 확인자: ____________</p>
      </div>
    </>
  );
}
