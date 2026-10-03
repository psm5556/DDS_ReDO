import { ClipboardPaste, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { get, patch, post } from "../api";
import { DataToConfigModal, type DataConfig } from "../components/DataToConfig";
import { EditGrid, type GridCol } from "../components/EditGrid";
import { MODE_LABEL } from "../format";
import { notifyProjectsChanged } from "../guide/steps";
import { useToast } from "../toast";
import type { FactorDef, ProjectConfig, ProjectDetail, ResponseDef, SurrogateInfo } from "../types";

type FRow = { key: string; name: string; unit: string; low: string; high: string; step: string; scale: "linear" | "log"; baseline: string; locked?: boolean };
type RRow = { key: string; name: string; unit: string; goal: ResponseDef["goal"]; target: string; lsl: string; usl: string;
  criterion: NonNullable<ResponseDef["criterion"]>; weight: string; input_min: string; input_max: string; decimals: string; locked?: boolean };

const n = (s: string) => (s.trim() === "" ? null : Number(s));
const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
function newKey(prefix: string, used: string[]) {
  let i = 1;
  while (used.includes(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

function factorErrors(f: FRow, needBaseline = false): string[] {
  const e: string[] = [];
  if (needBaseline && !f.locked) {
    const b = n(f.baseline), lo0 = n(f.low), hi0 = n(f.high);
    if (b === null || Number.isNaN(b)) e.push("기존 실험 값(그동안 고정해 둔 값)을 입력하세요.");
    else if (lo0 !== null && hi0 !== null && (b < lo0 || b > hi0)) e.push("기존 실험 값이 하한~상한 밖입니다.");
  }
  if (!f.name.trim()) e.push("이름을 입력하세요.");
  const lo = n(f.low), hi = n(f.high), st = n(f.step);
  if (lo === null || hi === null || Number.isNaN(lo) || Number.isNaN(hi)) e.push("하한·상한을 숫자로 입력하세요.");
  else if (hi <= lo) e.push("상한이 하한보다 커야 합니다.");
  if (st === null || Number.isNaN(st) || st <= 0) e.push("세팅 정밀도는 0보다 커야 합니다.");
  else if (lo !== null && hi !== null && (hi - lo) / st < 2) e.push("범위가 세팅 정밀도에 비해 너무 좁습니다.");
  if (f.scale === "log" && lo !== null && lo <= 0) e.push("로그 스케일은 하한이 0보다 커야 합니다.");
  return e;
}
function responseErrors(r: RRow): string[] {
  const e: string[] = [];
  if (!r.name.trim()) e.push("이름을 입력하세요.");
  const t = n(r.target), lsl = n(r.lsl), usl = n(r.usl), w = n(r.weight);
  if ([t, lsl, usl, w, n(r.input_min), n(r.input_max)].some((v) => v !== null && Number.isNaN(v))) e.push("숫자 칸에 숫자가 아닌 값이 있습니다.");
  if (r.goal === "target" && t === null) e.push("목표값(망목)을 입력하세요.");
  if (lsl !== null && usl !== null && lsl >= usl) e.push("LSL이 USL보다 작아야 합니다.");
  if (r.goal === "target" && t !== null && ((lsl !== null && t < lsl) || (usl !== null && t > usl))) e.push("목표값이 규격 밖입니다.");
  if (r.criterion === "spec_prob" && lsl === null && usl === null) e.push("규격 만족 확률 기준에는 LSL 또는 USL이 필요합니다.");
  if (r.criterion === "taguchi" && r.goal !== "target") e.push("품질 손실 기준은 목표값(망목) 응답에만 씁니다.");
  if (w !== null && (w < 0 || w > 10)) e.push("가중치는 0~10입니다.");
  return e;
}

const GOALS: [string, string][] = [["maximize", "최대 (망대)"], ["minimize", "최소 (망소)"], ["target", "목표값 (망목)"]];
const CRITERIA: [string, string][] = [["auto", "자동"], ["spec_prob", "규격 만족 확률"], ["mean_k_sigma", "평균∓kσ"], ["taguchi", "품질 손실"], ["mean", "평균만"]];

const FCOLS: GridCol<FRow>[] = [
  { key: "name", label: "인자", aliases: ["인자 이름", "인자명", "이름", "factor"], width: 160, placeholder: "예: RF 파워", required: true },
  { key: "low", label: "하한", aliases: ["최소", "min", "low"], type: "number", width: 80, required: true },
  { key: "high", label: "상한", aliases: ["최대", "max", "high"], type: "number", width: 80, required: true },
  { key: "step", label: "세팅 정밀도", aliases: ["정밀도", "간격", "step", "단계"], type: "number", width: 90, required: true, title: "장비에서 실제로 맞출 수 있는 최소 단위. 제안 조건은 이 단위로 반올림됩니다." },
  { key: "scale", label: "스케일", aliases: ["scale"], type: "select", options: [["linear", "선형"], ["log", "로그"]], width: 80 },
  { key: "unit", label: "단위", aliases: ["unit"], width: 70, placeholder: "W" },
];
const RCOLS: GridCol<RRow>[] = [
  { key: "name", label: "응답", aliases: ["응답 이름", "응답명", "이름", "response"], width: 130, placeholder: "예: 식각률", required: true },
  { key: "goal", label: "목표", aliases: ["goal", "특성"], type: "select", options: GOALS, width: 120, required: true },
  { key: "target", label: "목표값", aliases: ["target", "타깃"], type: "number", width: 70, disabled: (r) => r.goal !== "target",
    required: (r) => r.goal === "target", title: "목표값(망목)일 때 필수" },
  { key: "lsl", label: "LSL", aliases: ["규격 하한", "하한"], type: "number", width: 64, required: (r) => r.criterion === "spec_prob" && !r.usl.trim(), title: "규격 만족 확률 기준이면 LSL 또는 USL 필수" },
  { key: "usl", label: "USL", aliases: ["규격 상한", "상한"], type: "number", width: 64, required: (r) => r.criterion === "spec_prob" && !r.lsl.trim(), title: "규격 만족 확률 기준이면 LSL 또는 USL 필수" },
  { key: "criterion", label: "최적화 기준", aliases: ["기준", "criterion"], type: "select", options: CRITERIA, width: 120,
    title: "자동: 규격이 있으면 규격 만족 확률, 없으면 평균∓kσ(망목은 품질 손실)" },
  { key: "weight", label: "가중치", aliases: ["중요도", "weight"], type: "number", width: 60, title: "다목적 최적화에서의 중요도 (0이면 관찰만)" },
  { key: "input_min", label: "입력 최소", aliases: ["허용 최소"], type: "number", width: 70, title: "결과 입력 시 오타 검출용" },
  { key: "input_max", label: "입력 최대", aliases: ["허용 최대"], type: "number", width: 70, title: "결과 입력 시 오타 검출용" },
  { key: "decimals", label: "소수점", aliases: ["자리수", "decimals"], type: "number", width: 56 },
  { key: "unit", label: "단위", aliases: ["unit"], width: 70, placeholder: "nm/min" },
];

const blankF = (rows: FRow[]): FRow => ({ key: newKey("f", rows.map((x) => x.key)), name: "", unit: "", low: "", high: "", step: "1", scale: "linear", baseline: "" });
const blankR = (rows: RRow[]): RRow => ({ key: newKey("r", rows.map((x) => x.key)), name: "", unit: "", goal: "maximize", target: "", lsl: "", usl: "",
  criterion: "auto", weight: "1", input_min: "", input_max: "", decimals: "2" });

/** DOE 만들기(/new)·DOE 설정(DOE 이름 클릭) 한 페이지: 기본 정보 + 인자 표 + 응답·목표 표 + 실험 계획 한 줄 */
export default function WizardPage({ onSaved }: { onSaved?: () => void } = {}) {
  const { pid } = useParams();
  const editing = !!pid;
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [tags, setTags] = useState("");
  const [factors, setFactors] = useState<FRow[]>([blankF([])]);
  const [responses, setResponses] = useState<RRow[]>([blankR([])]);
  const [settings, setSettings] = useState<ProjectConfig["settings"]>({
    mode: "robust", robust_objective: "spec_prob", k_sigma: 2, batch_size: 4, budget_runs: 40, default_surrogate: "gp",
    design_method: "sobol", initial_points: null, replicate_fraction: 0.25, replicates_per_point: 3, primary_response: null,
  });
  const [surrogates, setSurrogates] = useState<SurrogateInfo[]>([]);
  const [hasRuns, setHasRuns] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showErr, setShowErr] = useState(false);
  // 기존 데이터에서 만들기: DOE를 만든 뒤 바로 가져올 행 (인자·응답 key로)
  const [fromData, setFromData] = useState(false);
  const [pending, setPending] = useState<{ x: Record<string, number | null>; values: Record<string, number | null>; note: string }[] | null>(null);
  const applyData = (c: DataConfig) => {
    const fk = c.factors.map((_, i) => `f${i + 1}`);
    const rk = c.responses.map((_, i) => `r${i + 1}`);
    setFactors(c.factors.map((f, i) => ({ ...blankF([]), key: fk[i], name: f.name, unit: f.unit, low: String(f.low), high: String(f.high), step: String(+f.step.toPrecision(6)) })));
    setResponses(c.responses.map((r, i) => ({ ...blankR([]), key: rk[i], name: r.name, unit: r.unit, goal: r.goal, decimals: String(r.decimals) })));
    setPending(c.rows.map((r) => ({
      x: Object.fromEntries(fk.map((k, i) => [k, r.x[i]])),
      values: Object.fromEntries(rk.map((k, i) => [k, r.y[i]])),
      note: r.note,
    })));
    toast(`인자 ${c.factors.length}개 · 응답 ${c.responses.length}개를 채웠습니다. 목표·규격을 확인하고 DOE를 만드세요.`);
  };

  useEffect(() => { get<SurrogateInfo[]>("/api/surrogates").then(setSurrogates).catch(() => {}); }, []);
  useEffect(() => {
    if (!pid) return;
    get<ProjectDetail>(`/api/projects/${pid}`).then((p) => {
      setName(p.name); setDesc(p.description); setTags(p.tags.join(", "));
      setHasRuns(p.runs_total > 0);
      setFactors(p.config.factors.map((f) => ({ ...f, low: str(f.low), high: str(f.high), step: str(f.step), baseline: "", locked: p.runs_total > 0 })));
      setResponses(p.config.responses.map((r) => ({ key: r.key, name: r.name, unit: r.unit, goal: r.goal, target: str(r.target), lsl: str(r.lsl),
        usl: str(r.usl), criterion: r.criterion ?? "auto", weight: str(r.weight ?? 1), input_min: str(r.input_min), input_max: str(r.input_max),
        decimals: str(r.decimals), locked: p.runs_total > 0 })));
      setSettings(p.config.settings);
    }).catch((e) => setErr(e.message));
  }, [pid]);

  const fErrOf = (f: FRow) => factorErrors(f, hasRuns);
  const fErr = factors.map(fErrOf);
  // 데이터가 있는 DOE에 새 인자를 넣으면 기존 실험들이 그 인자를 어떤 값에 두고 했는지 받는다
  const fCols: GridCol<FRow>[] = hasRuns && factors.some((f) => !f.locked)
    ? [...FCOLS.slice(0, -1), { key: "baseline", label: "기존 실험 값", type: "number", width: 100, disabled: (f) => !!f.locked, required: (f) => !f.locked,
        title: "이미 한 실험에서 이 인자를 고정해 둔 값. 기존 실험 데이터에 이 값으로 채워집니다." }, FCOLS[FCOLS.length - 1]]
    : FCOLS;
  const rErr = responses.map(responseErrors);
  // 가져올 기존 데이터가 지금 인자 설정과 맞는지 (인자를 새로 넣었거나 범위를 좁힌 경우)
  const dataErr: string[] = [];
  if (pending) {
    for (const f of factors) {
      const vs = pending.map((r) => r.x[f.key]).filter((v): v is number => typeof v === "number");
      if (vs.length < pending.length) dataErr.push(`기존 데이터에 '${f.name || "새 인자"}' 값이 없습니다.`);
      else if (vs.some((v) => v < Number(f.low) - 1e-9 || v > Number(f.high) + 1e-9)) dataErr.push(`기존 데이터의 '${f.name}' 값이 범위(${f.low}~${f.high}) 밖입니다.`);
    }
  }
  const valid = name.trim().length > 0 && fErr.every((e) => !e.length) && rErr.every((e) => !e.length) && !dataErr.length;
  const d = factors.length;
  const recInit = Math.max(2 * d + 2, 10);
  const initPts = settings.initial_points ?? recInit;
  const repPts = Math.round(settings.replicate_fraction * initPts);
  const initRuns = initPts - repPts + repPts * settings.replicates_per_point;

  const toConfig = (): ProjectConfig => ({
    factors: factors.map<FactorDef>((f) => ({ key: f.key, name: f.name.trim(), unit: f.unit.trim(), low: Number(f.low), high: Number(f.high), step: Number(f.step), scale: f.scale })),
    responses: responses.map<ResponseDef>((r) => ({ key: r.key, name: r.name.trim(), unit: r.unit.trim(), goal: r.goal,
      target: r.goal === "target" ? n(r.target) : null, lsl: n(r.lsl), usl: n(r.usl), input_min: n(r.input_min), input_max: n(r.input_max),
      decimals: Number(r.decimals || 3), weight: n(r.weight) ?? 1, criterion: r.criterion })),
    settings: { ...settings, primary_response: responses.some((r) => r.key === settings.primary_response) ? settings.primary_response : responses[0].key },
  });

  const save = async () => {
    if (!valid) { setShowErr(true); return; }
    setSaving(true); setErr(null);
    try {
      const body = { name: name.trim(), description: desc, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), config: toConfig() };
      if (editing) {
        const newFactorValues = Object.fromEntries(factors.filter((f) => hasRuns && !f.locked).map((f) => [f.key, Number(f.baseline)]));
        await patch(`/api/projects/${pid}`, { ...body, change_reason: reason, new_factor_values: newFactorValues });
        toast("설정을 저장했습니다.");
        setReason("");
        onSaved?.();
      } else {
        const p = await post<ProjectDetail>("/api/projects", body);
        notifyProjectsChanged();
        if (pending?.length) {
          try {
            const rows = pending.map((r) => ({ x: r.x, values: Object.fromEntries(responses.map((x) => [x.key, r.values[x.key] ?? null])), note: r.note }));
            const res = await post<{ imported: number; done: number }>(`/api/projects/${p.id}/import`, { rows });
            notifyProjectsChanged();
            toast(`DOE를 만들고 기존 데이터 ${res.imported}건을 가져왔습니다.`);
            nav(`/projects/${p.id}/step/${res.done === res.imported ? 2 : 1}`);
          } catch (e) {
            toast(`DOE는 만들었지만 기존 데이터를 가져오지 못했습니다: ${(e as Error).message}`, true);
            nav(`/projects/${p.id}/step/1`);
          }
          return;
        }
        toast("DOE를 만들었습니다.");
        nav(`/projects/${p.id}/step/1`);
      }
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };
  const num = (k: keyof ProjectConfig["settings"]) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setSettings({ ...settings, [k]: e.target.value === "" ? null : Number(e.target.value) });

  return (
    <div className={editing ? "" : "page"} style={editing ? undefined : { maxWidth: 1240 }}>
      {!editing && (
        <div className="page-head">
          <div className="grow"><h1>새 DOE 만들기</h1></div>
          <button onClick={() => setFromData(true)} title="이미 해 둔 실험 데이터(엑셀 표)를 붙여넣으면 인자·응답을 채우고, DOE를 만든 뒤 데이터를 가져옵니다"><ClipboardPaste size={16} />기존 데이터에서 만들기</button>
          <Link className="btn ghost" to="/">취소</Link>
        </div>
      )}
      {err && <div className="notice err" style={{ marginBottom: 12 }}>{err}</div>}
      {fromData && <DataToConfigModal onClose={() => setFromData(false)} onApply={applyData} />}
      {pending && (
        <div className="notice info" style={{ marginBottom: 12 }}>
          <ClipboardPaste size={16} />
          <span className="grow">기존 데이터 <b>{pending.length}건</b>은 DOE를 만든 뒤 바로 가져와 학습합니다. 응답의 목표·규격을 확인하세요.</span>
          <button className="small ghost" onClick={() => setPending(null)}><X size={14} />데이터 빼기</button>
        </div>
      )}
      <div className={editing ? "doe-form" : "panel doe-form"}>
        <section>
          <div className="form-row">
            <label className="field" style={{ flex: 2 }}><span className="lbl">DOE 이름<span className="req-mark" aria-label="필수">*</span></span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: Poly-Si 식각 레시피 개발" autoFocus={!editing}
                className={showErr && !name.trim() ? "invalid" : ""} /></label>
            <label className="field" style={{ flex: 3 }}><span className="lbl">설명</span>
              <input type="text" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
            <label className="field" style={{ flex: 1 }}><span className="lbl">태그</span>
              <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="쉼표로 구분" /></label>
          </div>
        </section>

        <section>
          <h3>인자 <span className="muted small">{factors.length}개{hasRuns ? " · 실험한 인자는 삭제 불가" : ""}</span><span className="req-legend"><span className="req-mark">*</span> 필수</span></h3>
          <EditGrid name="factor" rows={factors} cols={fCols} onChange={setFactors} makeRow={blankF} canAdd={factors.length < 20}
            canRemove={(f) => !f.locked} errors={showErr ? fErrOf : undefined} showMissing={showErr} addLabel="인자 추가" />
        </section>

        <section>
          <h3>응답과 목표 <span className="muted small">{responses.length}개 · 모든 응답을 함께 최적화 (가중치 = 중요도)</span></h3>
          <EditGrid name="response" rows={responses} cols={RCOLS} onChange={setResponses} makeRow={blankR} canAdd={responses.length < 10}
            canRemove={(r) => !r.locked} errors={showErr ? responseErrors : undefined} showMissing={showErr} addLabel="응답 추가" />
        </section>

        <section>
          <h3>실험 계획</h3>
          <div className="table-wrap">
            <table className="grid-table edit-grid">
              <thead><tr>
                <th>최적화 방식</th><th title="평균∓kσ 기준의 k">k</th><th>초기 실험점</th><th>반복 비율</th><th>반복 횟수</th>
                <th>한 번에 제안</th><th>실험 예산 (런)</th><th>예측 모델</th>
              </tr></thead>
              <tbody><tr>
                <td className="text"><select aria-label="최적화 방식" value={settings.mode} onChange={(e) => setSettings({ ...settings, mode: e.target.value as typeof settings.mode })}>
                  {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                <td><input aria-label="k" type="text" inputMode="decimal" value={settings.k_sigma} onChange={num("k_sigma")} /></td>
                <td title={`권장 ${recInit}개 이상`}><input aria-label="초기 실험점" type="text" inputMode="numeric" value={initPts} onChange={num("initial_points")} /></td>
                <td className="text"><select aria-label="반복 비율" value={settings.replicate_fraction} onChange={num("replicate_fraction")}>
                  {[0, 0.15, 0.25, 0.34, 0.5].map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}</select></td>
                <td className="text"><select aria-label="반복 횟수" value={settings.replicates_per_point} onChange={num("replicates_per_point")}>
                  {[2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}회</option>)}</select></td>
                <td><input aria-label="한 번에 제안" type="text" inputMode="numeric" value={settings.batch_size} onChange={num("batch_size")} /></td>
                <td><input aria-label="실험 예산" type="text" inputMode="numeric" value={settings.budget_runs} onChange={num("budget_runs")} /></td>
                <td className="text"><select aria-label="예측 모델" value={settings.default_surrogate} onChange={(e) => setSettings({ ...settings, default_surrogate: e.target.value as typeof settings.default_surrogate })}>
                  {(surrogates.length ? surrogates : [{ name: "gp", label: "Gaussian Process", available: true, experimental: false, status: "" }]).map((s) => (
                    <option key={s.name} value={s.name} disabled={!s.available}>{s.label}{s.experimental ? " (실험적)" : ""}</option>))}</select></td>
              </tr></tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginTop: 6 }}>
            첫 실험 {initPts}개 조건 · 총 {initRuns}회 (반복 {repPts}개 조건 × {settings.replicates_per_point}회){initPts < recInit ? ` · 인자 ${d}개에는 ${recInit}개 이상 권장` : ""}
            {settings.replicate_fraction === 0 ? " · 반복이 없으면 산포를 추정할 수 없습니다" : ""}
          </p>
        </section>

        {showErr && !valid && <div className="notice err">빨간 칸을 고쳐 주세요.{!name.trim() ? " DOE 이름을 입력하세요." : ""} {dataErr.join(" ")}</div>}
        {!showErr && dataErr.length > 0 && <div className="notice warn">{dataErr.join(" ")}</div>}
        <div className="row form-foot">
          {editing && <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="변경 사유 (선택)" aria-label="변경 사유" style={{ flex: 1, minWidth: 220 }} />}
          {!editing && <span className="grow" />}
          <button className="primary big" disabled={saving} onClick={save}>{saving ? "저장 중" : editing ? "설정 저장" : pending ? `DOE 만들기 + 데이터 ${pending.length}건 가져오기` : "DOE 만들기"}</button>
        </div>
      </div>
    </div>
  );
}
