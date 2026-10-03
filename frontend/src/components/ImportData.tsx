import { AlertTriangle, ClipboardPaste, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { get, patch, post } from "../api";
import { notifyProjectsChanged } from "../guide/steps";
import { useProject } from "../project";
import { useToast } from "../toast";
import type { Batch, Run } from "../types";
import { EditGrid, type GridCol } from "./EditGrid";

/** 이미 해 둔 실험 데이터 가져오기: 엑셀 표를 머리글째 복사해 붙여넣는다 (사내 보안상 파일 업로드 대신 클립보드).
 *  같은 조건이 여러 행이면 반복 측정으로 보고, 인자 값은 반올림하지 않고 실제 세팅값 그대로 학습한다. */
type Row = Record<string, string>;
interface ImportResult { batch: Batch; imported: number; done: number; replicated_conditions: number }

const num = (s: string | undefined) => {
  const t = (s ?? "").replace(/,/g, "").trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
};

export function ImportData({ onDone, onCancel, start = false }: { onDone: (r: ImportResult) => void; onCancel?: () => void; start?: boolean }) {
  const { project, reload } = useProject();
  const toast = useToast();
  const fs = project.config.factors;
  const rs = project.config.responses;
  const empty = (): Row => Object.fromEntries([...fs.map((f) => [f.key, ""]), ...rs.map((r) => [r.key, ""]), ["note", ""], ["_rep", ""]]);
  const [rows, setRows] = useState<Row[]>(() => [empty(), empty(), empty()]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // 이미 있는 실험과 조건·결과가 모두 같은 행 = 중복 (표 복사한 것을 다시 붙여넣은 경우 등). 중복은 반복 측정으로 잘못 학습된다.
  const [existing, setExisting] = useState<Set<string>>(new Set());
  useEffect(() => {
    get<Run[]>(`/api/projects/${project.id}/runs`).then((rs0) => setExisting(new Set(rs0.map((r) =>
      [...fs.map((f) => r.actual[f.key]), ...rs.map((x) => r.values[x.key] ?? "")].map((v) => (v === "" ? "" : String(Number(v)))).join("|"))))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);
  const sig = (r: Row) => [...fs.map((f) => num(r[f.key])), ...rs.map((x) => num(r[x.key]))].map((v) => (v === null ? "" : String(v))).join("|");
  const isDup = (r: Row) => !isBlank(r) && existing.has(sig(r));

  const isBlank = (r: Row) => [...fs.map((f) => f.key), ...rs.map((x) => x.key), "note"].every((k) => (r[k] ?? "").trim() === "");
  const condKey = (r: Row) => fs.map((f) => num(r[f.key])).join("|");

  // 반복 표시: 같은 조건 몇 번째/전체
  const withRep = (list: Row[]): Row[] => {
    const total = new Map<string, number>();
    for (const r of list) if (!isBlank(r)) total.set(condKey(r), (total.get(condKey(r)) ?? 0) + 1);
    const seen = new Map<string, number>();
    return list.map((r) => {
      if (isBlank(r) || fs.some((f) => num(r[f.key]) === null)) return { ...r, _rep: "" };
      const k = condKey(r);
      const i = (seen.get(k) ?? 0) + 1;
      seen.set(k, i);
      const n = total.get(k) ?? 1;
      return { ...r, _rep: n > 1 ? `${i}/${n}` : "" };
    });
  };
  const change = (list: Row[]) => setRows(withRep(list));

  const cols: GridCol<Row>[] = [
    ...fs.map<GridCol<Row>>((f) => ({
      key: f.key, label: f.name, unit: f.unit, type: "number", width: 100, aliases: [f.key, `${f.name}${f.unit}`],
      title: `설정 범위 ${f.low}~${f.high}`,
      required: (r) => !isBlank(r),
      invalid: (r) => { const v = num(r[f.key]); return v === null || Number.isNaN(v) || v < f.low - 1e-9 || v > f.high + 1e-9; },
    })),
    ...rs.map<GridCol<Row>>((x) => ({
      key: x.key, label: x.name, unit: x.unit, type: "number", width: 100, aliases: [x.key, `${x.name}${x.unit}`],
      invalid: (r) => Number.isNaN(num(r[x.key])),
    })),
    { key: "_rep", label: "반복", width: 60, disabled: () => true, title: "같은 조건이 여러 행이면 반복 측정으로 봅니다 (산포 추정에 쓰임)" },
    { key: "note", label: "메모", width: 160, aliases: ["비고", "note", "memo", "특이사항"] },
  ];

  const filled = rows.filter((r) => !isBlank(r));
  const sum = useMemo(() => {
    const missing = filled.filter((r) => fs.some((f) => num(r[f.key]) === null)).length;
    const notNum = filled.filter((r) => [...fs, ...rs].some((c) => Number.isNaN(num(r[c.key])))).length;
    const out = fs.map((f) => {
      const vs = filled.map((r) => num(r[f.key])).filter((v): v is number => v !== null && !Number.isNaN(v));
      const bad = vs.filter((v) => v < f.low - 1e-9 || v > f.high + 1e-9);
      return { f, n: bad.length, lo: Math.min(f.low, ...vs), hi: Math.max(f.high, ...vs) };
    }).filter((o) => o.n > 0);
    const withResult = filled.filter((r) => rs.some((x) => { const v = num(r[x.key]); return v !== null && !Number.isNaN(v); })).length;
    const counts = new Map<string, number>();
    for (const r of filled) counts.set(condKey(r), (counts.get(condKey(r)) ?? 0) + 1);
    const repConds = [...counts.values()].filter((c) => c >= 2).length;
    return { missing, notNum, out, withResult, repConds };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, project.config]);
  const dupRows = filled.filter(isDup).length;
  const outRows = filled.filter((r) => fs.some((f) => { const v = num(r[f.key]); return v !== null && !Number.isNaN(v) && (v < f.low - 1e-9 || v > f.high + 1e-9); })).length;
  const blocked = !filled.length || sum.missing > 0 || sum.notNum > 0 || sum.out.length > 0 || busy;

  const widen = async () => {
    setBusy(true);
    try {
      const factors = fs.map((f) => { const o = sum.out.find((x) => x.f.key === f.key); return o ? { ...f, low: o.lo, high: o.hi } : f; });
      await patch(`/api/projects/${project.id}`, {
        config: { ...project.config, factors },
        change_reason: `기존 데이터 가져오기: ${sum.out.map((o) => `${o.f.name} ${o.lo}~${o.hi}`).join(", ")}로 범위 확장`,
      });
      await reload();
      toast("인자 범위를 기존 데이터에 맞춰 넓혔습니다.");
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const dropOut = () => change(rows.filter((r) => isBlank(r) || !fs.some((f) => { const v = num(r[f.key]); return v !== null && !Number.isNaN(v) && (v < f.low - 1e-9 || v > f.high + 1e-9); })));

  const submit = async () => {
    setBusy(true);
    try {
      const body = filled.map((r) => ({
        x: Object.fromEntries(fs.map((f) => [f.key, num(r[f.key])])),
        values: Object.fromEntries(rs.map((x) => [x.key, num(r[x.key])])),
        note: (r.note ?? "").trim(),
      }));
      const res = await post<ImportResult>(`/api/projects/${project.id}/import`, { rows: body });
      await reload();
      notifyProjectsChanged();
      toast(`기존 데이터 ${res.imported}건을 가져왔습니다 (결과 있음 ${res.done}건).`);
      onDone(res);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  return (
    <div className="stack import-data">
      <div className="paste-hint">
        <ClipboardPaste size={14} />
        <span>엑셀에서 <b>머리글까지</b> 복사해 <b>Ctrl+V</b> · 열 이름으로 인자·결과를 자동으로 맞춤(순서 무관) · 같은 조건이 여러 행이면 반복 측정 · 결과가 비어도 됨(나중에 입력)</span>
      </div>
      {ignored.length > 0 && <p className="small muted">이 DOE에 없는 열은 빼고 가져왔습니다: {ignored.join(", ")}</p>}
      <EditGrid name="imp" rows={rows} cols={cols} onChange={change} makeRow={empty} addLabel="행 추가" showMissing pasteAnywhere
        onPasted={(i) => { setIgnored(i.ignored); if (i.rows) toast(`${i.rows}행을 붙여넣었습니다.`); }} />

      {sum.out.length > 0 && (
        <div className="notice warn" role="alert">
          <AlertTriangle size={16} />
          <div className="grow">
            <div>설정 범위 밖 값이 있습니다: {sum.out.map((o) => <span key={o.f.key}><b>{o.f.name}</b> {o.n}행 (설정 {o.f.low}~{o.f.high}) </span>)}</div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="small" disabled={busy} onClick={widen}>범위를 {sum.out.map((o) => `${o.f.name} ${o.lo}~${o.hi}`).join(", ")}로 넓히기</button>
              <button className="small ghost" disabled={busy} onClick={dropOut}>범위 밖 {outRows}행 빼기</button>
            </div>
          </div>
        </div>
      )}
      {dupRows > 0 && (
        <div className="notice warn" role="alert">
          <AlertTriangle size={16} />
          <div className="grow">
            이미 이 DOE에 있는 실험과 조건·결과가 똑같은 행이 <b>{dupRows}개</b> 있습니다. 같은 데이터를 두 번 넣으면 반복 측정으로 잘못 학습됩니다.
            <div style={{ marginTop: 8 }}><button className="small" onClick={() => change(rows.filter((r) => !isDup(r)))}>중복 {dupRows}행 빼기</button></div>
          </div>
        </div>
      )}
      {(sum.missing > 0 || sum.notNum > 0) && (
        <p className="small" style={{ color: "var(--err)" }} role="alert">
          {sum.missing > 0 && `인자 값이 빠진 행 ${sum.missing}개 `}{sum.notNum > 0 && `숫자가 아닌 칸이 있는 행 ${sum.notNum}개 `}— 빨간 칸을 고치거나 행을 지우세요.
        </p>
      )}
      {filled.length > 0 && sum.repConds === 0 && (
        <p className="small muted">같은 조건을 반복한 데이터가 없어 산포(흩어짐) 추정이 어렵습니다. 다음 제안에 반복 실험이 들어갑니다.</p>
      )}

      <div className="step-foot">
        <span className="muted small">{filled.length ? `${filled.length}건 · 결과 있음 ${sum.withResult}건 · 반복한 조건 ${sum.repConds}개` : "아직 붙여넣은 데이터가 없습니다"}</span>
        <span className="grow" />
        {onCancel && <button onClick={onCancel}>취소</button>}
        <button className={`primary ${start ? "big" : ""}`} disabled={blocked} onClick={submit}>
          <Upload size={16} />{busy ? "가져오는 중…" : `${filled.length}건 가져오기${start ? " → 능동학습" : ""}`}
        </button>
      </div>
    </div>
  );
}
