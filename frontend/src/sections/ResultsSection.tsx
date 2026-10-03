import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, get, post } from "../api";
import { Modal } from "../components/Modal";
import { FAIL_REASONS, RunCard, type RowPatch } from "../components/RunCard";
import { fmtFactor, STATUS_LABEL, when } from "../format";
import { can, useProject } from "../project";
import { useToast } from "../toast";
import type { Batch, Run } from "../types";

type Edit = { actual: Record<string, string>; values: Record<string, string>; note: string; status?: string; fail_reason?: string };
type Col = { kind: "act" | "val" | "note"; key: string };
type SaveState = "idle" | "dirty" | "saving" | "saved" | "offline" | "error";

function useNarrow() {
  const [n, setN] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 760px)");
    const h = () => setN(m.matches);
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);
  return n;
}

const isNum = (s: string) => s.trim() !== "" && Number.isFinite(Number(s.replace(/,/g, "")));
const toNum = (s: string) => Number(s.replace(/,/g, ""));

interface PreviewRow { code: string; run_id: number | null; changes: { field: string; old: unknown; new: unknown }[]; errors: string[]; warnings: string[]; row: RowPatch | null; }
interface Preview { file_errors: string[]; rows: PreviewRow[]; summary: { rows: number; changed: number; errors: number } }

