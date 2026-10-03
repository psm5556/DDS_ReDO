import { useEffect, useMemo, useRef, useState } from "react";
import type { Shape } from "plotly.js";
import { fmtFactor, snap } from "../format";
import type { Effect, FactorDef, ResponseDef, Surface } from "../types";
import { baseLayout, COLORS, Plot, plotConfig, SCALE_EPI, SCALE_MEAN, SCALE_PROB, SCALE_SIGMA } from "./Plot";

type Loader = (x: string, y: string, fixed: Record<string, number>) => Promise<Surface>;

function specLines(s: Surface, resp: ResponseDef) {
  const lines: object[] = [];
  for (const [v, name] of [[resp.lsl, "LSL"], [resp.usl, "USL"]] as const) {
    if (v === null || v === undefined) continue;
    lines.push({
      type: "contour", x: s.x.values, y: s.y.values, z: s.mean, showscale: false, hoverinfo: "skip", name,
      contours: { coloring: "none", start: v, end: v, size: 1, showlabels: true, labelfont: { size: 10, color: COLORS.ok } },
      line: { color: COLORS.ok, width: 2, dash: "dash" },
    });
  }
  return lines;
}

function MapPlot({ s, z, scale, title, unit, extra, height }: {
  s: Surface; z: number[][]; scale: [number, string][]; title: string; unit: string; extra?: object[]; height: number;
}) {
  return (
    <Plot
      data={[
        {
          type: "contour", x: s.x.values, y: s.y.values, z, colorscale: scale, ncontours: 14,
          contours: { coloring: "heatmap", showlines: true }, line: { color: "rgba(255,255,255,0.35)", width: 0.5 },
          colorbar: { thickness: 10, len: 0.9, outlinewidth: 0, tickfont: { size: 10 } },
          hovertemplate: `${s.x.name}: %{x}<br>${s.y.name}: %{y}<br>${title}: %{z:.4g} ${unit}<extra></extra>`,
        } as object,
        ...(extra ?? []),
        {
          type: "scatter", mode: "markers", x: s.points.map((p) => p.x), y: s.points.map((p) => p.y), name: "실험점",
          marker: { size: s.points.map((p) => 6 + Math.min(p.n ?? 1, 5) * 1.5), color: "#fff", line: { color: COLORS.ink, width: 1.2 } },
          hovertemplate: s.points[0]?.mean !== undefined ? "실험점 (반복 %{customdata[0]}회)<br>평균 %{customdata[1]:.4g}<extra></extra>" : "실험한 조건<extra></extra>",
          customdata: s.points.map((p) => [p.n ?? 1, p.mean ?? null]),
        } as object,
      ]}
      layout={{
        ...baseLayout, height, showlegend: false,
        xaxis: { title: { text: `${s.x.name}${s.x.unit ? ` [${s.x.unit}]` : ""}` }, zeroline: false },
        yaxis: { title: { text: `${s.y.name}${s.y.unit ? ` [${s.y.unit}]` : ""}` }, zeroline: false },
      }}
      config={plotConfig}
      style={{ width: "100%" }}
      useResizeHandler
    />
  );
}

