/** 엑셀 복사·붙여넣기 해석 (사내 보안 정책상 엑셀·CSV 파일 업로드는 읽을 수 없으므로 클립보드로 주고받는다). */
import type { FactorDef, ResponseDef } from "./types";

export type PasteTarget = { kind: "act" | "val" | "note"; key: string };
export type HeaderCell = PasteTarget | "code" | null;

/** 엑셀이 클립보드에 넣는 탭 구분 텍스트 → 행·열 배열. 따옴표로 감싼 칸(줄바꿈 포함 메모)도 처리한다. */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  const s = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur === "") quoted = true;
    else if (ch === "\t") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

const norm = (s: string) => s.replace(/\[[^\]]*\]|\([^)]*\)/g, "").replace(/[\s_·:]/g, "").toLowerCase();
const CODE = ["런id", "런", "runid", "run", "id", "런번호", "실험id"];
const NOTE = ["메모", "비고", "note", "memo", "특이사항"];

/** 첫 행이 머리글이면 각 칸이 어느 열인지 돌려준다. 결과·메모 열을 하나도 찾지 못하면 머리글이 아니라고 본다. */
export function matchHeader(cells: string[], factors: FactorDef[], responses: ResponseDef[]): HeaderCell[] | null {
  let hits = 0;
  const out = cells.map<HeaderCell>((raw) => {
    const n = norm(raw);
    if (!n) return null;
    if (CODE.includes(n)) return "code";
    if (NOTE.includes(n)) { hits++; return { kind: "note", key: "note" }; }
    const r = responses.find((x) => norm(x.name) === n || x.key.toLowerCase() === n);
    if (r) { hits++; return { kind: "val", key: r.key }; }
    if (n.endsWith("계획")) return null; // 계획값 열은 무시
    const base = n.replace(/실제(값)?$/, "");
    const f = factors.find((x) => norm(x.name) === base || x.key.toLowerCase() === base);
    if (f) return { kind: "act", key: f.key };
    return null;
  });
  return hits > 0 ? out : null;
}

/** 표를 엑셀에 붙여넣을 수 있는 탭 구분 텍스트로 */
export function toTsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map((c) => {
    const s = String(c ?? "");
    return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join("\t")).join("\n");
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http 등 clipboard API를 쓸 수 없는 환경
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
