import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { del, get, post } from "../api";
import { Confirm, Modal } from "../components/Modal";
import { fmtFactor, snap, STATUS_LABEL, when } from "../format";
import { can, useProject } from "../project";
import { useToast } from "../toast";
import type { Batch, Run } from "../types";

const KIND: Record<string, string> = { initial: "초기 설계", active: "능동학습 제안", manual: "직접 추가", confirmation: "확인 실험" };

function ManualModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { project } = useProject();
  const fs = project.config.factors;
  const [rows, setRows] = useState<Record<string, string>[]>([Object.fromEntries(fs.map((f) => [f.key, ""]))]);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const valid = rows.every((r) => fs.every((f) => r[f.key] !== "" && Number(r[f.key]) >= f.low && Number(r[f.key]) <= f.high));
  const save = async () => {
    try {
      await post(`/api/projects/${project.id}/batches/manual`, {
        points: rows.map((r) => Object.fromEntries(fs.map((f) => [f.key, snap(Number(r[f.key]), f)]))),
      });
      toast("실험을 추가했습니다.");
      onDone(); onClose();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title="실험 직접 추가" onClose={onClose} wide footer={<>
      <button onClick={onClose}>취소</button>
      <button className="primary" disabled={!valid} onClick={save}>{rows.length}개 실험 추가</button>
    </>}>
      <p className="small muted" style={{ marginBottom: 10 }}>꼭 확인하고 싶은 조건이 있으면 직접 추가하세요. 값은 세팅 정밀도로 반올림됩니다.</p>
      {err && <div className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      <div className="table-wrap"><table>
        <thead><tr>{fs.map((f) => <th key={f.key}>{f.name} <span className="unit">{f.unit} ({f.low}~{f.high})</span></th>)}<th /></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>{fs.map((f) => {
            const v = r[f.key];
            const bad = v !== "" && (Number(v) < f.low || Number(v) > f.high);
            return <td key={f.key}><input type="number" step={f.step} value={v} className={bad ? "invalid" : ""}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, [f.key]: e.target.value } : x)))} /></td>;
          })}<td><button className="ghost small" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>삭제</button></td></tr>
        ))}</tbody>
      </table></div>
      <button className="small" style={{ marginTop: 8 }} onClick={() => setRows([...rows, Object.fromEntries(fs.map((f) => [f.key, ""]))])}>행 추가</button>
    </Modal>
  );
}

export default function PlanSection() {
  const { project, reload } = useProject();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sel, setSel] = useState<number | "all">("all");
  const [manual, setManual] = useState(false);
  const [cancel, setCancel] = useState<Batch | null>(null);
  const toast = useToast();
  const fs = project.config.factors;
  const load = async () => {
    const bs = await get<Batch[]>(`/api/projects/${project.id}/batches`);
    setBatches(bs);
    setRuns(await get<Run[]>(`/api/projects/${project.id}/runs`));
    if (sel === "all" && bs.length) setSel(bs[bs.length - 1].id);
  };
  useEffect(() => { void load(); }, [project.id]);
  const shown = sel === "all" ? runs : runs.filter((r) => r.batch_id === sel);
  const batch = batches.find((b) => b.id === sel);
  const canCancel = batch && runs.filter((r) => r.batch_id === batch.id).every((r) => r.status === "planned");

  if (batches.length === 0) {
    return <div className="panel empty"><h3>아직 실험 계획이 없습니다</h3><p>개요에서 초기 실험 계획을 만드세요.</p>
      <Link className="btn primary" to={`/projects/${project.id}`}>개요로 가기</Link></div>;
  }
  const q = sel === "all" ? "" : `?batch_id=${sel}`;
  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <h3>실험 계획</h3>
          <select value={sel} onChange={(e) => setSel(e.target.value === "all" ? "all" : Number(e.target.value))} style={{ width: "auto" }} aria-label="배치 선택">
            {batches.map((b) => <option key={b.id} value={b.id}>{b.seq}차 · {KIND[b.kind] ?? b.kind} ({b.runs_done}/{b.runs_total})</option>)}
            <option value="all">전체</option>
          </select>
        </div>
        {batch && <p className="small muted" style={{ marginBottom: 12 }}>{batch.created_by} · {when(batch.created_at)}{batch.note ? ` · ${batch.note}` : ""}
          {batch.surrogate && <> · 모델 {batch.surrogate === "gp" ? "GP" : "TabPFN (평가용)"}</>}</p>}
        <div className="row" style={{ marginBottom: 12 }}>
          <Link className="btn" to={`/projects/${project.id}/print${sel === "all" ? "" : `?batch=${sel}`}`} target="_blank">인쇄용 실험 시트 (QR 포함)</Link>
          <a className="btn" href={`/api/projects/${project.id}/runsheet.xlsx${q}`}>엑셀 양식 내려받기</a>
          <div style={{ flex: 1 }} />
          {can(project.my_role, "editor") && <button onClick={() => setManual(true)}>실험 직접 추가</button>}
          {can(project.my_role, "editor") && batch && canCancel && <button className="danger" onClick={() => setCancel(batch)}>이 배치 취소</button>}
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>런 ID</th><th className="r">순서</th>{fs.map((f) => <th key={f.key} className="r">{f.name} <span className="unit">{f.unit}</span></th>)}<th>구분</th><th>제안 이유</th><th>상태</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.id}>
              <td className="num">{r.code}</td><td className="r">{r.run_order}</td>
              {fs.map((f) => <td key={f.key} className="r">{fmtFactor(r.planned[f.key], f)}</td>)}
              <td>{r.is_replicate_of_existing ? <span className="chip sigma">반복</span> : r.replicate_no > 1 ? <span className="chip sigma">반복 {r.replicate_no}</span> : <span className="chip">신규</span>}</td>
              <td className="small" style={{ maxWidth: 340 }}>{r.reason}</td>
              <td><span className={`chip status-${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
      {manual && <ManualModal onClose={() => setManual(false)} onDone={() => { void load(); void reload(); }} />}
      {cancel && <Confirm title="배치 취소" danger confirmLabel="배치 취소" onClose={() => setCancel(null)}
        message={`${cancel.seq}차 배치의 계획된 런 ${cancel.runs_total}개를 삭제합니다. 아직 시작하지 않은 배치만 취소할 수 있습니다.`}
        onConfirm={async () => {
          try { await del(`/api/projects/${project.id}/batches/${cancel.id}`); setSel("all"); toast("배치를 취소했습니다."); await load(); await reload(); }
          catch (e) { toast((e as Error).message, true); }
        }} />}
    </div>
  );
}
