import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useGridSelect } from "../gridSelect";
import { parseClipboard } from "../paste";
import { useToast } from "../toast";

/** 엑셀처럼 입력하는 설정 표 (인자·응답). 외부 표를 붙여넣으면 머리글로 열을 맞추고, 행이 모자라면 추가한다. */
export interface GridCol<R> {
  key: keyof R & string;
  label: string;
  unit?: string;
  title?: string;              // 머리글 설명(툴팁)
  type?: "text" | "number" | "select";
  options?: [string, string][]; // select: [값, 표시]
  aliases?: string[];          // 붙여넣기 머리글로 인정할 다른 이름
  width?: number;
  placeholder?: string;
  disabled?: (r: R) => boolean;
  required?: boolean | ((r: R) => boolean); // 필수 칸 (함수면 행마다 다름, 머리글에는 * 표시)
  invalid?: (r: R) => boolean;               // 값이 잘못된 칸 (범위 밖 등) → 빨갛게
}

const norm = (s: string) => s.replace(/\[[^\]]*\]|\([^)]*\)/g, "").replace(/[\s_·:/]/g, "").toLowerCase();

/** 붙여넣은 글자를 선택 칸의 값으로 (값·표시 이름·별칭 어느 것이든) */
function toOption<R>(c: GridCol<R>, raw: string): string | null {
  const v = norm(raw);
  if (!v) return null;
  for (const [val, label] of c.options ?? []) {
    const names = [val, label, ...label.split(/[()·,/]/)].map(norm).filter(Boolean);
    if (names.some((x) => x === v || x.startsWith(v) || v.startsWith(x))) return val;
  }
  return null;
}

const isReq = <R,>(c: GridCol<R>, r: R) => (typeof c.required === "function" ? c.required(r) : !!c.required);

