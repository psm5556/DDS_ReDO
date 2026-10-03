import { ClipboardPaste } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { parseClipboard } from "../paste";
import type { ResponseDef } from "../types";
import { Modal } from "./Modal";

/** 새 DOE를 기존 실험 데이터에서 만들기: 엑셀 표(머리글 포함)를 붙여넣으면 열마다 인자/응답을 고르고,
 *  인자 범위(데이터 최소~최대)·세팅 정밀도(소수 자리)·응답 단위를 미리 채운다. 데이터는 DOE를 만든 뒤 가져온다. */
export type ColRole = "factor" | "response" | "note" | "ignore";
export interface DataFactor { name: string; unit: string; low: number; high: number; step: number }
export interface DataResponse { name: string; unit: string; goal: ResponseDef["goal"]; decimals: number }
/** 가져올 행: 인자·응답은 위 목록과 같은 순서의 값 */
export interface DataRow { x: (number | null)[]; y: (number | null)[]; note: string }
export interface DataConfig { factors: DataFactor[]; responses: DataResponse[]; rows: DataRow[] }

const SKIP = ["런id", "런", "runid", "run", "id", "no", "번호", "순서", "#", "실험번호", "날짜", "date", "측정일"];
const NOTE = ["메모", "비고", "note", "memo", "특이사항"];
const norm = (s: string) => s.replace(/[\s_·:.]/g, "").toLowerCase();

/** "온도 [°C]", "온도(°C)" → 이름·단위 */
function splitUnit(h: string): { name: string; unit: string } {
  const m = h.trim().match(/^(.*?)\s*[[(]([^\])]*)[\])]\s*$/);
  return m ? { name: m[1].trim(), unit: m[2].trim() } : { name: h.trim(), unit: "" };
}
const toNum = (s: string) => {
  const t = s.replace(/,/g, "").trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
};
const decimalsOf = (s: string) => { const m = s.replace(/,/g, "").trim().match(/\.(\d+)$/); return m ? m[1].length : 0; };

interface ColInfo { header: string; name: string; unit: string; numeric: boolean; min: number; max: number; distinct: number; decimals: number; filled: number }

function analyse(lines: string[][]): ColInfo[] {
  const head = lines[0];
  const body = lines.slice(1);
  return head.map((h, j) => {
    const raw = body.map((r) => r[j] ?? "").filter((v) => v.trim() !== "");
    const vals = raw.map(toNum);
    const nums = vals.filter((v): v is number => v !== null && !Number.isNaN(v));
    const { name, unit } = splitUnit(h);
    return {
      header: h, name: name || `열 ${j + 1}`, unit, numeric: raw.length > 0 && nums.length === raw.length,
      min: nums.length ? Math.min(...nums) : 0, max: nums.length ? Math.max(...nums) : 0,
      distinct: new Set(nums).size, decimals: Math.max(0, ...raw.map(decimalsOf)), filled: raw.length,
    };
  });
}

/** 처음 고르는 값: 반복되는 수준이 많으면 인자, 값이 제각각이면 응답 */
function guessRoles(cols: ColInfo[], n: number): ColRole[] {
  const roles = cols.map<ColRole>((c) => {
    const k = norm(c.name);
    if (NOTE.includes(k)) return "note";
    if (SKIP.includes(k) || !c.numeric || c.distinct < 2) return "ignore";
    return c.distinct <= Math.max(3, Math.ceil(n * 0.6)) ? "factor" : "response";
  });
  const num = roles.map((r, i) => (r === "factor" || r === "response" ? i : -1)).filter((i) => i >= 0);
  if (num.length >= 2 && !roles.includes("response")) roles[num[num.length - 1]] = "response";
  if (num.length >= 2 && !roles.includes("factor")) num.slice(0, -1).forEach((i) => { roles[i] = "factor"; });
  return roles;
}

const GOALS: [ResponseDef["goal"], string][] = [["maximize", "최대 (망대)"], ["minimize", "최소 (망소)"], ["target", "목표값 (망목)"]];