/** 평균 지도와 산포 지도를 나란히 (CLAUDE.md 7.2절 분석 화면) */
export function TwinMaps({ factors, resp, load, initial, initialFixed, allowChange = true }: {
  factors: FactorDef[]; resp: ResponseDef; load?: Loader; initial?: Surface | null;
  initialFixed?: Record<string, number>; allowChange?: boolean;
}) {
  const [xk, setXk] = useState(initial?.x.key ?? factors[0]?.key);
  const [yk, setYk] = useState(initial?.y.key ?? factors[1]?.key);
  const [fixed, setFixed] = useState<Record<string, number>>(() => {
    const f: Record<string, number> = {};
    for (const fd of factors) f[fd.key] = initialFixed?.[fd.key] ?? initial?.fixed?.[fd.key] ?? snap((fd.low + fd.high) / 2, fd);
    return f;
  });
  const [surf, setSurf] = useState<Surface | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"sigma" | "epi" | "prob">("sigma");
  const others = factors.filter((f) => f.key !== xk && f.key !== yk);
  const fixedKey = JSON.stringify(others.map((f) => fixed[f.key]));

  const first = useRef(true);
  useEffect(() => {
    if (!load || factors.length < 2) return;
    if (first.current) {
      first.current = false;
      if (initial) return; // 미리 계산된 단면(공유 스냅샷 등)은 다시 계산하지 않음
    }
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      load(xk, yk, fixed).then((s) => { if (alive) { setSurf(s); setErr(null); } })
        .catch((e: Error) => alive && setErr(e.message)).finally(() => alive && setBusy(false));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xk, yk, fixedKey, load]);

  if (factors.length < 2) return <p className="muted small">인자가 2개 이상일 때 지도를 그릴 수 있습니다. 아래 주효과 그래프를 보세요.</p>;
  const h = 330;
  const u = resp.unit;
  return (
    <div className="stack">
      {allowChange && (
        <div className="row">
          <label className="field" style={{ minWidth: 160 }}><span className="lbl">가로축</span>
            <select value={xk} onChange={(e) => { const v = e.target.value; if (v === yk) setYk(xk); setXk(v); }}>
              {factors.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
            </select>
          </label>
          <label className="field" style={{ minWidth: 160 }}><span className="lbl">세로축</span>
            <select value={yk} onChange={(e) => { const v = e.target.value; if (v === xk) setXk(yk); setYk(v); }}>
              {factors.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
            </select>
          </label>
          <div style={{ flex: 1 }} />
          {busy && <span className="busy small" style={{ padding: 0 }}><span className="spinner" /> 계산 중</span>}
        </div>
      )}
      {allowChange && others.length > 0 && (
        <div className="panel" style={{ padding: 12, background: "var(--panel-2)" }}>
          <p className="small muted" style={{ marginBottom: 6 }}>나머지 인자는 아래 값으로 고정한 단면입니다.</p>
          {others.map((f) => (
            <div className="slider-row" key={f.key}>
              <span>{f.name}</span>
              <input type="range" min={f.low} max={f.high} step={f.step} value={fixed[f.key]}
                onChange={(e) => setFixed({ ...fixed, [f.key]: snap(Number(e.target.value), f) })} aria-label={`${f.name} 고정값`} />
              <span className="num">{fmtFactor(fixed[f.key], f)} {f.unit}</span>
            </div>
          ))}
        </div>
      )}
      {err && <div className="notice err">{err}</div>}
      {surf && (
        <>
          <div className="twin">
            <div className="map-card">
              <div className="map-title"><b className="m">μ 평균</b><span className="muted">{resp.name}{u ? ` [${u}]` : ""}</span>
                {(resp.lsl != null || resp.usl != null) && <span className="muted">· 초록 점선 = 규격 경계</span>}</div>
              <MapPlot s={surf} z={surf.mean} scale={SCALE_MEAN} title="평균" unit={u} extra={specLines(surf, resp)} height={h} />
            </div>
            <div className="map-card">
              <div className="map-title">
                {view === "sigma" && <><b className="s">σ 산포</b><span className="muted">같은 조건에서 반복했을 때의 흩어짐</span></>}
                {view === "epi" && <><b className="e">모델 불확실성</b><span className="muted">데이터가 부족한 정도</span></>}
                {view === "prob" && <><b style={{ color: "var(--ok)" }}>규격 만족 확률</b></>}
                <span style={{ flex: 1 }} />
                <span className="seg">
                    <button className={`small ${view === "sigma" ? "on" : ""}`} onClick={() => setView("sigma")}>σ</button>
                    <button className={`small ${view === "epi" ? "on" : ""}`} onClick={() => setView("epi")}>불확실성</button>
                    {surf.spec_prob && <button className={`small ${view === "prob" ? "on" : ""}`} onClick={() => setView("prob")}>확률</button>}
                  </span>
              </div>
              {view === "sigma" && <MapPlot s={surf} z={surf.sigma} scale={SCALE_SIGMA} title="σ" unit={u} height={h} />}
              {view === "epi" && <MapPlot s={surf} z={surf.epistemic_sd} scale={SCALE_EPI} title="불확실성(표준편차)" unit={u} height={h} />}
              {view === "prob" && surf.spec_prob && <MapPlot s={surf} z={surf.spec_prob} scale={SCALE_PROB} title="확률" unit="" height={h} />}
            </div>
          </div>
          {surf.variance_reliability !== "ok" && (
            <div className="notice warn">{surf.variance_reliability === "none"
              ? "반복 측정 데이터가 없어 산포 지도는 추정이 불가능한 상태의 대략값입니다."
              : "반복 측정한 조건이 적어 산포 지도의 신뢰도가 낮습니다."}</div>
          )}
          {surf.decomposition_is_approximate && <div className="notice info">TabPFN 결과: 산포와 모델 불확실성의 구분은 근사값입니다.</div>}
        </>
      )}
    </div>
  );
}

export function EffectsPlots({ effects, resp }: { effects: Effect[]; resp: ResponseDef }) {
  const specShapes = useMemo(() => [resp.lsl, resp.usl].filter((v): v is number => v != null).map((v) => ({
    type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: v, y1: v, line: { color: COLORS.ok, width: 1, dash: "dash" },
  })), [resp]);
  return (
    <div className="grid-3">
      {effects.map((e) => (
        <div className="map-card" key={e.key}>
          <div className="map-title"><b>{e.name}</b><span className="muted">{e.unit}</span></div>
          <Plot
            data={[
              { x: [...e.x, ...[...e.x].reverse()], y: [...e.hi, ...[...e.lo].reverse()], fill: "toself", type: "scatter",
                mode: "lines", line: { color: COLORS.epi, width: 1, dash: "dot" }, fillcolor: "rgba(111,127,142,0.12)",
                hoverinfo: "skip", name: "평균의 불확실성" },
              { x: e.x, y: e.mean, type: "scatter", mode: "lines", line: { color: COLORS.mean, width: 2.5 }, name: "μ 평균",
                hovertemplate: "%{x}<br>μ %{y:.4g}<extra></extra>" },
              { x: e.x, y: e.sigma, type: "scatter", mode: "lines", line: { color: COLORS.sigma, width: 2 }, name: "σ 산포",
                yaxis: "y2", hovertemplate: "%{x}<br>σ %{y:.4g}<extra></extra>" },
            ] as object[]}
            layout={{
              ...baseLayout, height: 220, showlegend: false, margin: { l: 48, r: 44, t: 6, b: 32 }, shapes: specShapes as unknown as Partial<Shape>[],
              yaxis: { title: { text: "μ", font: { color: COLORS.mean } }, zeroline: false },
              yaxis2: { overlaying: "y", side: "right", title: { text: "σ", font: { color: COLORS.sigma } }, zeroline: false,
                rangemode: "tozero", showgrid: false },
            }}
            config={{ ...plotConfig, displayModeBar: false }}
            style={{ width: "100%" }}
            useResizeHandler
          />
        </div>
      ))}
    </div>
  );
}
