import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, get, post } from "../api";
import { RunCard, type RowPatch } from "../components/RunCard";
import { can } from "../project";
import { useToast } from "../toast";
import type { ProjectDetail, Run } from "../types";

const isOpen = (r: Run) => r.status === "planned" || r.status === "running";

/** QR 스캔으로 들어오는 런 1건 입력 화면 (CLAUDE.md 7.2절, 태블릿 기준) */
export default function RunEntryPage() {
  const { pid, rid } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [siblings, setSiblings] = useState<Run[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [justSaved, setJustSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    setJustSaved(false);
    setWarnings([]);
    try {
      const [p, r] = await Promise.all([
        get<ProjectDetail>(`/api/projects/${pid}`),
        get<Run>(`/api/projects/${pid}/runs/${rid}`),
      ]);
      setProject(p);
      setRun(r);
      setSiblings(await get<Run[]>(`/api/projects/${pid}/runs?batch_id=${r.batch_id}`));
    } catch (e) {
      const status = (e as ApiError).status;
      setErr(status === 404 || status === 403 ? "이 런을 찾을 수 없거나 접근 권한이 없습니다." : (e as Error).message);
    }
  }, [pid, rid]);
  useEffect(() => { void load(); }, [load]);

  // 같은 배치에서 실행 순서상 다음 미완료 런 (끝까지 가면 처음부터 다시 찾음)
  const next = useMemo(() => {
    if (!run) return null;
    const open = siblings.filter((r) => r.id !== run.id && isOpen(r)).sort((a, b) => a.run_order - b.run_order);
    return open.find((r) => r.run_order > run.run_order) ?? open[0] ?? null;
  }, [run, siblings]);
  const done = siblings.filter((r) => !isOpen(r)).length;

  const onSave = async (patch: RowPatch) => {
    try {
      const res = await post<{ saved: number; warnings: Record<string, string[]>; runs: Run[] }>(
        `/api/projects/${pid}/results`, { rows: [patch] });
      const saved = res.runs.find((r) => r.id === patch.run_id);
      if (saved) {
        setRun(saved);
        setSiblings((xs) => xs.map((x) => (x.id === saved.id ? saved : x)));
      }
      setWarnings(res.warnings[String(patch.run_id)] ?? []);
      setJustSaved(true);
      toast(res.saved ? "저장했습니다." : "변경된 내용이 없습니다.");
    } catch (e) {
      const d = (e as ApiError).detail as { errors?: Record<string, string[]> } | null;
      const rowErr = d?.errors?.[String(patch.run_id)];
      toast(rowErr?.length ? rowErr.join(" ") : (e as Error).message, true);
    }
  };

  if (err) return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="notice err">{err}</div>
      <p style={{ marginTop: 12 }}><Link to="/">내 DOE 목록으로</Link></p>
    </div>
  );
  if (!project || !run) return <div className="page"><div className="busy"><span className="spinner" /> 불러오는 중</div></div>;

  const readOnly = !can(project.my_role, "runner");
  const cfg = project.config;
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <div className="grow">
          <p className="small muted"><Link to={`/projects/${project.id}`}>{project.name}</Link></p>
          <h1>결과 입력 · <span className="num">{run.code}</span></h1>
          <p className="small muted">{run.batch_seq}차 배치 진행 {done}/{siblings.length}건 완료</p>
        </div>
      </div>

      {readOnly && <div className="notice info" style={{ marginBottom: 12 }}>열람 권한만 있어 결과를 입력할 수 없습니다.</div>}

      {/* 저장 후 카드 입력 상태를 서버 값으로 초기화하기 위해 updated_at을 key에 포함 */}
      <RunCard key={run.id + run.updated_at} run={run} factors={cfg.factors} responses={cfg.responses}
        onSave={onSave} warnings={warnings} readOnly={readOnly} />

      {justSaved && (
        <div className="notice ok" style={{ marginTop: 12 }}>
          {warnings.length ? "저장했습니다. 위 경고를 확인하고 값이 맞으면 다음으로 넘어가세요." : "저장했습니다."}
        </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        {next ? (
          <button className={`big ${justSaved ? "primary" : ""}`} style={{ flex: 1 }}
            onClick={() => nav(`/projects/${project.id}/runs/${next.id}`)}>
            다음 런 {next.code} (실행 순서 {next.run_order}번) →
          </button>
        ) : (
          <div className="notice ok" style={{ flex: 1 }}>이 배치에 남은 미완료 런이 없습니다.</div>
        )}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <Link className="btn" to={`/projects/${project.id}/step/1`}>남은 실험 모두 보기</Link>
      </div>
    </div>
  );
}
