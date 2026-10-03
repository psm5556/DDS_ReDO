import { useEffect, useState } from "react";
import { get } from "../api";
import type { ProjectConfig, SurrogateInfo } from "../types";

export function useSurrogates() {
  const [list, setList] = useState<SurrogateInfo[]>([]);
  useEffect(() => { get<SurrogateInfo[]>("/api/surrogates").then(setList).catch(() => {}); }, []);
  return list;
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