export default function ResultsSection() {
  const { project, reload } = useProject();
  const toast = useToast();
  const narrow = useNarrow();
  const fs = project.config.factors;
  const rs = project.config.responses;
  const draftKey = `redo.draft.${project.id}`;
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [loadSeq, setLoadSeq] = useState(0);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batch, setBatch] = useState<number | "all">("all");
  const [onlyOpen, setOnlyOpen] = useState(project.runs_open > 0);
  const [edits, setEdits] = useState<Record<number, Edit>>(() => {
    try { return JSON.parse(localStorage.getItem(draftKey) || "{}"); } catch { return {}; }
  });
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [state, setState] = useState<SaveState>(Object.keys(edits).length ? "dirty" : "idle");
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [failFor, setFailFor] = useState<{ run: Run; status: "failed" | "infeasible" } | null>(null);
  const [excludeFor, setExcludeFor] = useState<Run | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const readOnly = !can(project.my_role, "runner");

  const load = useCallback(async () => {
    const [rr, bs] = await Promise.all([get<Run[]>(`/api/projects/${project.id}/runs`), get<Batch[]>(`/api/projects/${project.id}/batches`)]);
    setRuns(rr); setBatches(bs); setLoadSeq((n) => n + 1);
  }, [project.id]);
  useEffect(() => { void load(); }, [load]);

  // 임시 저장(오프라인 대비)
  useEffect(() => {
    try {
      if (Object.keys(edits).length) localStorage.setItem(draftKey, JSON.stringify(edits));
      else localStorage.removeItem(draftKey);
    } catch { /* 저장 불가 환경 */ }
  }, [edits, draftKey]);

  const cols: Col[] = useMemo(() => [
    ...fs.map((f) => ({ kind: "act" as const, key: f.key })),
    ...rs.map((r) => ({ kind: "val" as const, key: r.key })),
    { kind: "note" as const, key: "note" },
  ], [fs, rs]);

  // 보이는 행 목록은 필터를 바꾸거나 목록을 다시 불러올 때만 다시 정한다.
  // 자동 저장으로 런이 '완료'가 되어도 입력 중인 행이 사라지거나 행 번호(cell-행-열)가 밀리지 않게 하기 위함.
  const [visibleIds, setVisibleIds] = useState<Set<number> | null>(null);
  useEffect(() => {
    if (!runs) return;
    setVisibleIds(new Set(runs.filter((r) => (batch === "all" || r.batch_id === batch)
      && (!onlyOpen || r.status === "planned" || r.status === "running" || edits[r.id])).map((r) => r.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch, onlyOpen, loadSeq]);
  const shown = useMemo(() => (runs ?? []).filter((r) => visibleIds?.has(r.id)), [runs, visibleIds]);

  const base = (r: Run): Edit => ({
    actual: Object.fromEntries(fs.map((f) => [f.key, String(r.actual[f.key] ?? r.planned[f.key])])),
    values: Object.fromEntries(rs.map((x) => [x.key, r.values[x.key] == null ? "" : String(r.values[x.key])])),
    note: r.deviation_note,
  });
  const cell = (r: Run, c: Col): string => {
    const e = edits[r.id] ?? base(r);
    return c.kind === "act" ? e.actual[c.key] : c.kind === "val" ? e.values[c.key] : e.note;
  };
  const setCell = (r: Run, c: Col, v: string) => {
    setEdits((prev) => {
      const e = { ...(prev[r.id] ?? base(r)) };
      if (c.kind === "act") e.actual = { ...e.actual, [c.key]: v };
      else if (c.kind === "val") e.values = { ...e.values, [c.key]: v };
      else e.note = v;
      return { ...prev, [r.id]: e };
    });
    setState("dirty");
  };

  const cellClass = (r: Run, c: Col): string => {
    const v = cell(r, c);
    const cls: string[] = [];
    if (edits[r.id]) {
      const b = base(r);
      const bv = c.kind === "act" ? b.actual[c.key] : c.kind === "val" ? b.values[c.key] : b.note;
      if (bv !== v) cls.push("dirty");
    }
    if (c.kind === "note") return cls.concat("text").join(" ");
    if (c.kind === "act") {
      const f = fs.find((x) => x.key === c.key)!;
      if (!isNum(v)) cls.push("bad");
      else if (toNum(v) < f.low || toNum(v) > f.high) cls.push("soft");
      else if (toNum(v) !== r.planned[c.key]) cls.push("dev");
    } else if (v.trim() !== "") {
      const x = rs.find((q) => q.key === c.key)!;
      if (!isNum(v)) cls.push("bad");
      else if ((x.input_min != null && toNum(v) < x.input_min) || (x.input_max != null && toNum(v) > x.input_max)) cls.push("soft");
    }
    return cls.join(" ");
  };
  const rowValid = (r: Run) => cols.every((c) => !cellClass(r, c).includes("bad"));

  const buildPatch = (r: Run, e: Edit): RowPatch => {
    const p: RowPatch = { run_id: r.id };
    const act: Record<string, number> = {};
    for (const f of fs) if (toNum(e.actual[f.key]) !== (r.actual[f.key] ?? r.planned[f.key])) act[f.key] = toNum(e.actual[f.key]);
    if (Object.keys(act).length) p.actual = act;
    const vals: Record<string, number | null> = {};
    for (const x of rs) {
      const s = e.values[x.key];
      const nv = s.trim() === "" ? null : toNum(s);
      if (nv !== (r.values[x.key] ?? null)) vals[x.key] = nv;
    }
    if (Object.keys(vals).length) p.values = vals;
    if (e.note !== r.deviation_note) p.deviation_note = e.note;
    if (e.status) p.status = e.status;
    if (e.fail_reason) p.fail_reason = e.fail_reason;
    return p;
  };

  const applySaved = (saved: Run[], snapshot: Record<number, Edit>) => {
    setRuns((prev) => (prev ?? []).map((r) => saved.find((s) => s.id === r.id) ?? r));
    setEdits((prev) => {
      const next = { ...prev };
      for (const s of saved) if (JSON.stringify(prev[s.id]) === JSON.stringify(snapshot[s.id])) delete next[s.id];
      return next;
    });
  };

  const saveRows = useCallback(async (patches: RowPatch[], snapshot: Record<number, Edit>) => {
    if (!patches.length) return;
    savingRef.current = true;
    setState("saving");
    try {
      const res = await post<{ saved: number; warnings: Record<string, string[]>; runs: Run[] }>(`/api/projects/${project.id}/results`, { rows: patches });
      applySaved(res.runs, snapshot);
      setWarnings((w) => {
        const n = { ...w };
        for (const p of patches) delete n[String(p.run_id)];
        return { ...n, ...res.warnings };
      });
      setErrors({});
      setState("saved");
      setLastSaved(new Date().toISOString());
      if (res.saved) void reload();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 0) setState("offline");
      else {
        setState("error");
        const d = err.detail as { errors?: Record<string, string[]> } | null;
        if (d?.errors) setErrors(d.errors);
        toast(err.message, true);
      }
    } finally { savingRef.current = false; }
  }, [project.id, reload, toast]);

  const flush = useCallback(() => {
    if (!runs || savingRef.current) return;
    const snapshot = { ...edits };
    const patches: RowPatch[] = [];
    for (const [id, e] of Object.entries(snapshot)) {
      const r = runs.find((x) => x.id === Number(id));
      if (!r) continue;
      if (!rowValid(r)) continue;
      const p = buildPatch(r, e);
      if (Object.keys(p).length > 1) patches.push(p);
      else setEdits((prev) => { const n = { ...prev }; if (JSON.stringify(n[r.id]) === JSON.stringify(e)) delete n[r.id]; return n; });
    }
    void saveRows(patches, snapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, runs, saveRows]);

  // 자동 저장: 마지막 입력 1.5초 후, 오프라인이면 15초마다 재시도
  useEffect(() => {
    if (!Object.keys(edits).length || !runs) return;
    const t = setTimeout(flush, state === "offline" ? 15000 : 1500);
    return () => clearTimeout(t);
  }, [edits, runs, state, flush]);

  const focusCell = (row: number, col: number) => {
    const el = document.getElementById(`cell-${row}-${col}`) as HTMLInputElement | null;
    if (el) { el.focus(); el.select?.(); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
    if (e.key === "Enter") { e.preventDefault(); focusCell(e.shiftKey ? row - 1 : row + 1, col); }
    else if (e.key === "ArrowDown") { e.preventDefault(); focusCell(row + 1, col); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusCell(row - 1, col); }
  };
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, row: number, col: number) => {
    const text = e.clipboardData.getData("text");
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const lines = text.replace(/\r/g, "").split("\n");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    setEdits((prev) => {
      const next = { ...prev };
      lines.forEach((line, i) => {
        const r = shown[row + i];
        if (!r) return;
        const ed = { ...(next[r.id] ?? base(r)) };
        ed.actual = { ...ed.actual }; ed.values = { ...ed.values };
        line.split("\t").forEach((v, j) => {
          const c = cols[col + j];
          if (!c) return;
          const s = v.trim();
          if (c.kind === "act") ed.actual[c.key] = s; else if (c.kind === "val") ed.values[c.key] = s; else ed.note = v;
        });
        next[r.id] = ed;
      });
      return next;
    });
    setState("dirty");
    toast(`${lines.length}행을 붙여넣었습니다.`);
  };

  const onCardSave = async (p: RowPatch) => {
    await saveRows([p], {});
    await load();
  };

  const changeStatus = (r: Run, s: string) => {
    if (s === "failed" || s === "infeasible") { setFailFor({ run: r, status: s }); return; }
    void saveRows([{ run_id: r.id, status: s }], {});
  };

  const upload = async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    try { setPreview(await api<Preview>(`/api/projects/${project.id}/results/preview`, { method: "POST", form: fd })); }
    catch (e) { toast((e as Error).message, true); }
    if (fileRef.current) fileRef.current.value = "";
  };
  const commitPreview = async () => {
    if (!preview) return;
    const rows = preview.rows.filter((r) => r.row && r.errors.length === 0 && r.changes.length > 0).map((r) => r.row!);
    await saveRows(rows, {});
    setPreview(null);
    await load();
    toast(`${rows.length}개 런을 반영했습니다.`);
  };

  if (!runs || !visibleIds) return <div className="busy"><span className="spinner" /> 불러오는 중</div>;
  if (runs.length === 0) return <div className="panel empty"><h3>입력할 실험이 없습니다</h3><p>먼저 실험 계획을 만드세요.</p></div>;

  const stateText: Record<SaveState, string> = {
    idle: "", dirty: "입력 중 · 잠시 후 자동 저장", saving: "저장 중",
    saved: lastSaved ? `저장됨 · ${when(lastSaved)}` : "저장됨",
    offline: "서버에 연결할 수 없어 이 브라우저에 임시 저장했습니다. 연결되면 자동으로 저장합니다.",
    error: "저장하지 못한 입력이 있습니다. 빨간 칸을 확인하세요.",
  };
  const warnRuns = Object.entries(warnings).filter(([, w]) => w.length);

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <h3>결과 입력</h3>
          <span className={`save-state ${state === "dirty" || state === "saving" ? "dirty" : state === "offline" ? "offline" : ""}`} role="status">{stateText[state]}</span>
        </div>
        <div className="row" style={{ marginBottom: 12 }}>
          <select value={batch} onChange={(e) => setBatch(e.target.value === "all" ? "all" : Number(e.target.value))} style={{ width: "auto" }} aria-label="배치">
            <option value="all">모든 배치</option>
            {batches.map((b) => <option key={b.id} value={b.id}>{b.seq}차 배치 ({b.runs_done}/{b.runs_total})</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />남은 실험만</label>
          <div style={{ flex: 1 }} />
          {!readOnly && <>
            <a className="btn small" href={`/api/projects/${project.id}/runsheet.xlsx${batch === "all" ? "" : `?batch_id=${batch}`}`}>엑셀 양식 내려받기</a>
            <button className="small" onClick={() => fileRef.current?.click()}>엑셀로 결과 올리기</button>
            <input ref={fileRef} type="file" accept=".xlsx,.csv" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            {state !== "idle" && state !== "saved" && <button className="small primary" onClick={flush}>지금 저장</button>}
          </>}
        </div>
        {!narrow && !readOnly && (
          <p className="small muted" style={{ marginBottom: 8 }}>
            엑셀처럼 입력하세요. <span className="kbd">Enter</span> 아래 칸, <span className="kbd">Shift</span>+<span className="kbd">Enter</span> 위 칸.
            엑셀에서 여러 칸을 복사해 붙여넣을 수 있습니다. 실제 세팅값은 계획값으로 미리 채워져 있으니 다를 때만 고치세요.
          </p>
        )}
        {shown.length === 0 && <div className="empty"><h3>남은 실험이 없습니다</h3><p>모든 결과가 입력되었습니다. ‘남은 실험만’을 끄면 전체를 볼 수 있습니다.</p></div>}

        {narrow ? shown.map((r) => (
          <RunCard key={r.id + r.updated_at} run={r} factors={fs} responses={rs} onSave={onCardSave} warnings={warnings[String(r.id)]} readOnly={readOnly} />
        )) : shown.length > 0 && (
          <div className="table-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>런 ID</th><th>상태</th>
                  {fs.map((f) => <th key={f.key} className="r" title={`계획값 기준, ${f.low}~${f.high}`}>{f.name} 실제 <span className="unit">{f.unit}</span></th>)}
                  {rs.map((x) => <th key={x.key} className="r" style={{ background: "var(--mean-soft)" }}>{x.name} <span className="unit">{x.unit}</span></th>)}
                  <th>메모</th>{can(project.my_role, "editor") && <th />}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, ri) => {
                  const w = warnings[String(r.id)];
                  const er = errors[String(r.id)];
                  return (
                    <tr key={r.id} className={r.status}>
                      <td className="ro num" title={[r.reason, ...(w ?? []), ...(er ?? [])].join("\n")}>
                        {r.code}{(w?.length || er?.length) ? <span style={{ color: er?.length ? "var(--err)" : "var(--warn)" }}> ⚠</span> : null}
                        {(r.replicate_no > 1 || r.is_replicate_of_existing) && <span className="chip sigma" style={{ marginLeft: 6 }}>반복</span>}
                      </td>
                      <td style={{ minWidth: 104 }}>
                        <select value={r.status} disabled={readOnly} onChange={(e) => changeStatus(r, e.target.value)} aria-label={`${r.code} 상태`}>
                          {["planned", "running", "done", "failed", "infeasible"].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                        </select>
                      </td>
                      {cols.map((c, ci) => (
                        <td key={c.key + c.kind} className={cellClass(r, c)} style={c.kind === "note" ? { minWidth: 160 } : { minWidth: 92 }}
                          title={c.kind === "act" ? `계획값 ${fmtFactor(r.planned[c.key], fs.find((f) => f.key === c.key)!)}` : c.kind === "val" && r.excluded[c.key] ? "분석에서 제외됨" : undefined}>
                          <input id={`cell-${ri}-${ci}`} type="text" inputMode={c.kind === "note" ? "text" : "decimal"} value={cell(r, c)} disabled={readOnly}
                            style={c.kind === "val" && r.excluded[c.key] ? { textDecoration: "line-through" } : undefined}
                            onChange={(e) => setCell(r, c, e.target.value)} onKeyDown={(e) => onKey(e, ri, ci)} onPaste={(e) => onPaste(e, ri, ci)}
                            aria-label={`${r.code} ${c.kind === "note" ? "메모" : c.kind === "act" ? fs.find((f) => f.key === c.key)!.name + " 실제값" : rs.find((x) => x.key === c.key)!.name}`} />
                        </td>
                      ))}
                      {can(project.my_role, "editor") && <td className="ro">{r.status === "done" && <button className="ghost small" onClick={() => setExcludeFor(r)} title="이상치 제외">제외…</button>}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {warnRuns.length > 0 && (
        <div className="notice warn" role="alert">
          <div>
            <b>확인이 필요한 입력</b> — 저장은 되었습니다. 값이 맞다면 그대로 두세요.
            <ul>{warnRuns.map(([id, ws]) => <li key={id}>{runs.find((r) => r.id === Number(id))?.code}: {ws.join(" ")}</li>)}</ul>
          </div>
        </div>
      )}

      {failFor && <FailModal run={failFor.run} status={failFor.status} onClose={() => setFailFor(null)}
        onConfirm={(reason) => saveRows([{ run_id: failFor.run.id, status: failFor.status, fail_reason: reason }], {})} />}
      {excludeFor && <ExcludeModal run={excludeFor} onClose={() => setExcludeFor(null)} onDone={load} />}
      {preview && (
        <Modal title="엑셀 업로드 미리보기" wide onClose={() => setPreview(null)} footer={<>
          <button onClick={() => setPreview(null)}>취소</button>
          <button className="primary" disabled={preview.summary.changed === 0 || preview.file_errors.length > 0} onClick={commitPreview}>
            변경 {preview.summary.changed}건 반영
          </button>
        </>}>
          {preview.file_errors.map((e) => <div key={e} className="notice err" style={{ marginBottom: 8 }}>{e}</div>)}
          <p className="small" style={{ marginBottom: 10 }}>
            {preview.summary.rows}행 중 바뀐 내용이 있는 행 {preview.summary.changed}개{preview.summary.errors > 0 && <>, <b style={{ color: "var(--err)" }}>오류 {preview.summary.errors}개 (반영되지 않음)</b></>}.
          </p>
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}><table>
            <thead><tr><th>런 ID</th><th>변경 내용</th><th>확인 사항</th></tr></thead>
            <tbody>{preview.rows.filter((r) => r.changes.length || r.errors.length).map((r, i) => (
              <tr key={i} style={r.errors.length ? { background: "var(--err-soft)" } : undefined}>
                <td className="num">{r.code}</td>
                <td className="small">{r.changes.map((c) => `${c.field}: ${c.old ?? "–"} → ${c.new ?? "–"}`).join(", ")}</td>
                <td className="small">{[...r.errors, ...r.warnings].join(" ")}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Modal>
      )}
    </div>
  );
}

function FailModal({ run, status, onClose, onConfirm }: { run: Run; status: "failed" | "infeasible"; onClose: () => void; onConfirm: (r: string) => void }) {
  const [reason, setReason] = useState(FAIL_REASONS[0]);
  const [memo, setMemo] = useState("");
  return (
    <Modal title={`${run.code} ${status === "failed" ? "실패" : "실행 불가"}로 표시`} onClose={onClose} footer={<>
      <button onClick={onClose}>취소</button>
      <button className="danger" onClick={() => { onConfirm(memo ? `${reason}: ${memo}` : reason); onClose(); }}>표시</button>
    </>}>
      <p className="small muted" style={{ marginBottom: 10 }}>이 런은 분석에서 빠집니다. 실행 불가 조건이 특정 영역에 몰리면 알려 드립니다.</p>
      <div className="stack">
        <label className="field"><span className="lbl">사유</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>{FAIL_REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
        <label className="field"><span className="lbl">메모 (선택)</span><input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

function ExcludeModal({ run, onClose, onDone }: { run: Run; onClose: () => void; onDone: () => Promise<void> }) {
  const { project } = useProject();
  const toast = useToast();
  const [state, setState] = useState<Record<string, boolean>>({ ...run.excluded });
  const [reason, setReason] = useState("");
  const changed = project.config.responses.filter((r) => state[r.key] !== run.excluded[r.key] && run.values[r.key] != null);
  const save = async () => {
    try {
      for (const r of changed) await post(`/api/projects/${project.id}/runs/${run.id}/exclude`, { response_key: r.key, excluded: state[r.key], reason });
      toast("반영했습니다. 다음 분석부터 적용됩니다.");
      await onDone(); onClose();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <Modal title={`${run.code} 분석 제외`} onClose={onClose} footer={<>
      <button onClick={onClose}>취소</button>
      <button className="primary" disabled={!changed.length || !reason.trim()} onClick={save}>저장</button>
    </>}>
      <p className="small muted" style={{ marginBottom: 10 }}>측정값은 삭제되지 않고 분석에서만 빠집니다. 사유는 변경 이력에 남습니다.</p>
      {project.config.responses.map((r) => (
        <label key={r.key} className="check" style={{ display: "flex", marginBottom: 6 }}>
          <input type="checkbox" checked={!!state[r.key]} disabled={run.values[r.key] == null} onChange={(e) => setState({ ...state, [r.key]: e.target.checked })} />
          {r.name} ({run.values[r.key] ?? "값 없음"} {r.unit}) 분석에서 제외
        </label>
      ))}
      <label className="field" style={{ marginTop: 10 }}><span className="lbl">사유</span>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 측정 장비 교정 전 데이터" /></label>
    </Modal>
  );
}
