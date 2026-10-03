import { AlertTriangle, CheckCircle2, CircleDot, ClipboardPaste, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { get, post } from "../api";
import { Confirm } from "../components/Modal";
import { EditGrid, type GridCol } from "../components/EditGrid";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ImportData } from "../components/ImportData";
import { MultiWhatIf } from "../components/MultiWhatIf";
import { fmtFactor, fmtResp, pct, snap } from "../format";
import { can, useProject } from "../project";
import AnalysisSection from "../sections/AnalysisSection";
import CompareSection from "../sections/CompareSection";
import ResultsSection from "../sections/ResultsSection";
import { useSurrogates } from "../sections/shared";
import { useToast } from "../toast";
import type { Batch, MultiProposal, MultiRecommend, OptimizeResult, RecipeOption, RespPred, ResponseDef } from "../types";
import { allowedSteps, autoStep, notifyProjectsChanged, STEPS, type Step } from "./steps";

/** 한 사이클의 두 화면: ① 실험 데이터 입력(첫 DOE 생성 포함) → ② 능동학습 결과(레시피 최적화 + 추가 DOE 제안) → 다음 차수 ① */
export default function GuideView() {
  const { project } = useProject();
  const { n } = useParams();
  const nav = useNavigate();
  const [batches, setBatches] = useState<Batch[]>([]);
  useEffect(() => {
    get<Batch[]>(`/api/projects/${project.id}/batches`).then(setBatches).catch(() => {});
  }, [project.id, project.runs_total, project.runs_done]);

  const allowed = allowedSteps(project.my_role);
  const auto = autoStep(project);
  let step: Step = n ? (Number(n) as Step) : auto === 0 ? 1 : auto;
  if (project.runs_total === 0) step = 0;
  else if (!allowed.includes(step)) step = auto;
  const round = batches.reduce((m, b) => Math.max(m, b.seq), 0);
  const go = (s: Step) => nav(`/projects/${project.id}/step/${s}`);

  return (
    <div className="guide">
      <Stepper step={step} allowed={allowed} round={round} open={project.runs_open} onGo={go} started={batches.length > 0} />
      {step === 0 && <StepStart onDone={() => go(1)} onImported={(allDone) => go(allDone ? 2 : 1)} />}
      {step === 1 && <StepExperiment batches={batches} onNext={() => go(2)} />}
      {step === 2 && <StepLearn onDone={() => go(1)} />}
    </div>
  );
}