export function DataToConfigModal({ onClose, onApply }: { onClose: () => void; onApply: (c: DataConfig) => void }) {
  const [lines, setLines] = useState<string[][] | null>(null);
  const [roles, setRoles] = useState<ColRole[]>([]);
  const [goals, setGoals] = useState<ResponseDef["goal"][]>([]);

  const take = (text: string) => {
    const ls = parseClipboard(text).filter((r) => r.some((c) => c.trim() !== ""));
    if (ls.length < 2) return false;
    const info = analyse(ls);
    setLines(ls);
    setRoles(guessRoles(info, ls.length - 1));
    setGoals(info.map(() => "maximize"));
    return true;
  };
  useEffect(() => {
    const h = (e: ClipboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
      if (take(e.clipboardData?.getData("text") ?? "")) e.preventDefault();
    };
    document.addEventListener("paste", h);
    return () => document.removeEventListener("paste", h);
  }, []);

  const cols = useMemo(() => (lines ? analyse(lines) : []), [lines]);
  const body = lines?.slice(1) ?? [];
  const fIdx = roles.map((r, i) => (r === "factor" ? i : -1)).filter((i) => i >= 0);
  const rIdx = roles.map((r, i) => (r === "response" ? i : -1)).filter((i) => i >= 0);
  const noteIdx = roles.indexOf("note");
  const usable = body.filter((r) => fIdx.every((j) => { const v = toNum(r[j] ?? ""); return v !== null && !Number.isNaN(v); }));
  const problems = [
    !fIdx.length && "인자를 1개 이상 고르세요.",
    !rIdx.length && "응답을 1개 이상 고르세요.",
    ...[...fIdx, ...rIdx].filter((j) => !cols[j].numeric).map((j) => `'${cols[j].name}'에 숫자가 아닌 값이 있습니다.`),
    ...fIdx.filter((j) => cols[j].min === cols[j].max).map((j) => `'${cols[j].name}'은(는) 값이 하나뿐이라 인자로 쓸 수 없습니다.`),
  ].filter(Boolean) as string[];

  const apply = () => {
    const factors = fIdx.map<DataFactor>((j) => ({ name: cols[j].name, unit: cols[j].unit, low: cols[j].min, high: cols[j].max, step: 10 ** -cols[j].decimals }));
    const responses = rIdx.map<DataResponse>((j) => ({ name: cols[j].name, unit: cols[j].unit, goal: goals[j], decimals: Math.max(cols[j].decimals, 1) }));
    const rows = usable.map<DataRow>((r) => ({
      x: fIdx.map((j) => toNum(r[j] ?? "")),
      y: rIdx.map((j) => { const v = toNum(r[j] ?? ""); return v === null || Number.isNaN(v) ? null : v; }),
      note: noteIdx >= 0 ? (r[noteIdx] ?? "").trim() : "",
    }));
    onApply({ factors, responses, rows });
    onClose();
  };

  return (
    <Modal title="기존 데이터로 인자·응답 만들기" wide onClose={onClose} footer={<>
      <span className="muted small grow">{lines ? `데이터 ${usable.length}건${body.length > usable.length ? ` (인자 값이 빈 ${body.length - usable.length}행 제외)` : ""}` : ""}</span>
      <button onClick={onClose}>취소</button>
      <button className="primary" disabled={!lines || problems.length > 0} onClick={apply}>인자 {fIdx.length}개 · 응답 {rIdx.length}개로 채우기</button>
    </>}>
      {!lines ? (
        <div className="paste-drop" tabIndex={0}>
          <ClipboardPaste size={28} />
          <b>엑셀에서 머리글까지 복사해 Ctrl+V</b>
          <span>열마다 인자·응답을 고르면 범위(데이터 최소~최대)와 세팅 정밀도를 채워 드립니다. 데이터는 DOE를 만든 뒤 바로 가져옵니다.</span>
        </div>
      ) : (
        <div className="stack">
          <div className="table-wrap">
            <table className="grid-table edit-grid data-cols">
              <thead><tr><th>열</th><th>구분</th><th>목표 (응답)</th><th className="r">값 범위</th><th className="r">서로 다른 값</th><th>단위</th></tr></thead>
              <tbody>
                {cols.map((c, j) => (
                  <tr key={j}>
                    <td className="ro">{c.header}</td>
                    <td className="text">
                      <select aria-label={`${c.header} 구분`} value={roles[j]} onChange={(e) => setRoles(roles.map((r, i) => (i === j ? e.target.value as ColRole : r)))}>
                        <option value="factor">인자</option><option value="response">응답</option><option value="note">메모</option><option value="ignore">무시</option>
                      </select>
                    </td>
                    <td className="text">
                      <select aria-label={`${c.header} 목표`} value={goals[j]} disabled={roles[j] !== "response"} onChange={(e) => setGoals(goals.map((g, i) => (i === j ? e.target.value as ResponseDef["goal"] : g)))}>
                        {GOALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </td>
                    <td className="ro r num">{c.numeric ? `${c.min} ~ ${c.max}` : "숫자 아님"}</td>
                    <td className="ro r num">{c.distinct || "-"}</td>
                    <td className="ro">{c.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">값이 몇 가지로 반복되는 열은 인자, 값이 제각각인 열은 응답으로 미리 골라 두었습니다. 목표값(망목)·규격은 채운 뒤 표에서 입력하세요.</p>
          {problems.length > 0 && <div className="notice warn" role="alert">{problems.join(" ")}</div>}
          <button className="small ghost" style={{ alignSelf: "flex-start" }} onClick={() => setLines(null)}>다시 붙여넣기</button>
        </div>
      )}
    </Modal>
  );
}
