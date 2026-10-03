import type { FactorDef, ResponseDef } from "./types";

export function fmt(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
  return Number(v.toPrecision(Math.max(digits, 1) + (a >= 1 ? Math.floor(Math.log10(a)) : 0))).toLocaleString("ko-KR", {
    maximumFractionDigits: 6,
  });
}
export function fmtResp(v: number | null | undefined, r?: ResponseDef): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const d = r?.decimals ?? 3;
  return v.toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 1) });
}
export function stepDecimals(step: number): number {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1].length : 0;
}
export function fmtFactor(v: number | null | undefined, f: FactorDef): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return v.toLocaleString("ko-KR", { maximumFractionDigits: stepDecimals(f.step), minimumFractionDigits: stepDecimals(f.step) });
}
export function snap(v: number, f: FactorDef): number {
  const n = Math.round((v - f.low) / f.step);
  const x = Math.min(f.high, Math.max(f.low, f.low + n * f.step));
  return Number(x.toFixed(stepDecimals(f.step)));
}
export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return `${(v * 100).toFixed(v > 0.995 && v < 1 ? 1 : 0)}%`;
}
export function when(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "방금";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
  return d.toLocaleDateString("ko-KR");
}
export const ROLE_LABEL: Record<string, string> = { owner: "소유자", editor: "편집자", runner: "실험자", viewer: "열람자" };
export const STATUS_LABEL: Record<string, string> = {
  planned: "대기", running: "대기", done: "완료", failed: "실패", infeasible: "실행불가", excluded: "제외",
};
export const PROJECT_STATUS: Record<string, string> = { active: "진행 중", completed: "완료", archived: "보관" };
export const GOAL_LABEL: Record<string, string> = { maximize: "클수록 좋음 (망대)", minimize: "작을수록 좋음 (망소)", target: "목표값에 맞춤 (망목)" };
export const MODE_LABEL: Record<string, string> = {
  robust: "강건 최적화 (평균 + 산포)", optimize: "평균 최적화", explore: "응답 표면 탐색",
};
export const OBJ_LABEL: Record<string, string> = {
  spec_prob: "규격 만족 확률 최대화", taguchi: "품질 손실 최소화 (다구치)", mean_k_sigma: "평균 ± kσ 기준",
};