function Stepper({ step, allowed, round, open, onGo, started }: { step: Step; allowed: Step[]; round: number; open: number; onGo: (s: Step) => void; started: boolean }) {
  return (
    <nav className="stepper" aria-label="진행 단계">
      <span className="round">{round > 0 || started ? `${round}차` : "시작"}</span>
      <ol>
        {STEPS.map((s) => {
          let state = step === 0 ? (s.n === 1 ? "now" : "todo") : s.n === step ? "now" : s.n < step ? "done" : "todo";
          if (s.n === 1 && state === "done" && open > 0) state = "partial"; // 결과가 남아 있으면 완료가 아님
          const ok = step !== 0 && allowed.includes(s.n);
          return (
            <li key={s.n} className={state}>
              <button className="step-btn" disabled={!ok} aria-current={state === "now" ? "step" : undefined} onClick={() => onGo(s.n)}>
                <span className="num">{state === "done" ? "✓" : s.n}</span>
                <span className="txt">{s.label}<small>{state === "partial" ? `결과 ${open}건 남음` : step === 0 && s.n === 1 ? "첫 DOE 생성" : s.hint}</small></span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="step-head">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}

// ---------- 0. 첫 DOE 생성 ----------
function StepStart({ onDone, onImported }: { onDone: () => void; onImported: (allDone: boolean) => void }) {
  const { project, reload } = useProject();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const st = project.config.settings;
  const d = project.config.factors.length;
  const initPts = st.initial_points ?? Math.max(2 * d + 2, 10);
  const rep = Math.round(st.replicate_fraction * initPts);
  const initRuns = initPts - rep + rep * st.replicates_per_point;
  const make = async () => {
    setBusy(true);
    try {
      await post(`/api/projects/${project.id}/design/initial`, { seed: Math.floor(Math.random() * 1000) });
      await reload();
      notifyProjectsChanged();
      toast("첫 DOE를 생성했습니다.");
      onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  if (!can(project.my_role, "editor")) {
    return (
      <section className="panel step-panel">
        <StepHead title="아직 실험이 없습니다">편집자가 첫 DOE를 생성하거나 기존 데이터를 가져오면 시작할 수 있습니다.</StepHead>
      </section>
    );
  }
  if (importing) {
    return (
      <section className="panel step-panel">
        <StepHead title="기존 실험 데이터 가져오기">이미 해 둔 실험 결과로 바로 학습하고, 다음에 할 실험을 제안받습니다.</StepHead>
        <ImportData start onCancel={() => setImporting(false)} onDone={(r) => onImported(r.done > 0 && r.done === r.imported)} />
      </section>
    );
  }
  return (
    <section className="panel step-panel">
      <StepHead title="어떻게 시작할까요?" />
      <div className="start-choices">
        <button className="choice" disabled={busy} onClick={make}>
          <Sparkles size={22} />
          <b>{busy ? "생성 중…" : "새로 설계"}</b>
          <span>첫 DOE {initPts}개 조건 · 총 {initRuns}회 ({rep}개 조건은 {st.replicates_per_point}회 반복)</span>
        </button>
        <button className="choice" disabled={busy} onClick={() => setImporting(true)}>
          <ClipboardPaste size={22} />
          <b>기존 데이터로 시작</b>
          <span>이미 해 둔 실험 결과를 엑셀에서 붙여넣기</span>
        </button>
      </div>
    </section>
  );
}

// ---------- ① 실험 데이터 입력 ----------
function StepExperiment({ batches, onNext }: { batches: Batch[]; onNext: () => void }) {
  const { project } = useProject();
  const [ask, setAsk] = useState(false);
  const open = project.runs_open;
  const latest = useMemo(() => [...batches].sort((x, y) => y.seq - x.seq)[0], [batches]);
  const onlyLatest = latest && latest.runs_total - latest.runs_done >= open;
  const next = () => (open > 0 ? setAsk(true) : onNext());
  return (
    <section className="panel step-panel">
      <div className="row" style={{ alignItems: "flex-start", marginBottom: 12 }}>
        <StepHead title={open > 0 ? `${onlyLatest ? `${latest.seq}차 ` : ""}실험 ${open}건의 결과를 입력하세요` : "모든 결과가 입력되었습니다"} />
        <span className="grow" />
        {open > 0 && <Link className="btn" to={`/projects/${project.id}/print`} target="_blank">실험 시트 인쇄 (QR)</Link>}
      </div>
      <ResultsSection />
      <div className="step-foot">
        <span className="grow" />
        <button className="primary big" onClick={next}>다음: 능동학습 →</button>
      </div>
      {ask && (
        <Confirm title="아직 결과가 없는 실험이 있습니다" confirmLabel="그래도 다음으로" onClose={() => setAsk(false)} onConfirm={onNext}
          message={<>결과가 없는 <b>{open}건</b>은 학습에서 빠지고, 추가 DOE는 이 조건들과 겹치지 않게 고릅니다.</>} />
      )}
    </section>
  );
}

// ---------- ② 능동학습 결과: 초보자도 바로 이해하도록 '추천 레시피'와 '다음 실험'만 크게, 나머지는 '자세히 보기' ----------
const PURPOSE: Record<string, string> = { exploit: "좋은 결과 기대", explore: "아직 모르는 영역", replicate: "반복 측정" };
const score = (d: number) => Math.round(Math.max(0, Math.min(d, 1)) * 100);
const RD = { decimals: 3 } as ResponseDef;

/** 응답 하나의 결과를 쉬운 말 한 줄로: '식각률 약 320 nm/min · 규격(300~340) 안에 들 확률 83%' */
function PlainResponse({ r, d }: { r: RespPred; d: ResponseDef }) {
  const p = r.spec_prob;
  const level = p === null ? (r.desirability >= 0.7 ? "ok" : r.desirability >= 0.4 ? "mid" : "low") : p >= 0.9 ? "ok" : p >= 0.5 ? "mid" : "low";
  const Icon = level === "ok" ? CheckCircle2 : level === "mid" ? CircleDot : AlertTriangle;
  const spec = d.lsl != null && d.usl != null ? `${d.lsl}~${d.usl}` : d.lsl != null ? `${d.lsl} 이상` : d.usl != null ? `${d.usl} 이하` : "";
  const goal = d.goal === "maximize" ? "클수록 좋음" : d.goal === "minimize" ? "작을수록 좋음" : `목표 ${d.target}`;
  return (
    <li className={`plain-resp ${level}`}>
      <Icon size={18} />
      <span className="nm">{r.name}</span>
      <span className="val">약 <b>{fmtResp(r.mean, d)}</b> {r.unit}</span>
      <span className="muted">{p !== null ? <>규격({spec}) 안에 들 확률 <b className="pr">{pct(p)}</b></> : goal}</span>
      {level === "low" && <span className="hint-low">{p !== null ? "아직 규격을 만족하기 어려움" : "목표에 못 미침"}</span>}
    </li>
  );
}

function StepLearn({ onDone }: { onDone: () => void }) {
  const { project, reload } = useProject();
  const toast = useToast();
  const cfg = project.config;
  const st = cfg.settings;
  const editor = can(project.my_role, "editor");
  const surrogates = useSurrogates();
  const tabpfnOn = surrogates.some((s) => s.name === "tabpfn" && s.available);
  // 능동학습: 응답별 모델 적합 + 다목적 최적 레시피
  const [opt, setOpt] = useState<OptimizeResult | null>(null);
  const [optErr, setOptErr] = useState<string | null>(null);
  useEffect(() => {
    setOpt(null); setOptErr(null);
    post<OptimizeResult>(`/api/projects/${project.id}/optimize`, { validate_model: true }).then(setOpt).catch((e: Error) => setOptErr(e.message));
  }, [project.id, project.runs_done]);

  // 다음 실험(추가 DOE) 제안
  const [rec, setRec] = useState<MultiRecommend | null>(null);
  const [items, setItems] = useState<MultiProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const propose = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await post<MultiRecommend>(`/api/projects/${project.id}/recommend-multi`, { seed: Math.floor(Math.random() * 10000) });
      setRec(r); setItems((prev) => [...prev.filter((p) => p.manual), ...r.proposals]);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [project.id]);
  useEffect(() => { if (editor) void propose(); }, [project.id, editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // 다음 실험 표는 엑셀식 그리드: 행 = 제안(또는 직접 추가), 외부 표를 붙여넣으면 행이 늘어난다
  type PRow = Record<string, string>;
  const rows: PRow[] = items.map((p, i) => ({
    ...Object.fromEntries(cfg.factors.map((f) => [f.key, Number.isFinite(p.x[f.key]) ? String(p.x[f.key]) : ""])),
    purpose: p.manual ?? PURPOSE[p.reason_type], _i: String(i),
  }));
  const pcols: GridCol<PRow>[] = [
    ...cfg.factors.map<GridCol<PRow>>((f) => ({ key: f.key, label: f.name, unit: f.unit, type: "number", required: true, aliases: [f.key], width: 110,
      title: `${f.low}~${f.high}, ${f.step} 단위`,
      invalid: (r) => { const v = Number(r[f.key]); return !Number.isFinite(v) || v < f.low || v > f.high; } })),
    { key: "purpose", label: "이유", disabled: () => true, width: 120 },
  ];
  const onRows = (next: PRow[]) => setItems(next.map((r) => {
    const i = Number(r._i ?? -1);
    const base: MultiProposal = i >= 0 && items[i] ? items[i] : { x: {}, kind: "new", reason_type: "explore", reason: "직접 추가", manual: "직접 추가" };
    return { ...base, x: Object.fromEntries(cfg.factors.map((f) => [f.key, (r[f.key] ?? "").trim() === "" ? NaN : Number(r[f.key])])) };
  }));
  const rowErrors = (r: PRow) => cfg.factors.filter((f) => {
    const v = Number(r[f.key]);
    return (r[f.key] ?? "").trim() !== "" && (!Number.isFinite(v) || v < f.low || v > f.high);
  }).map((f) => `${f.name}은(는) ${f.low}~${f.high} 사이여야 합니다.`);
  const addRows = (x: Record<string, number>, count: number, manual: string, reason: string) =>
    setItems((prev) => [...prev, ...Array.from({ length: count }, () => ({ x: { ...x }, kind: "replicate" as const, reason_type: "replicate" as const, reason, manual }))]);
  const valid = items.length > 0 && items.every((p) => cfg.factors.every((f) => Number.isFinite(p.x[f.key]) && p.x[f.key] >= f.low && p.x[f.key] <= f.high));
  const accept = async () => {
    setSaving(true);
    try {
      await post(`/api/projects/${project.id}/batches/accept`, {
        proposals: items.map((p) => ({ kind: p.kind, reason: p.reason, x: Object.fromEntries(cfg.factors.map((f) => [f.key, snap(p.x[f.key], f)])) })),
        surrogate: rec?.surrogate ?? st.default_surrogate, surrogate_version: rec?.surrogate_version ?? "",
        acquisition: { objective: rec?.objective ?? "다목적", mode: rec?.mode ?? st.mode, pool_size: rec?.pool_size ?? 0 },
      });
      await reload();
      notifyProjectsChanged();
      toast(`다음 실험 ${items.length}건을 확정했습니다.`);
      onDone();
    } catch (e) { toast((e as Error).message, true); } finally { setSaving(false); }
  };

  // 자세히 보기 안의 항목은 열 때만 계산
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.target !== e.currentTarget) return; // 안쪽 <details>의 열고 닫기는 무시
    if (e.currentTarget.open) setOpen((o) => ({ ...o, [k]: true })); // 한 번 연 내용은 닫아도 다시 계산하지 않도록 유지
  };

  const b = opt?.best;
  const rdef = (key: string) => cfg.responses.find((r) => r.key === key) ?? RD;
  const warns = [...new Set(opt?.responses.flatMap((d) => [...(d.warnings ?? []).map((w) => `${d.name}: ${w}`), ...(d.skipped ? [`${d.name}: ${d.skipped}`] : [])]) ?? [])];
  const s = b ? score(b.desirability) : 0;

  return (
    <section className="panel step-panel">
      <StepHead title={editor ? "학습 결과를 보고 다음 실험을 확정하세요" : "학습 결과"} />

      {/* 1. 추천 레시피 */}
      <div className="block">
        <div className="block-head">
          <h3><Sparkles size={16} />추천 레시피</h3>
          {b && <span className={`score-badge ${s >= 80 ? "good" : s >= 50 ? "mid" : "low"}`} title="모든 응답의 목표를 함께 만족하는 정도 (100점 만점)">목표 달성 {s}점</span>}
        </div>
        {!opt && !optErr && <div className="busy"><span className="spinner" /> 실험 결과로 학습하는 중</div>}
        {optErr && <div className="notice warn">{optErr}</div>}
        {b && opt && (
          <>
            <div className="cond-big">
              {cfg.factors.map((f) => <div key={f.key}><span>{f.name}</span><b>{fmtFactor(b.x[f.key], f)}<small>{f.unit}</small></b></div>)}
            </div>
            <ul className="plain-resps">{b.responses.map((r) => <PlainResponse key={r.key} r={r} d={rdef(r.key)} />)}</ul>
            {(opt.tentative || b.extrapolation) && (
              <p className="tentative"><AlertTriangle size={14} />아직 실험이 적어 예측이 정확하지 않을 수 있습니다. 다음 실험을 하면 더 정확해집니다.</p>
            )}
          </>
        )}
      </div>

      {/* 2. 다음 실험 */}
      {editor && (
        <div className="block">
          <div className="block-head">
            <h3>다음에 할 실험 {items.length}건</h3>
            <span className="grow" />
            <button className="small ghost" onClick={() => void propose()} disabled={busy}><RefreshCw size={13} />다시 고르기</button>
          </div>
          {busy && <div className="busy"><span className="spinner" /> 다음 실험 조건을 고르는 중</div>}
          {err && <div className="notice warn">{err}</div>}
          <EditGrid name="next" rows={rows} cols={pcols} onChange={onRows} minRows={0} errors={rowErrors} showMissing={!valid && items.length > 0}
            makeRow={() => ({ ...Object.fromEntries(cfg.factors.map((f) => [f.key, ""])), purpose: "직접 추가", _i: "-1" })} addLabel="조건 추가" />
          <div className="row" style={{ marginTop: 8 }}>
            {b && <button className="small" onClick={() => addRows(b.x, 3, "확인 실험", "확인 실험: 추천 레시피가 예측대로 재현되는지 확인")}><Plus size={13} />추천 레시피 확인 실험 3회</button>}
          </div>
          <div className="step-foot">
            <span className="grow" />
            <button className="primary big" disabled={busy || saving || !valid} onClick={accept}>
              {saving ? "확정 중…" : `다음 실험 ${items.length}건 확정 → 실험 데이터 입력`}</button>
          </div>
        </div>
      )}

      {/* 3. 자세히 보기: 필요한 사람만 */}
      {b && opt && (
        <details className="more-all" onToggle={toggle("all")}>
          <summary>자세히 보기 <span className="muted small">대안 · 예측 범위 · 모델 신뢰도 · 그래프 · 시뮬레이션</span></summary>
          {open.all && (
            <div className="stack" style={{ marginTop: 12 }}>
              <section>
                <h4>응답별 예측</h4>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>응답</th><th>기준</th><th className="r">예상 평균 (범위)</th><th className="r">1회 측정 범위</th><th className="r">산포 σ</th><th className="r">규격 안 확률</th><th className="r">만족도</th></tr></thead>
                    <tbody>{b.responses.map((r) => {
                      const d = rdef(r.key);
                      return (
                        <tr key={r.key} className={r.weight <= 0 ? "dim" : ""}>
                          <td>{r.name}{r.weight !== 1 && <span className="muted small"> (가중치 {r.weight})</span>}</td>
                          <td className="small muted">{r.criterion}</td>
                          <td className="r num">{fmtResp(r.mean, d)} <span className="muted small">({fmtResp(r.mean_lo, d)}~{fmtResp(r.mean_hi, d)})</span></td>
                          <td className="r num">{fmtResp(r.obs_lo, d)} ~ {fmtResp(r.obs_hi, d)}</td>
                          <td className="r num">{fmtResp(r.sigma, d)}</td>
                          <td className="r num">{r.spec_prob === null ? "–" : pct(r.spec_prob)}</td>
                          <td className="r num">{score(r.desirability)}</td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                </div>
              </section>
              {opt.alternatives.length > 0 && (
                <section>
                  <h4>다른 선택지 <span className="muted small">한 응답을 더 우선하면 이렇게 됩니다</span></h4>
                  <div className="table-wrap">
                    <table>
                      <thead><tr>
                        <th>대안</th>
                        {cfg.factors.map((f) => <th key={f.key} className="r">{f.name} <span className="unit">{f.unit}</span></th>)}
                        {b.responses.map((r) => <th key={r.key} className="r">{r.name}</th>)}
                        <th className="r">목표 달성</th>{editor && <th />}
                      </tr></thead>
                      <tbody>{[{ ...b, why: "추천 레시피" } as RecipeOption, ...opt.alternatives].map((a, i) => (
                        <tr key={i} className={i === 0 ? "best-row" : ""}>
                          <td className="small">{a.why}</td>
                          {cfg.factors.map((f) => <td key={f.key} className="r num">{fmtFactor(a.x[f.key], f)}</td>)}
                          {a.responses.map((r) => <td key={r.key} className="r num">{fmtResp(r.mean, rdef(r.key))}{r.spec_prob !== null && <div className="small muted">{pct(r.spec_prob)}</div>}</td>)}
                          <td className="r num"><b>{score(a.desirability)}점</b></td>
                          {editor && <td className="r"><button className="small" onClick={() => addRows(a.x, 1, i === 0 ? "확인 실험" : "대안 확인", `확인 실험 (${a.why})`)}><Plus size={13} />다음 실험에</button></td>}
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </section>
              )}
              <section>
                <h4>모델 신뢰도</h4>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>응답</th><th className="r">실험 조건</th><th className="r">측정</th><th>산포 추정</th><th className="r">95% 구간 포함률</th><th className="r">예측 오차</th></tr></thead>
                    <tbody>{opt.responses.map((d) => (
                      <tr key={d.key}>
                        <td>{d.name}</td><td className="r">{d.data.n_points}</td><td className="r">{d.data.n_obs}</td>
                        <td>{d.skipped ? "학습 안 함" : d.variance_reliability === "ok" ? "가능" : d.variance_reliability === "low" ? "신뢰도 낮음" : "반복 없음"}</td>
                        <td className="r">{d.validation?.available ? pct(d.validation.coverage95) : "–"}{d.validation?.status === "warn" && " ⚠"}</td>
                        <td className="r">{d.validation?.available ? fmtResp(d.validation.rmse, rdef(d.key)) : "–"}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                {warns.length > 0 && <div className="notice warn" style={{ marginTop: 8 }}><ul>{warns.map((w) => <li key={w}>{w}</li>)}</ul></div>}
                {opt.decomposition_is_approximate && <div className="notice warn" style={{ marginTop: 8 }}>TabPFN(실험적) 결과는 평가용입니다.</div>}
              </section>
              <details className="more" onToggle={toggle("graphs")}>
                <summary>그래프 (평균·산포 지도, 인자별 영향)</summary>
                {open.graphs && <div style={{ marginTop: 12 }}><ErrorBoundary label="그래프"><AnalysisSection /></ErrorBoundary></div>}
              </details>
              <details className="more" onToggle={toggle("sim")}>
                <summary>조건 시뮬레이션</summary>
                {open.sim && <div style={{ marginTop: 12 }}><ErrorBoundary label="조건 시뮬레이션"><MultiWhatIf projectId={project.id} factors={cfg.factors} responses={cfg.responses} start={b.x} /></ErrorBoundary></div>}
              </details>
              {tabpfnOn && (
                <details className="more" onToggle={toggle("compare")}>
                  <summary>모델 비교: Gaussian Process vs TabPFN</summary>
                  {open.compare && <div style={{ marginTop: 12 }}><ErrorBoundary label="모델 비교"><CompareSection /></ErrorBoundary></div>}
                </details>
              )}
            </div>
          )}
        </details>
      )}
    </section>
  );
}
