import { ClipboardPaste, Copy, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, del, get, post } from "../api";
import { Confirm, Modal } from "../components/Modal";
import { FAIL_REASONS, RunCard, type RowPatch } from "../components/RunCard";
import { fmtFactor, STATUS_LABEL, when } from "../format";
import { useGridSelect } from "../gridSelect";
import { copyText, matchHeader, parseClipboard, toTsv, type PasteTarget } from "../paste";
import { can, useProject } from "../project";
import { useToast } from "../toast";
import type { Batch, Run } from "../types";

type Edit = { actual: Record<string, string>; values: Record<string, string>; note: string; status?: string; fail_reason?: string };
type Col = PasteTarget;
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
const isEditable = (el: Element | null) => !!el && (el.matches("input, textarea, select") || (el as HTMLElement).isContentEditable);

/** 실험 표(① 실험하기): 실험 조건(인자별 열)과 결과 입력을 한 표에서.
 *  기본은 남은 실험만, 세팅값 칸은 필요할 때만 연다. 끝난 실험도 보면 이상치 제외를 할 수 있다.
 *  엑셀과는 파일 대신 복사·붙여넣기로 주고받는다 (사내 보안 정책상 파일은 읽을 수 없음). */
export default function ResultsSection() {
  const { project, reload } = useProject();
  const toast = useToast();
  const tableRef = useRef<HTMLTableElement>(null);
  const narrow = useNarrow();
  const fs = project.config.factors;
  const rs = project.config.responses;
  const draftKey = `redo.draft.${project.id}`;
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [loadSeq, setLoadSeq] = useState(0);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [onlyOpen, setOnlyOpen] = useState(false); // 기본: 모든 실험 (조건·결과는 언제든 수정)
  const [edits, setEdits] = useState<Record<number, Edit>>(() => {
    try { return JSON.parse(localStorage.getItem(draftKey) || "{}"); } catch { return {}; }
  });
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [state, setState] = useState<SaveState>(Object.keys(edits).length ? "dirty" : "idle");
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [failFor, setFailFor] = useState<Run | null>(null);
  const [deleteFor, setDeleteFor] = useState<Run | null>(null);
  const [cancel, setCancel] = useState<Batch | null>(null);
  const savingRef = useRef(false);
  const readOnly = !can(project.my_role, "runner");
  const editor = can(project.my_role, "editor");

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

  // 입력 가능한 칸의 순서 (붙여넣기·키보드 이동 기준): [세팅값] → 결과 → 메모
  const cols: Col[] = useMemo(() => [
    ...fs.map((f) => ({ kind: "act" as const, key: f.key })),
    ...rs.map((r) => ({ kind: "val" as const, key: r.key })),
    { kind: "note" as const, key: "note" },
  ], [fs, rs]);
  const actCols = cols.filter((c) => c.kind === "act");
  const valCols = cols.filter((c) => c.kind === "val");
  const noteCol = cols.find((c) => c.kind === "note")!;

  // 보이는 행 목록은 필터를 바꾸거나 목록을 다시 불러올 때만 다시 정한다.
  // 자동 저장으로 런이 '완료'가 되어도 입력 중인 행이 사라지거나 행 번호(cell-행-열)가 밀리지 않게 하기 위함.
  const [visibleIds, setVisibleIds] = useState<Set<number> | null>(null);
  useEffect(() => {
    if (!runs) return;
    setVisibleIds(new Set(runs.filter((r) => !onlyOpen || r.status === "planned" || r.status === "running" || edits[r.id]).map((r) => r.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyOpen, loadSeq]);
  const shown = useMemo(() => (runs ?? []).filter((r) => visibleIds?.has(r.id)), [runs, visibleIds]);
  // 반복 표시: 같은 차수 안에서 같은 조건을 여러 번 하는 런은 '몇 번째/전체'(예: 2/3), 지난 차수 조건을 다시 하면 '재확인'
  const repLabel = useMemo(() => {
    const groups = new Map<string, Run[]>();
    for (const r of runs ?? []) {
      const k = `${r.batch_id}|${fs.map((f) => r.planned[f.key]).join(",")}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const out = new Map<number, string>();
    for (const g of groups.values()) {
      const sorted = [...g].sort((a, b) => a.run_order - b.run_order);
      sorted.forEach((r, i) => {
        if (sorted.length > 1) out.set(r.id, `${i + 1}/${sorted.length}`);
        else if (r.is_replicate_of_existing) out.set(r.id, "재확인");
      });
    }
    return out;
  }, [runs, fs]);

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
  const allCols: Col[] = [...fs.map((f) => ({ kind: "act" as const, key: f.key })), ...rs.map((x) => ({ kind: "val" as const, key: x.key })), { kind: "note", key: "note" }];
  const rowValid = (r: Run) => allCols.every((c) => !cellClass(r, c).includes("bad"));

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

  /** 엑셀 붙여넣기. 머리글 행이 있으면 열 이름으로, 첫 열이 런 ID면 런 ID로 맞추고, 아니면 고른 칸부터 차례로 채운다. */
  const applyPaste = (text: string, startRow: number | null, startCol: number | null): boolean => {
    if (!runs) return false;
    const rows = parseClipboard(text);
    if (!rows.length) return false;
    const header = matchHeader(rows[0], fs, rs);
    const body = header ? rows.slice(1) : rows;
    const byCode = new Map(runs.map((r) => [r.code.toUpperCase(), r]));
    // 런 ID는 '1차-01' 형식. 예전에 인쇄한 시트의 'B1-01'도 같은 런으로 인식한다
    const codeOf = (cells: string[], i: number) => (cells[i] ?? "").trim().replace(/\s+/g, "").toUpperCase().replace(/^B(\d+)-/, "$1차-");
    const codeIdx = header ? header.indexOf("code") : body.every((c) => byCode.has(codeOf(c, 0))) ? 0 : -1;
    const keyed = !!header || codeIdx >= 0; // 머리글·런 ID로 맞출 때는 빈 칸으로 기존 값을 지우지 않는다
    const firstVal = cols.findIndex((c) => c.kind === "val");
    const missing: string[] = [];
    const plan: { run: Run; sets: [Col, string][] }[] = [];
    body.forEach((cells, i) => {
      let run: Run | undefined;
      if (codeIdx >= 0) {
        run = byCode.get(codeOf(cells, codeIdx));
        if (!run) { if (codeOf(cells, codeIdx)) missing.push(cells[codeIdx].trim()); return; }
      } else run = shown[(startRow ?? 0) + i];
      if (!run) return;
      const sets: [Col, string][] = [];
      if (header) header.forEach((t, j) => { if (t && t !== "code") sets.push([t, cells[j] ?? ""]); });
      else {
        const rest = codeIdx === 0 ? cells.slice(1) : cells;
        const c0 = startCol ?? Math.max(firstVal, 0);
        rest.forEach((v, j) => { const c = cols[c0 + j]; if (c) sets.push([c, v]); });
      }
      plan.push({ run, sets: sets.filter(([, v]) => !(keyed && v.trim() === "")) });
    });
    if (!plan.length) {
      if (missing.length) toast(`표에 없는 런 ID입니다: ${missing.slice(0, 5).join(", ")}`, true);
      return missing.length > 0;
    }
    setEdits((prev) => {
      const next = { ...prev };
      for (const { run, sets } of plan) {
        const ed = { ...(next[run.id] ?? base(run)) };
        ed.actual = { ...ed.actual }; ed.values = { ...ed.values };
        for (const [c, v] of sets) {
          const s = c.kind === "note" ? v : v.trim();
          if (c.kind === "act") ed.actual[c.key] = s;
          else if (c.kind === "val") ed.values[c.key] = s;
          else ed.note = s;
        }
        next[run.id] = ed;
      }
      return next;
    });
    setVisibleIds((prev) => new Set([...(prev ?? []), ...plan.map((p) => p.run.id)]));
    setState("dirty");
    const how = [header && "머리글로 열을 맞춤", codeIdx >= 0 && "런 ID로 행을 맞춤"].filter(Boolean).join(", ");
    toast(`${plan.length}행을 붙여넣었습니다${how ? ` (${how})` : ""}.${missing.length ? ` 표에 없는 런 ID ${missing.length}개는 건너뜀.` : ""}`);
    return true;
  };
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, row: number, col: number) => {
    const text = e.clipboardData.getData("text");
    if (!/[\t\n]/.test(text.trim())) return; // 한 칸짜리는 기본 붙여넣기
    e.preventDefault();
    e.stopPropagation();
    applyPaste(text, row, col);
  };
  // 범위 선택(드래그) → Ctrl+C 복사, 범위를 고른 채 Ctrl+V 하면 그 범위 왼쪽 위 칸부터 붙여넣기
  useGridSelect(tableRef, (r, c) => toast(`${r}행 × ${c}열을 복사했습니다. 엑셀에 붙여넣으세요.`), (el, text) => {
    const m = el.id.match(/^cell-(\d+)-(\d+)$/);
    if (m && !readOnly) applyPaste(text, Number(m[1]), Number(m[2]));
  });
  // 칸을 고르지 않고 화면 어디서나 Ctrl+V 해도 표에 들어가게 (입력 칸 밖에서만)
  const pasteRef = useRef(applyPaste);
  pasteRef.current = applyPaste;
  useEffect(() => {
    if (readOnly) return;
    const h = (e: ClipboardEvent) => {
      if (isEditable(document.activeElement) || document.querySelector(".modal-back")) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (text.trim() && pasteRef.current(text, null, null)) e.preventDefault();
    };
    document.addEventListener("paste", h);
    return () => document.removeEventListener("paste", h);
  }, [readOnly]);

  const copyTable = async () => {
    const head = ["런 ID", "순서", ...fs.map((f) => `${f.name} [${f.unit}]`), ...rs.map((x) => `${x.name}${x.unit ? ` [${x.unit}]` : ""}`), "메모", "상태"];
    const body = shown.map((r) => [r.code, r.run_order, ...fs.map((f) => cell(r, { kind: "act", key: f.key })),
      ...rs.map((x) => cell(r, { kind: "val", key: x.key })), cell(r, { kind: "note", key: "note" }), STATUS_LABEL[r.status]]);
    await copyText(toTsv([head, ...body]));
    toast(`표 ${shown.length}행을 복사했습니다. 엑셀에 붙여넣어 쓰고, 결과를 채운 뒤 다시 복사해 이 화면에 붙여넣으세요.`);
  };

  const onCardSave = async (p: RowPatch) => {
    await saveRows([p], {});
    await load();
  };


  if (!runs || !visibleIds) return <div className="busy"><span className="spinner" /> 불러오는 중</div>;
  if (runs.length === 0) return <div className="panel empty"><h3>실험이 없습니다</h3><p>먼저 첫 실험 계획을 만드세요.</p></div>;

  const stateText: Record<SaveState, string> = {
    idle: "", dirty: "입력 중 · 잠시 후 자동 저장", saving: "저장 중",
    saved: lastSaved ? `저장됨 · ${when(lastSaved)}` : "저장됨",
    offline: "서버에 연결할 수 없어 이 브라우저에 임시 저장했습니다. 연결되면 자동으로 저장합니다.",
    error: "저장하지 못한 입력이 있습니다. 빨간 칸을 확인하세요.",
  };
  const warnRuns = Object.entries(warnings).filter(([, w]) => w.length);
  // 가장 최근 차수가 아직 하나도 시작하지 않았으면 취소할 수 있다
  const latest = [...batches].sort((a, b) => b.seq - a.seq)[0];
  const canCancel = !!latest && runs.filter((r) => r.batch_id === latest.id).every((r) => r.status === "planned");
  const input = (r: Run, c: Col, ri: number) => {
    const ci = cols.findIndex((x) => x.kind === c.kind && x.key === c.key);
    const f = c.kind === "act" ? fs.find((x) => x.key === c.key)! : null;
    return (
      <td key={c.kind + c.key} className={cellClass(r, c)} style={c.kind === "note" ? { minWidth: 150 } : { minWidth: 90 }}
        title={f ? `계획값 ${fmtFactor(r.planned[c.key], f)}${f.unit}` : c.kind === "val" && r.excluded[c.key] ? "분석에서 제외됨" : undefined}>
        <input id={`cell-${ri}-${ci}`} type="text" inputMode={c.kind === "note" ? "text" : "decimal"} value={cell(r, c)} disabled={readOnly}
          style={c.kind === "val" && r.excluded[c.key] ? { textDecoration: "line-through" } : undefined}
          onChange={(e) => setCell(r, c, e.target.value)} onKeyDown={(e) => onKey(e, ri, ci)} onPaste={(e) => onPaste(e, ri, ci)}
          aria-label={`${r.code} ${c.kind === "note" ? "메모" : f ? f.name + " 실제값" : rs.find((x) => x.key === c.key)!.name}`} />
      </td>
    );
  };

  return (
    <div className="stack">
      <div>
        <div className="row table-tools">
          <button className="small" onClick={copyTable} disabled={!shown.length}><Copy size={14} />표 복사 (엑셀로)</button>
          <label className="check small"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />남은 실험만 보기</label>
          <span className="grow" />
          <span className={`save-state ${state === "dirty" || state === "saving" ? "dirty" : state === "offline" ? "offline" : ""}`} role="status">{stateText[state]}</span>
          {!readOnly && state !== "idle" && state !== "saved" && <button className="small primary" onClick={flush}>지금 저장</button>}
          {editor && canCancel && <button className="small danger" onClick={() => setCancel(latest)}><X size={14} />{latest.seq}차 취소</button>}
        </div>
        {!readOnly && (
          <div className="paste-hint">
            <ClipboardPaste size={15} />
            <span>엑셀에서 복사해 <b>Ctrl+V</b> · 런 ID·머리글을 함께 붙여도 자동으로 맞춤 · 표를 드래그해 고른 칸은 <b>Ctrl+C</b>로 엑셀에 복사 · 자동 저장</span>
          </div>
        )}
        {shown.length === 0 && <div className="empty"><h3>남은 실험이 없습니다</h3><p>모든 결과가 입력되었습니다.</p></div>}

        {narrow ? shown.map((r) => (
          <RunCard key={r.id + r.updated_at} run={r} factors={fs} responses={rs} onSave={onCardSave} warnings={warnings[String(r.id)]} readOnly={readOnly} />
        )) : shown.length > 0 && (
          <div className="table-wrap">
            <table className="grid-table" ref={tableRef}>
              <thead>
                <tr>
                  {editor && <th style={{ width: 40 }}><span className="sr-only">삭제</span></th>}
                  <th>런 ID</th><th className="r">순서</th>
                  {fs.map((f) => <th key={f.key} className="r cond-col" title={`설정 범위 ${f.low}~${f.high}, ${f.step} 단위. 계획과 다르게 세팅했으면 고치세요.`}>{f.name} <span className="unit">{f.unit}</span></th>)}
                  {rs.map((x) => <th key={x.key} className="r val-col">{x.name} <span className="unit">{x.unit}</span></th>)}
                  <th title="같은 조건을 여러 번 하는 실험: 몇 번째/전체. 재확인 = 지난 차수에서 한 조건을 다시 측정">반복</th><th>메모</th><th>상태</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, ri) => {
                  const w = warnings[String(r.id)];
                  const er = errors[String(r.id)];
                  return (
                    <tr key={r.id} className={r.status}>
                      {editor && (
                        <td className="ro del-cell">
                          <button className="icon-btn danger" aria-label={`${r.code} 삭제`} title="이 런 삭제" onClick={() => setDeleteFor(r)}><Trash2 size={14} /></button>
                        </td>
                      )}
                      <td className="ro num" title={[...(w ?? []), ...(er ?? [])].join("\n") || undefined}>
                        {r.code}{(w?.length || er?.length) ? <span style={{ color: er?.length ? "var(--err)" : "var(--warn)" }}> ⚠</span> : null}
                      </td>
                      <td className="ro r num">{r.run_order}</td>
                      {actCols.map((c) => input(r, c, ri))}
                      {valCols.map((c) => input(r, c, ri))}
                      <td className="ro rep-cell" title={r.reason || undefined}>{repLabel.get(r.id) ?? ""}</td>
                      {input(r, noteCol, ri)}
                      <td className="ro status-cell" aria-label={`${r.code} 상태`} data-copy={r.status === "running" ? STATUS_LABEL.planned : STATUS_LABEL[r.status]}>
                        {r.status === "done" ? <span className="chip ok">완료</span>
                          : r.status === "failed" || r.status === "infeasible" ? (
                            <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                              <span className="chip err" title={r.fail_reason || undefined}>{STATUS_LABEL[r.status]}</span>
                              {!readOnly && <button className="link-btn small" onClick={() => void saveRows([{ run_id: r.id, status: "planned" }], {})}>되돌리기</button>}
                            </span>
                          ) : (
                            <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                              <span className="muted small">대기</span>
                              {!readOnly && <button className="ghost small" title="실험을 못 했으면 실패·실행불가로 표시" onClick={() => setFailFor(r)}>못 함</button>}
                            </span>
                          )}
                      </td>
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

      {failFor && <FailModal run={failFor} onClose={() => setFailFor(null)}
        onConfirm={(status, reason) => saveRows([{ run_id: failFor.id, status, fail_reason: reason }], {})} />}
      {deleteFor && <Confirm title={`${deleteFor.code} 삭제`} danger confirmLabel="삭제" onClose={() => setDeleteFor(null)}
        message={<>이 런을 표와 학습에서 뺍니다.{deleteFor.status === "done" ? " 입력한 결과도 학습에 쓰지 않습니다." : ""} 기록은 남아 있어 필요하면 복구할 수 있습니다.</>}
        onConfirm={async () => {
          try { await del(`/api/projects/${project.id}/runs/${deleteFor.id}`); toast(`${deleteFor.code}을(를) 삭제했습니다.`); await load(); await reload(); }
          catch (e) { toast((e as Error).message, true); }
        }} />}
      {cancel && <Confirm title="차수 취소" danger confirmLabel="이 차수 취소" onClose={() => setCancel(null)}
        message={`${cancel.seq}차의 계획된 실험 ${cancel.runs_total}건을 삭제합니다. 아직 시작하지 않은 차수만 취소할 수 있습니다.`}
        onConfirm={async () => {
          try { await del(`/api/projects/${project.id}/batches/${cancel.id}`); toast("차수를 취소했습니다."); await load(); await reload(); }
          catch (e) { toast((e as Error).message, true); }
        }} />}
    </div>
  );
}

function FailModal({ run, onClose, onConfirm }: { run: Run; onClose: () => void; onConfirm: (s: "failed" | "infeasible", r: string) => void }) {
  const [status, setStatus] = useState<"failed" | "infeasible">("failed");
  const [reason, setReason] = useState(FAIL_REASONS[0]);
  const [memo, setMemo] = useState("");
  return (
    <Modal title={`${run.code} 실험을 못 했어요`} onClose={onClose} footer={<>
      <button onClick={onClose}>취소</button>
      <button className="danger" onClick={() => { onConfirm(status, memo ? `${reason}: ${memo}` : reason); onClose(); }}>표시</button>
    </>}>
      <p className="small muted" style={{ marginBottom: 10 }}>이 런은 학습에서 빠집니다. 되돌리기로 언제든 취소할 수 있습니다.</p>
      <div className="stack">
        <span className="seg" role="radiogroup" aria-label="종류">
          <button role="radio" aria-checked={status === "failed"} className={status === "failed" ? "on" : ""} onClick={() => setStatus("failed")}>실패 (했지만 결과를 못 얻음)</button>
          <button role="radio" aria-checked={status === "infeasible"} className={status === "infeasible" ? "on" : ""} onClick={() => setStatus("infeasible")}>실행 불가 (조건을 맞출 수 없음)</button>
        </span>
        <label className="field"><span className="lbl">사유</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>{FAIL_REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
        <label className="field"><span className="lbl">메모 (선택)</span><input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      </div>
    </Modal>
  );
}
