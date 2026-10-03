import { useEffect, useState } from "react";
import { get } from "../api";
import { usePrefs } from "../prefs";
import type { ProjectConfig, Surrogate, SurrogateInfo } from "../types";

export function useSurrogates() {
  const [list, setList] = useState<SurrogateInfo[]>([]);
  useEffect(() => { get<SurrogateInfo[]>("/api/surrogates").then(setList).catch(() => {}); }, []);
  return list;
}

/** 대리모델 선택 (CLAUDE.md 6.4절): 기본 모드에서는 강요하지 않고 현재 모델만 표시 */
export function SurrogateSelect({ value, onChange }: { value: Surrogate; onChange: (s: Surrogate) => void }) {
  const list = useSurrogates();
  const { expert } = usePrefs();
  const cur = list.find((s) => s.name === value);
  if (!expert) return <span className="chip" title="전문가 모드에서 바꿀 수 있습니다">{value === "gp" ? "예측 모델: Gaussian Process" : "예측 모델: TabPFN (실험적)"}</span>;
  return (
    <label className="row small" style={{ gap: 6 }}>
      예측 모델
      <select value={value} onChange={(e) => onChange(e.target.value as Surrogate)} style={{ width: "auto" }}>
        {list.map((s) => <option key={s.name} value={s.name} disabled={!s.available}>{s.label}{s.experimental ? " (실험적)" : ""}{!s.available ? " — 사용 불가" : ""}</option>)}
      </select>
      {cur && !cur.available && <span className="muted">{cur.status}</span>}
      {list.find((s) => s.name === "tabpfn" && !s.available) && value === "gp" && <span className="muted" title={list.find((s) => s.name === "tabpfn")?.status}>TabPFN: 사용 불가</span>}
    </label>
  );
}

export function ResponseSelect({ cfg, value, onChange }: { cfg: ProjectConfig; value: string; onChange: (k: string) => void }) {
  if (cfg.responses.length < 2) return null;
  return (
    <label className="row small" style={{ gap: 6 }}>응답
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: "auto" }}>
        {cfg.responses.map((r) => <option key={r.key} value={r.key}>{r.name}{r.key === cfg.settings.primary_response ? " (주 응답)" : ""}</option>)}
      </select>
    </label>
  );
}

export function ReliabilityChip({ v }: { v: "ok" | "low" | "none" }) {
  if (v === "ok") return <span className="chip ok">산포 추정 가능</span>;
  if (v === "low") return <span className="chip warn">산포 추정 신뢰도 낮음</span>;
  return <span className="chip err">반복 측정 없음 · 산포 추정 불가</span>;
}
