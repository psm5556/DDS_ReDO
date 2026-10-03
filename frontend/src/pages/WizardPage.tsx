import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { get, patch, post } from "../api";
import { GOAL_LABEL, MODE_LABEL, OBJ_LABEL } from "../format";
import { useToast } from "../toast";
import type { FactorDef, ProjectConfig, ProjectDetail, ResponseDef, SurrogateInfo } from "../types";

type FRow = { key: string; name: string; unit: string; low: string; high: string; step: string; scale: "linear" | "log"; locked?: boolean };
type RRow = { key: string; name: string; unit: string; goal: ResponseDef["goal"]; target: string; lsl: string; usl: string;
  input_min: string; input_max: string; decimals: string; locked?: boolean };

const STEPS = ["기본 정보", "인자", "응답과 목표", "실험 계획", "확인"];
const n = (s: string) => (s.trim() === "" ? null : Number(s));
const str = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

function newKey(prefix: string, used: string[]) {
  let i = 1;
  while (used.includes(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

function factorErrors(f: FRow): string[] {
  const e: string[] = [];
  if (!f.name.trim()) e.push("이름을 입력하세요.");
  const lo = n(f.low), hi = n(f.high), st = n(f.step);
  if (lo === null || hi === null || Number.isNaN(lo) || Number.isNaN(hi)) e.push("하한과 상한을 숫자로 입력하세요.");
  else if (hi <= lo) e.push("상한이 하한보다 커야 합니다.");
  if (st === null || Number.isNaN(st) || st <= 0) e.push("세팅 정밀도는 0보다 커야 합니다.");
  else if (lo !== null && hi !== null && (hi - lo) / st < 2) e.push("범위가 세팅 정밀도에 비해 너무 좁습니다.");
  if (f.scale === "log" && lo !== null && lo <= 0) e.push("로그 스케일은 하한이 0보다 커야 합니다.");
  return e;
}
function responseErrors(r: RRow): string[] {
  const e: string[] = [];
  if (!r.name.trim()) e.push("이름을 입력하세요.");
  const t = n(r.target), lsl = n(r.lsl), usl = n(r.usl);
  if (r.goal === "target" && t === null) e.push("목표값을 입력하세요.");
  if (lsl !== null && usl !== null && lsl >= usl) e.push("규격 하한이 상한보다 작아야 합니다.");
  if (r.goal === "target" && t !== null && ((lsl !== null && t < lsl) || (usl !== null && t > usl))) e.push("목표값이 규격 범위 밖에 있습니다.");
  return e;
}

export default function WizardPage() {
  const { pid } = useParams();
  const editing = !!pid;
  const nav = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [tags, setTags] = useState("");
  const [factors, setFactors] = useState<FRow[]>([{ key: "f1", name: "", unit: "", low: "", high: "", step: "1", scale: "linear" }]);
  const [responses, setResponses] = useState<RRow[]>([{ key: "r1", name: "", unit: "", goal: "target", target: "", lsl: "", usl: "", input_min: "", input_max: "", decimals: "2" }]);
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

  useEffect(() => { get<SurrogateInfo[]>("/api/surrogates").then(setSurrogates).catch(() => {}); }, []);
  useEffect(() => {
    if (!pid) return;
    get<ProjectDetail>(`/api/projects/${pid}`).then((p) => {
      setName(p.name); setDesc(p.description); setTags(p.tags.join(", "));
      setHasRuns(p.runs_total > 0);
      setFactors(p.config.factors.map((f) => ({ ...f, low: str(f.low), high: str(f.high), step: str(f.step), locked: p.runs_total > 0 })));
      setResponses(p.config.responses.map((r) => ({ ...r, target: str(r.target), lsl: str(r.lsl), usl: str(r.usl),
        input_min: str(r.input_min), input_max: str(r.input_max), decimals: str(r.decimals), unit: r.unit, locked: p.runs_total > 0 })));
      setSettings(p.config.settings);
    }).catch((e) => setErr(e.message));
  }, [pid]);

  const fErr = factors.map(factorErrors);
  const rErr = responses.map(responseErrors);
  const stepValid = [name.trim().length > 0, fErr.every((e) => e.length === 0), rErr.every((e) => e.length === 0), true, true];
  const d = factors.length;
  const recInit = Math.max(2 * d + 2, 10);
  const initPts = settings.initial_points ?? recInit;
  const repPts = Math.round(settings.replicate_fraction * initPts);
  const initRuns = initPts - repPts + repPts * settings.replicates_per_point;
  const primary = responses.find((r) => r.key === settings.primary_response) ?? responses[0];
  const primaryHasSpec = primary && (n(primary.lsl) !== null || n(primary.usl) !== null);

  const toConfig = (): ProjectConfig => ({
    factors: factors.map<FactorDef>((f) => ({ key: f.key, name: f.name.trim(), unit: f.unit.trim(), low: Number(f.low), high: Number(f.high), step: Number(f.step), scale: f.scale })),
    responses: responses.map<ResponseDef>((r) => ({ key: r.key, name: r.name.trim(), unit: r.unit.trim(), goal: r.goal,
      target: n(r.target), lsl: n(r.lsl), usl: n(r.usl), input_min: n(r.input_min), input_max: n(r.input_max), decimals: Number(r.decimals || 3) })),
    settings: { ...settings, primary_response: settings.primary_response && responses.some((r) => r.key === settings.primary_response) ? settings.primary_response : responses[0].key },
  });

  const next = () => {
    if (!stepValid[step]) { setShowErr(true); return; }
    setShowErr(false);
    setStep(Math.min(step + 1, STEPS.length - 1));
  };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const body = { name: name.trim(), description: desc, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), config: toConfig() };
      if (editing) {
        await patch(`/api/projects/${pid}`, { ...body, change_reason: reason });
        toast("설정을 저장했습니다.");
        nav(`/projects/${pid}`);
      } else {
        const p = await post<ProjectDetail>("/api/projects", body);
        toast("DOE를 만들었습니다. 이제 초기 실험 계획을 만드세요.");
        nav(`/projects/${p.id}`);
      }
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  const setF = (i: number, patchF: Partial<FRow>) => setFactors(factors.map((f, j) => (j === i ? { ...f, ...patchF } : f)));
  const setR = (i: number, patchR: Partial<RRow>) => setResponses(responses.map((r, j) => (j === i ? { ...r, ...patchR } : r)));

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-head">
        <div className="grow">
          <h1>{editing ? "DOE 설정 수정" : "새 DOE 만들기"}</h1>
          <p>{editing ? "실험 데이터가 있는 DOE에서는 인자를 추가하거나 삭제할 수 없습니다. 범위와 목표, 규격은 바꿀 수 있습니다." : "단계별로 입력하세요. 나중에 설정에서 언제든 고칠 수 있습니다."}</p>
        </div>
        <Link className="btn ghost" to={editing ? `/projects/${pid}` : "/"}>취소</Link>
      </div>

      <nav className="steps" aria-label="단계">
        {STEPS.map((s, i) => (
          <button key={s} className={i === step ? "on" : i < step ? "done" : ""} onClick={() => { if (i <= step || stepValid.slice(0, i).every(Boolean)) setStep(i); }}>
            <span className="k">{i + 1}</span>{s}
          </button>
        ))}
      </nav>

      {err && <div className="notice err" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="panel">
        {step === 0 && (
          <div className="stack" style={{ maxWidth: 640 }}>
            <label className="field"><span className="lbl">DOE 이름</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: Poly-Si 식각 레시피 개발" autoFocus
                className={showErr && !name.trim() ? "invalid" : ""} />
              {showErr && !name.trim() && <span className="field-error">이름을 입력하세요.</span>}
            </label>
            <label className="field"><span className="lbl">설명</span>
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="무엇을 목표로 하는 실험인지 적어 두면 함께하는 사람이 이해하기 쉽습니다." />
            </label>
            <label className="field"><span className="lbl">태그</span>
              <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="쉼표로 구분 (예: 식각, 게이트)" />
            </label>
          </div>
        )}

        {step === 1 && (
          <div>
            <p className="muted small" style={{ marginBottom: 12 }}>
              실험에서 바꿀 조건(인자)과 범위를 입력하세요. <b>세팅 정밀도</b>는 장비에서 실제로 맞출 수 있는 최소 단위입니다. 제안되는 조건은 이 단위로 반올림됩니다.
            </p>
            {factors.map((f, i) => (
              <div key={f.key}>
                <div className="def-row factor">
                  <label className="field"><span className="lbl">인자 이름</span><input type="text" value={f.name} placeholder="예: RF 파워" onChange={(e) => setF(i, { name: e.target.value })} /></label>
                  <label className="field"><span className="lbl">단위</span><input type="text" value={f.unit} placeholder="W" onChange={(e) => setF(i, { unit: e.target.value })} /></label>
                  <label className="field"><span className="lbl">하한</span><input type="number" value={f.low} onChange={(e) => setF(i, { low: e.target.value })} /></label>
                  <label className="field"><span className="lbl">상한</span><input type="number" value={f.high} onChange={(e) => setF(i, { high: e.target.value })} /></label>
                  <label className="field"><span className="lbl">세팅 정밀도</span><input type="number" value={f.step} min={0} onChange={(e) => setF(i, { step: e.target.value })} /></label>
                  <label className="field"><span className="lbl">스케일</span>
                    <select value={f.scale} onChange={(e) => setF(i, { scale: e.target.value as FRow["scale"] })}>
                      <option value="linear">선형</option><option value="log">로그 (자릿수가 크게 변할 때)</option>
                    </select>
                  </label>
                  <button className="ghost small" disabled={factors.length === 1 || f.locked} title={f.locked ? "실험 데이터가 있어 삭제할 수 없습니다." : ""}
                    onClick={() => setFactors(factors.filter((_, j) => j !== i))}>삭제</button>
                </div>
                {showErr && fErr[i].length > 0 && <div className="field-error" style={{ margin: "4px 0 0 12px" }}>{fErr[i].join(" ")}</div>}
              </div>
            ))}
            <div className="row" style={{ marginTop: 12 }}>
              <button disabled={hasRuns || factors.length >= 20} onClick={() => setFactors([...factors, { key: newKey("f", factors.map((x) => x.key)), name: "", unit: "", low: "", high: "", step: "1", scale: "linear" }])}>인자 추가</button>
              <span className="small muted">인자 {factors.length}개 · 권장 초기 실험점 {recInit}개</span>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <p className="muted small" style={{ marginBottom: 12 }}>
              측정할 결과(응답)와 목표를 입력하세요. 규격(LSL/USL)을 넣으면 <b>규격을 만족할 확률</b>이 가장 높은 레시피를 찾습니다.
              입력 허용 범위는 결과를 입력할 때 오타를 잡는 데 쓰입니다.
            </p>
            {responses.map((r, i) => (
              <div key={r.key}>
                <div className="def-row response">
                  <label className="field"><span className="lbl">응답 이름</span><input type="text" value={r.name} placeholder="예: 식각률" onChange={(e) => setR(i, { name: e.target.value })} /></label>
                  <label className="field"><span className="lbl">단위</span><input type="text" value={r.unit} placeholder="nm/min" onChange={(e) => setR(i, { unit: e.target.value })} /></label>
                  <label className="field"><span className="lbl">목표</span>
                    <select value={r.goal} onChange={(e) => setR(i, { goal: e.target.value as RRow["goal"] })}>
                      {Object.entries(GOAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                  <label className="field"><span className="lbl">목표값</span><input type="number" value={r.target} disabled={r.goal !== "target"} onChange={(e) => setR(i, { target: e.target.value })} /></label>
                  <label className="field"><span className="lbl">규격 하한 LSL</span><input type="number" value={r.lsl} onChange={(e) => setR(i, { lsl: e.target.value })} /></label>
                  <label className="field"><span className="lbl">규격 상한 USL</span><input type="number" value={r.usl} onChange={(e) => setR(i, { usl: e.target.value })} /></label>
                  <button className="ghost small" disabled={responses.length === 1 || r.locked} onClick={() => setResponses(responses.filter((_, j) => j !== i))}>삭제</button>
                </div>
                <div className="def-row" style={{ gridTemplateColumns: "1fr 1fr 1fr 2fr", marginTop: 0, borderTop: "none", borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                  <label className="field"><span className="lbl">입력 허용 최소</span><input type="number" value={r.input_min} onChange={(e) => setR(i, { input_min: e.target.value })} /></label>
                  <label className="field"><span className="lbl">입력 허용 최대</span><input type="number" value={r.input_max} onChange={(e) => setR(i, { input_max: e.target.value })} /></label>
                  <label className="field"><span className="lbl">소수점 자리</span><input type="number" min={0} max={8} value={r.decimals} onChange={(e) => setR(i, { decimals: e.target.value })} /></label>
                  <label className="check" style={{ alignSelf: "center" }}>
                    <input type="radio" name="primary" checked={(settings.primary_response ?? responses[0].key) === r.key} onChange={() => setSettings({ ...settings, primary_response: r.key })} />
                    최적화 기준 응답 (주 응답)
                  </label>
                </div>
                {showErr && rErr[i].length > 0 && <div className="field-error" style={{ margin: "4px 0 0 12px" }}>{rErr[i].join(" ")}</div>}
              </div>
            ))}
            <div className="row" style={{ marginTop: 12 }}>
              <button disabled={responses.length >= 10} onClick={() => setResponses([...responses, { key: newKey("r", responses.map((x) => x.key)), name: "", unit: "", goal: "maximize", target: "", lsl: "", usl: "", input_min: "", input_max: "", decimals: "2" }])}>응답 추가</button>
              <span className="small muted">여러 응답을 측정할 수 있습니다. 다음 실험 제안은 주 응답을 기준으로 합니다.</span>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="stack">
            <div className="grid-2">
              <label className="field"><span className="lbl">최적화 방식</span>
                <select value={settings.mode} onChange={(e) => setSettings({ ...settings, mode: e.target.value as typeof settings.mode })}>
                  {Object.entries(MODE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <span className="help">강건 최적화는 평균뿐 아니라 산포가 작은 레시피를 함께 찾습니다. 공정 레시피 개발에 권장합니다.</span>
              </label>
              {settings.mode === "robust" && (
                <label className="field"><span className="lbl">강건 기준</span>
                  <select value={settings.robust_objective} onChange={(e) => setSettings({ ...settings, robust_objective: e.target.value as typeof settings.robust_objective })}>
                    {Object.entries(OBJ_LABEL).map(([k, v]) => <option key={k} value={k} disabled={k === "spec_prob" && !primaryHasSpec}>{v}{k === "spec_prob" && !primaryHasSpec ? " (규격 필요)" : ""}</option>)}
                  </select>
                  {settings.robust_objective === "mean_k_sigma" && (
                    <span className="row" style={{ marginTop: 6 }}>k = <input type="number" step={0.5} min={0} max={6} style={{ width: 90 }} value={settings.k_sigma}
                      onChange={(e) => setSettings({ ...settings, k_sigma: Number(e.target.value) })} /></span>
                  )}
                </label>
              )}
            </div>
            <div className="grid-3">
              <label className="field"><span className="lbl">한 번에 제안받을 실험 수</span>
                <input type="number" min={1} max={24} value={settings.batch_size} onChange={(e) => setSettings({ ...settings, batch_size: Number(e.target.value) })} />
                <span className="help">하루나 한 주에 진행할 수 있는 실험 수로 정하세요.</span>
              </label>
              <label className="field"><span className="lbl">전체 실험 예산 (런 수)</span>
                <input type="number" min={1} value={settings.budget_runs} onChange={(e) => setSettings({ ...settings, budget_runs: Number(e.target.value) })} />
              </label>
              <label className="field"><span className="lbl">초기 실험점 수</span>
                <input type="number" min={2} value={initPts} onChange={(e) => setSettings({ ...settings, initial_points: Number(e.target.value) })} />
                {initPts < recInit && <span className="field-error">인자 {d}개에는 {recInit}개 이상을 권장합니다. 적으면 첫 예측이 부정확합니다.</span>}
              </label>
            </div>
            <div className="grid-3">
              <label className="field"><span className="lbl">반복 측정할 실험점 비율</span>
                <select value={settings.replicate_fraction} onChange={(e) => setSettings({ ...settings, replicate_fraction: Number(e.target.value) })}>
                  {[0, 0.15, 0.25, 0.34, 0.5].map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}
                </select>
                <span className="help">같은 조건을 반복해야 산포를 추정할 수 있습니다.</span>
              </label>
              <label className="field"><span className="lbl">반복 횟수</span>
                <select value={settings.replicates_per_point} onChange={(e) => setSettings({ ...settings, replicates_per_point: Number(e.target.value) })}>
                  {[2, 3, 4, 5].map((v) => <option key={v} value={v}>{v}회</option>)}
                </select>
              </label>
              <label className="field"><span className="lbl">예측 모델</span>
                <select value={settings.default_surrogate} onChange={(e) => setSettings({ ...settings, default_surrogate: e.target.value as typeof settings.default_surrogate })}>
                  {surrogates.map((s) => <option key={s.name} value={s.name} disabled={!s.available}>{s.label}{s.experimental ? " (실험적)" : " (기본)"}{!s.available ? " — 사용 불가" : ""}</option>)}
                </select>
                <span className="help">잘 모르겠다면 기본값(Gaussian Process)을 쓰세요.</span>
              </label>
            </div>
            {settings.replicate_fraction === 0 && <div className="notice warn">반복 측정이 없으면 산포를 추정할 수 없어 강건한 레시피를 찾기 어렵습니다.</div>}
            <div className="notice info">초기 실험은 <b>&nbsp;{initPts}개 조건, 총 {initRuns}회</b>입니다 (반복 {repPts}개 조건 × {settings.replicates_per_point}회 포함).</div>
          </div>
        )}

        {step === 4 && (
          <div className="stack">
            <h3>{name}</h3>
            {desc && <p className="muted">{desc}</p>}
            <div className="table-wrap"><table>
              <thead><tr><th>인자</th><th className="r">범위</th><th className="r">세팅 정밀도</th></tr></thead>
              <tbody>{factors.map((f) => <tr key={f.key}><td>{f.name}</td><td className="r">{f.low} ~ {f.high} {f.unit}</td><td className="r">{f.step} {f.unit}</td></tr>)}</tbody>
            </table></div>
            <div className="table-wrap"><table>
              <thead><tr><th>응답</th><th>목표</th><th className="r">규격</th></tr></thead>
              <tbody>{responses.map((r) => <tr key={r.key}><td>{r.name} {(settings.primary_response ?? responses[0].key) === r.key && <span className="chip mean">주 응답</span>}</td>
                <td>{GOAL_LABEL[r.goal]}{r.goal === "target" ? ` · ${r.target}${r.unit}` : ""}</td>
                <td className="r">{r.lsl || "–"} ~ {r.usl || "–"} {r.unit}</td></tr>)}</tbody>
            </table></div>
            <p className="small">{MODE_LABEL[settings.mode]}{settings.mode === "robust" ? ` · ${OBJ_LABEL[settings.robust_objective]}` : ""} · 한 번에 {settings.batch_size}개 제안 · 예산 {settings.budget_runs}회</p>
            {editing && (
              <label className="field"><span className="lbl">변경 사유</span>
                <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 규격 변경 (고객 요청)" />
                <span className="help">변경 이력에 남습니다.</span>
              </label>
            )}
          </div>
        )}
      </div>

      <div className="row end" style={{ marginTop: 16 }}>
        {step > 0 && <button onClick={() => setStep(step - 1)}>이전</button>}
        {step < STEPS.length - 1 && <button className="primary" onClick={next}>다음</button>}
        {step === STEPS.length - 1 && <button className="primary" disabled={saving} onClick={save}>{saving ? "저장 중" : editing ? "설정 저장" : "DOE 만들기"}</button>}
      </div>
    </div>
  );
}
