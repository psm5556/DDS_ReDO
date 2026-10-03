import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, get, post } from "../api";
import { EffectsPlots, TwinMaps } from "../components/Maps";
import { RecipeCard } from "../components/RecipeCard";
import { WhatIf } from "../components/WhatIf";
import { fmtFactor, fmtResp, pct } from "../format";
import { ReliabilityChip } from "../sections/shared";
import type { Best, Effect, FactorDef, Prediction, ResponseDef, Surface, Surrogate, Validation } from "../types";

interface SharedPayload {
  share: { mode: "snapshot" | "live"; permission: "view" | "view_simulate"; created_at: string; expires_at: string | null;
    include_raw: boolean; project_id: number | null };
  project: { name: string; description: string; owner: string; owner_department: string | null };
  factors: FactorDef[]; response: ResponseDef; surrogate: Surrogate; surrogate_version: string; objective: string;
  best: Best; best_is_tentative: boolean; data: { n_points: number; n_obs: number; n_replicated_points: number };
  variance_reliability: "ok" | "low" | "none"; decomposition_is_approximate: boolean;
  validation: Partial<Validation>; warnings: string[]; surface: Surface | null; effects: Effect[]; computed_at: string;
  raw: { keys: string[]; X: number[][]; y: number[] } | null;
}

type Failure = { kind: "forbidden"; canRequest: boolean } | { kind: "gone" | "error"; message: string };

const stamp = (iso: string | null | undefined) => {
  if (!iso) return "–";
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  return d.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
};

function AccessRequest({ token, canRequest }: { token: string; canRequest: boolean }) {
  const [msg, setMsg] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setState("sending");
    try {
      await post(`/api/shared/${token}/request-access`, { message: msg });
      setState("sent");
    } catch (e) { setErr((e as Error).message); setState("idle"); }
  };
  return (
    <div className="panel" style={{ maxWidth: 560, margin: "40px auto" }}>
      <h2 style={{ marginTop: 0 }}>접근 권한이 없습니다</h2>
      <p className="small">이 예측 페이지의 공유 대상에 포함되어 있지 않습니다. 소유자에게 접근을 요청할 수 있습니다.</p>
      {state === "sent" ? (
        <div className="notice ok">소유자에게 접근 요청을 보냈습니다. 승인되면 이 링크로 다시 열어 보세요.</div>
      ) : canRequest ? (
        <>
          <label className="field" style={{ marginTop: 12 }}><span className="lbl">요청 메시지 (선택)</span>
            <textarea value={msg} maxLength={500} placeholder="예: 증착 공정 조건 검토에 참고하려고 합니다."
              onChange={(e) => setMsg(e.target.value)} />
          </label>
          {err && <div className="notice err" style={{ marginTop: 8 }}>{err}</div>}
          <div className="row end" style={{ marginTop: 12 }}>
            <button className="primary" disabled={state === "sending"} onClick={send}>
              {state === "sending" ? "보내는 중" : "접근 요청 보내기"}</button>
          </div>
        </>
      ) : null}
      <p className="small" style={{ marginTop: 16 }}><Link to="/">내 DOE 목록으로</Link></p>
    </div>
  );
}