export function EditGrid<R extends Record<string, unknown>>({ name, rows, cols, onChange, makeRow, canAdd = true, canRemove, errors, addLabel, minRows = 1, showMissing = false, onPasted, pasteAnywhere = false }: {
  name: string; rows: R[]; cols: GridCol<R>[]; onChange: (rows: R[]) => void; makeRow: (existing: R[]) => R;
  canAdd?: boolean; canRemove?: (r: R) => boolean; errors?: (r: R) => string[]; addLabel: string; minRows?: number; showMissing?: boolean;
  /** 붙여넣은 뒤: 들어간 행 수, 머리글 중 표에 없는 열 이름(무시함) */
  onPasted?: (info: { rows: number; ignored: string[]; header: boolean }) => void;
  /** 입력 칸을 고르지 않고 화면 어디서 Ctrl+V 해도 이 표에 붙여넣기 (빈 행부터) */
  pasteAnywhere?: boolean;
}) {
  const id = (r: number, c: number) => `${name}-${r}-${c}`;
  const toast = useToast();
  const tableRef = useRef<HTMLTableElement>(null);
  const focus = (r: number, c: number) => document.getElementById(id(r, c))?.focus();
  const set = (i: number, k: keyof R, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const paste = (e: React.ClipboardEvent<HTMLElement>, row: number, col: number) => {
    const text = e.clipboardData.getData("text");
    if (!/[\t\n]/.test(text.trim())) return; // 한 칸은 기본 붙여넣기
    e.preventDefault();
    pasteText(text, row, col);
  };
  // 범위 선택(드래그) → Ctrl+C 복사, 범위를 고른 채 Ctrl+V 하면 그 범위 왼쪽 위 칸부터 붙여넣기
  useGridSelect(tableRef, (r, c) => toast(`${r}행 × ${c}열을 복사했습니다. 엑셀에 붙여넣으세요.`), (el, text) => {
    const m = el.id.match(/-(\d+)-(\d+)$/);
    if (m) pasteText(text, Number(m[1]), Number(m[2]));
  });
  /** fixedRow: 머리글이 있어도 row부터 (화면 어디서나 붙여넣기: 이미 입력한 행 아래부터) */
  const pasteText = (text: string, row: number, col: number, fixedRow = false) => {
    const lines = parseClipboard(text);
    if (!lines.length) return;
    // 머리글 행이면 열 이름으로 맞춘다 (2개 이상 일치할 때)
    const head = lines[0].map((h) => {
      const v = norm(h);
      return v ? cols.findIndex((c) => [c.label, c.key, ...(c.aliases ?? [])].map(norm).includes(v)) : -1;
    });
    const isHead = head.filter((x) => x >= 0).length >= 2;
    const body = isHead ? lines.slice(1) : lines;
    const start = isHead && !fixedRow ? 0 : row; // 머리글이 있으면 첫 행부터 열 이름으로 맞춘다
    const next = [...rows];
    body.forEach((cells, i) => {
      const at = start + i;
      if (at >= next.length) {
        if (!canAdd) return;
        next.push(makeRow(next));
      }
      const r: R = { ...next[at] };
      cells.forEach((raw, j) => {
        const ci = isHead ? head[j] : col + j;
        const c = ci >= 0 ? cols[ci] : undefined;
        if (!c || c.disabled?.(r)) return;
        const v = raw.trim();
        if (c.type === "select") {
          const opt = toOption(c, v);
          if (opt !== null) (r as Record<string, unknown>)[c.key] = opt;
        } else (r as Record<string, unknown>)[c.key] = c.type === "number" ? v.replace(/,/g, "") : v;
      });
      next[at] = r;
    });
    onChange(next);
    onPasted?.({ rows: body.length, header: isHead, ignored: isHead ? lines[0].filter((h, j) => h.trim() && head[j] < 0) : [] });
  };
  const pasteRef = useRef(pasteText);
  pasteRef.current = pasteText;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const colsRef = useRef(cols);
  colsRef.current = cols;
  useEffect(() => {
    if (!pasteAnywhere) return;
    const h = (e: ClipboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text.trim()) return;
      e.preventDefault();
      // 이미 입력한 마지막 행 다음부터 (선택 상자·읽기 전용 칸은 내용으로 보지 않음)
      const filled = (r: R) => colsRef.current.some((c) => c.type !== "select" && !c.disabled?.(r) && String(r[c.key] ?? "").trim() !== "");
      let last = -1;
      rowsRef.current.forEach((r, i) => { if (filled(r)) last = i; });
      pasteRef.current(text, last + 1, 0, true);
    };
    document.addEventListener("paste", h);
    return () => document.removeEventListener("paste", h);
  }, [pasteAnywhere]);

  return (
    <div>
      <div className="table-wrap">
        <table className="grid-table edit-grid" ref={tableRef}>
          <thead><tr>
            <th style={{ width: 40 }}><span className="sr-only">삭제</span></th>
            <th className="r" style={{ width: 36 }}>#</th>
            {cols.map((c) => (
              <th key={c.key} title={[c.title, typeof c.required === "function" ? "조건부 필수" : c.required ? "필수" : ""].filter(Boolean).join(" · ") || undefined}
                className={c.required ? "req" : ""} style={c.width ? { minWidth: c.width } : undefined}>
                {c.label}{c.required && <span className="req-mark" aria-label={typeof c.required === "function" ? "조건부 필수" : "필수"}>*</span>}
                {c.unit && <span className="unit"> {c.unit}</span>}
              </th>
            ))}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const errs = errors?.(r) ?? [];
              return (
                <tr key={i} className={errs.length ? "has-err" : ""} title={errs.join(" ") || undefined}>
                  <td className="ro del-cell">
                    <button className="icon-btn danger" aria-label={`${i + 1}행 삭제`} title="행 삭제"
                      disabled={rows.length <= minRows || (canRemove ? !canRemove(r) : false)}
                      onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                  </td>
                  <td className="ro r num row-no">{i + 1}</td>
                  {cols.map((c, ci) => {
                    const v = String(r[c.key] ?? "");
                    const dis = c.disabled?.(r) ?? false;
                    const common = {
                      id: id(i, ci), disabled: dis, "aria-label": `${c.label} ${i + 1}행`,
                      onPaste: (e: React.ClipboardEvent<HTMLElement>) => paste(e, i, ci),
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === "Enter") { e.preventDefault(); focus(e.shiftKey ? i - 1 : i + 1, ci); }
                      },
                    };
                    const missing = (showMissing && !dis && isReq(c, r) && v.trim() === "") || (!dis && v.trim() !== "" && !!c.invalid?.(r));
                    return (
                      <td key={c.key} className={`${dis ? "ro" : c.type === "number" ? "" : "text"} ${missing ? "bad" : ""} ${!dis && isReq(c, r) ? "req-cell" : ""}`}>
                        {c.type === "select" ? (
                          <select {...common} value={v} onChange={(e) => set(i, c.key, e.target.value)}>
                            {c.options!.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                          </select>
                        ) : (
                          <input {...common} type="text" inputMode={c.type === "number" ? "decimal" : "text"} value={v}
                            placeholder={c.placeholder} onChange={(e) => set(i, c.key, e.target.value)} />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canAdd && <button className="small" style={{ marginTop: 8 }} onClick={() => onChange([...rows, makeRow(rows)])}><Plus size={14} />{addLabel}</button>}
      {rows.some((r) => (errors?.(r) ?? []).length) && (
        <ul className="grid-errors">{rows.map((r, i) => (errors?.(r) ?? []).map((m) => <li key={`${i}${m}`}>{i + 1}행: {m}</li>))}</ul>
      )}
    </div>
  );
}
