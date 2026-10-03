/** 엑셀처럼 표에서 여러 칸을 골라 Ctrl+C로 복사 (엑셀에 바로 붙여넣을 수 있는 탭 구분 텍스트).
 *  - 칸을 누른 채 다른 칸으로 끌기, 또는 Shift+클릭 → 사각형 범위 선택
 *  - 머리글을 누르면 그 열 전체, 머리글을 끌거나 Shift+클릭하면 여러 열
 *  - Esc 또는 표 밖을 누르면 선택 해제
 *  - 범위를 고른 상태에서 Ctrl+V → 범위의 왼쪽 위 입력 칸부터 붙여넣기 (onPasteAt)
 *  삭제 버튼 열(.del-cell)은 복사하지 않는다. 칸의 값은 입력 칸 값 → 선택 상자 표시 이름 → data-copy → 글자 순. */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { toTsv } from "./paste";

type Pos = { r: number; c: number }; // r = -1 은 머리글
type Range = { a: Pos; b: Pos; cols: boolean }; // cols: 머리글로 고른 열 전체

const bodyRows = (t: HTMLTableElement) => Array.from(t.tBodies[0]?.rows ?? []);

function posOf(t: HTMLTableElement, el: EventTarget | null): Pos | null {
  const cell = (el as HTMLElement | null)?.closest?.("td, th") as HTMLTableCellElement | null;
  if (!cell || cell.closest("table") !== t) return null;
  const tr = cell.parentElement as HTMLTableRowElement;
  if (tr.parentElement?.tagName === "THEAD") return { r: -1, c: cell.cellIndex };
  return { r: bodyRows(t).indexOf(tr), c: cell.cellIndex };
}

function bounds(t: HTMLTableElement, rg: Range) {
  const n = bodyRows(t).length;
  return {
    r0: rg.cols ? 0 : Math.max(0, Math.min(rg.a.r, rg.b.r)),
    r1: rg.cols ? n - 1 : Math.min(n - 1, Math.max(rg.a.r, rg.b.r)),
    c0: Math.min(rg.a.c, rg.b.c),
    c1: Math.max(rg.a.c, rg.b.c),
  };
}

function cellText(td: HTMLTableCellElement | undefined): string {
  if (!td) return "";
  const input = td.querySelector("input, textarea") as HTMLInputElement | null;
  if (input) return input.value;
  const sel = td.querySelector("select") as HTMLSelectElement | null;
  if (sel) return sel.selectedOptions[0]?.text ?? sel.value;
  if (td.dataset.copy !== undefined) return td.dataset.copy;
  return (td.innerText ?? "").replace(/\s+/g, " ").trim();
}

export function useGridSelect(ref: RefObject<HTMLTableElement>, onCopied?: (rows: number, cols: number) => void,
  onPasteAt?: (input: HTMLElement, text: string) => void) {
  const range = useRef<Range | null>(null);
  const drag = useRef<Pos | null>(null);
  const anchor = useRef<Pos | null>(null);
  const copied = useRef(onCopied);
  copied.current = onCopied;
  const pasteAt = useRef(onPasteAt);
  pasteAt.current = onPasteAt;

  const paint = () => {
    const t = ref.current;
    if (!t) return;
    t.querySelectorAll("[data-sel]").forEach((e) => e.removeAttribute("data-sel"));
    const rg = range.current;
    t.classList.toggle("selecting", !!rg);
    if (!rg) return;
    const { r0, r1, c0, c1 } = bounds(t, rg);
    const rows = bodyRows(t);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) rows[r]?.cells[c]?.setAttribute("data-sel", "");
    if (rg.cols) for (let c = c0; c <= c1; c++) t.tHead?.rows[0]?.cells[c]?.setAttribute("data-sel", "");
  };
  // 표가 다시 그려져도(자동 저장 등) 선택 표시 유지
  useLayoutEffect(paint);

  useEffect(() => {
    const set = (rg: Range | null) => { range.current = rg; paint(); };
    const startRange = () => {
      // 입력 칸 안의 글자 선택 대신 칸 범위 선택으로
      (document.activeElement as HTMLElement | null)?.blur?.();
      window.getSelection()?.removeAllRanges();
    };
    const down = (e: MouseEvent) => {
      const t = ref.current;
      if (!t || e.button !== 0) return;
      const p = posOf(t, e.target);
      if (!p) { if (range.current) set(null); return; }
      if ((e.target as HTMLElement).closest("button, a")) return; // 버튼(삭제·못 함 등)은 그대로
      if (e.shiftKey && anchor.current && (p.r === -1) === (anchor.current.r === -1)) {
        e.preventDefault();
        startRange();
        set({ a: anchor.current, b: p, cols: p.r === -1 });
        return;
      }
      anchor.current = p;
      drag.current = p;
      if (p.r === -1) { // 머리글: 열 전체
        e.preventDefault();
        startRange();
        set({ a: p, b: p, cols: true });
      } else if (range.current) set(null);
    };
    const over = (e: MouseEvent) => {
      const t = ref.current;
      const d = drag.current;
      if (!t || !d || !(e.buttons & 1)) return;
      const p = posOf(t, e.target);
      if (!p) return;
      if (d.r === -1) { set({ a: d, b: { r: -1, c: p.c }, cols: true }); return; }
      if (p.r === -1 || (p.r === d.r && p.c === d.c && !range.current)) return;
      if (!range.current) startRange();
      set({ a: d, b: p, cols: false });
    };
    const up = () => { drag.current = null; };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && range.current) set(null); };
    const copy = (e: ClipboardEvent) => {
      const t = ref.current;
      const rg = range.current;
      if (!t || !rg || !e.clipboardData) return;
      const { r0, r1, c0, c1 } = bounds(t, rg);
      const rows = bodyRows(t);
      // 삭제 버튼 열은 빼고
      const cs: number[] = [];
      for (let c = c0; c <= c1; c++) {
        const anyCell = rows[r0]?.cells[c] ?? t.tHead?.rows[0]?.cells[c];
        if (!anyCell?.classList.contains("del-cell") && !t.tHead?.rows[0]?.cells[c]?.classList.contains("del-col")) cs.push(c);
      }
      const out: string[][] = [];
      for (let r = r0; r <= r1; r++) out.push(cs.map((c) => cellText(rows[r]?.cells[c])));
      if (!out.length || !cs.length) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", toTsv(out));
      copied.current?.(out.length, cs.length);
    };
    const paste = (e: ClipboardEvent) => {
      const t = ref.current;
      const rg = range.current;
      if (!t || !rg) return;
      set(null);
      const text = e.clipboardData?.getData("text") ?? "";
      if (!pasteAt.current || !text) return;
      // 범위 안에서 왼쪽 위부터 첫 입력 칸
      const { r0, r1, c0, c1 } = bounds(t, rg);
      const rows = bodyRows(t);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const el = rows[r]?.cells[c]?.querySelector("input:not(:disabled), select:not(:disabled)") as HTMLElement | null;
        if (el) {
          e.preventDefault();
          e.stopPropagation(); // 표 밖 붙여넣기 처리(문서 전체)와 겹치지 않게
          pasteAt.current(el, text);
          return;
        }
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseup", up);
    document.addEventListener("keydown", key);
    document.addEventListener("copy", copy);
    document.addEventListener("paste", paste, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("keydown", key);
      document.removeEventListener("copy", copy);
      document.removeEventListener("paste", paste, true);
    };
  }, []);
}