/** 공유받은 최적화 예측 페이지 — 읽기 전용 (CLAUDE.md 8.4절) */
export default function SharedPage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<SharedPayload | null>(null);
  const [fail, setFail] = useState<Failure | null>(null);

  useEffect(() => {
    setData(null);
    setFail(null);
    get<SharedPayload>(`/api/shared/${token}`).then(setData).catch((e: ApiError) => {
      const d = e.detail as { can_request?: boolean } | null;
      if (e.status === 403) setFail({ kind: "forbidden", canRequest: d?.can_request ?? true });
      else if (e.status === 410) setFail({ kind: "gone", message: e.message });
      else setFail({ kind: "error", message: e.message });
    });
  }, [token]);

  const simulate = data?.share.permission === "view_simulate";
  const loadSurface = useCallback((x: string, y: string, fixed: Record<string, number>) =>
    post<Surface>(`/api/shared/${token}/surface`, { x_factor: x, y_factor: y, fixed, resolution: 30 }), [token]);
  const predict = useCallback(async (x: Record<string, number>) =>
    (await post<Prediction[]>(`/api/shared/${token}/predict`, { points: [x] }))[0], [token]);

  if (fail?.kind === "forbidden") return <div className="page"><AccessRequest token={token} canRequest={fail.canRequest} /></div>;
  if (fail) return (
    <div className="page">
      <div className="panel" style={{ maxWidth: 560, margin: "40px auto" }}>
        <h2 style={{ marginTop: 0 }}>{fail.kind === "gone" ? "더 이상 볼 수 없는 공유입니다" : "공유 페이지를 열 수 없습니다"}</h2>
        <p className="small">{fail.kind === "gone" ? "소유자가 공유를 철회했거나 공유 기간이 만료되었습니다. 필요하면 소유자에게 다시 공유를 요청하세요." : fail.message}</p>
        <p className="small" style={{ marginTop: 16 }}><Link to="/">내 DOE 목록으로</Link></p>
      </div>
    </div>
  );
  if (!data) return <div className="page"><div className="busy"><span className="spinner" /> 불러오는 중</div></div>;

  const { project, factors, response: resp, share, validation: v } = data;
  const isTabpfn = data.surrogate === "tabpfn";
  const lowTrust = v?.status === "warn" || data.best_is_tentative;
  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <p className="small muted">공유받은 예측 · 읽기 전용</p>
          <h1>{project.name}</h1>
          <p className="small">
            소유자 {project.owner}{project.owner_department ? ` (${project.owner_department})` : ""} ·{" "}
            {share.mode === "snapshot" ? `스냅샷 기준 ${stamp(data.computed_at)}` : `실시간 · 마지막 갱신 ${stamp(data.computed_at)}`} ·{" "}
            예측 모델 {isTabpfn ? "TabPFN" : "Gaussian Process"} · 실험 조건 {data.data.n_points}개 / 측정 {data.data.n_obs}회
          </p>
          {project.description && <p className="small muted">{project.description}</p>}
        </div>
        <div className="row">
          {isTabpfn && <span className="chip warn">평가용</span>}
          {share.mode === "live" && <span className="chip">실시간</span>}
          <ReliabilityChip v={data.variance_reliability} />
          {lowTrust ? <span className="chip warn">신뢰도 낮음</span> : <span className="chip ok">검증 양호</span>}
          {share.project_id != null && <Link className="btn small" to={`/projects/${share.project_id}`}>프로젝트 열기</Link>}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {isTabpfn && (
          <div className="notice warn">TabPFN(실험적 모델)으로 계산한 평가용 결과입니다. 실제 공정 조건 결정에 단독으로 사용하지 마세요.</div>
        )}
        {share.mode === "live" && <div className="notice info">최신 실험 결과로 계속 바뀝니다.</div>}
        {share.expires_at && <div className="notice info">이 공유는 {stamp(share.expires_at)}에 만료됩니다.</div>}
        {data.warnings.map((w) => <div key={w} className="notice warn">{w}</div>)}

        <section className="panel">
          <div className="panel-head"><h2 style={{ margin: 0 }}>추천 조건</h2><span className="muted small">{resp.name} · {data.objective}</span></div>
          <RecipeCard best={data.best} factors={factors} resp={resp} tentative={data.best_is_tentative} approx={data.decomposition_is_approximate} />
          {v?.available && (
            <p className="small muted" style={{ marginTop: 10 }}>
              모델 검증({v.method ?? "LOO"}): 95% 구간 커버리지 {pct(v.coverage95)} · 예측 오차(RMSE) {fmtResp(v.rmse, resp)} {resp.unit}
              {v.messages?.length ? ` · ${v.messages.join(" ")}` : ""}
            </p>
          )}
        </section>

        <section className="panel">
          <div className="panel-head"><h2 style={{ margin: 0 }}>평균과 산포 지도</h2>
            {!simulate && <span className="muted small">추천 조건을 지나는 단면입니다</span>}</div>
          {data.surface || factors.length < 2 ? (
            <TwinMaps key={token} factors={factors} resp={resp} initial={data.surface}
              load={simulate ? loadSurface : undefined} allowChange={simulate} />
          ) : <p className="muted small">지도 데이터가 없습니다.</p>}
        </section>

        {data.effects.length > 0 && (
          <section className="panel">
            <div className="panel-head"><h2 style={{ margin: 0 }}>인자별 영향 (주효과)</h2>
              <span className="muted small">나머지 인자는 추천 조건에 고정</span></div>
            <EffectsPlots effects={data.effects} resp={resp} />
          </section>
        )}

        {simulate && (
          <section className="panel">
            <div className="panel-head"><h2 style={{ margin: 0 }}>조건 시뮬레이션</h2>
              <span className="muted small">조건을 바꾸면 예상 결과를 계산합니다</span></div>
            <WhatIf key={token} factors={factors} resp={resp} start={data.best.x} predict={predict} approx={data.decomposition_is_approximate} />
          </section>
        )}

        {data.raw && (
          <section className="panel">
            <div className="panel-head"><h2 style={{ margin: 0 }}>원본 실험 데이터</h2><span className="muted small">{data.raw.y.length}건</span></div>
            <div className="table-wrap" style={{ maxHeight: 360 }}>
              <table>
                <thead><tr>
                  {data.raw.keys.map((k) => { const f = factors.find((x) => x.key === k);
                    return <th key={k} className="r">{f?.name ?? k} <span className="unit">{f?.unit}</span></th>; })}
                  <th className="r">{resp.name} <span className="unit">{resp.unit}</span></th>
                </tr></thead>
                <tbody>{data.raw.X.map((row, i) => (
                  <tr key={i}>
                    {row.map((val, j) => { const f = factors.find((x) => x.key === data.raw!.keys[j]);
                      return <td key={j} className="r">{f ? fmtFactor(val, f) : val}</td>; })}
                    <td className="r">{fmtResp(data.raw!.y[i], resp)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
