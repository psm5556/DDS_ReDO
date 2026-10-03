import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { del, get, post } from "../api";
import { Confirm } from "../components/Modal";
import { fmtFactor, PROJECT_STATUS, ROLE_LABEL, STATUS_LABEL, when } from "../format";
import { useToast } from "../toast";
import type { OpenRun, ProjectSummary, Share } from "../types";

type Tab = "mine" | "member" | "shared" | "trash";

function Progress({ p }: { p: ProjectSummary }) {
  const total = Math.max(p.runs_total, 1);
  return (
    <div>
      <div className="progress" aria-label={`완료 ${p.runs_done} / 전체 ${p.runs_total}`}>
        <span className="d" style={{ width: `${(p.runs_done / total) * 100}%` }} />
        <span className="o" style={{ width: `${(p.runs_open / total) * 100}%` }} />
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>
        {p.runs_total === 0 ? "아직 실험 계획 없음" : `완료 ${p.runs_done} · 남음 ${p.runs_open} · ${p.batches}차 배치`}
      </div>
    </div>
  );
}

function TodayPanel() {
  const [items, setItems] = useState<OpenRun[] | null>(null);
  useEffect(() => { get<OpenRun[]>("/api/me/open-runs").then(setItems).catch(() => setItems([])); }, []);
  if (!items || items.length === 0) return null;
  const byProject = new Map<number, OpenRun[]>();
  for (const it of items) byProject.set(it.project_id, [...(byProject.get(it.project_id) ?? []), it]);
  return (
    <section className="today" style={{ marginBottom: 24 }}>
      <div className="today-head">
        <h3>결과 입력을 기다리는 실험</h3>
        <span className="muted small">{items.length}건</span>
      </div>
      <div className="table-wrap" style={{ border: "none", borderRadius: 0 }}>
        <table>
          <thead><tr><th>프로젝트</th><th>런</th><th>조건</th><th>상태</th><th /></tr></thead>
          <tbody>
            {[...byProject.values()].flatMap((runs) => runs.slice(0, 4).map((it, i) => (
              <tr key={it.run.id}>
                <td>{i === 0 ? <Link to={`/projects/${it.project_id}/results`}>{it.project_name}</Link> : ""}</td>
                <td className="num">{it.run.code}</td>
                <td className="small">{it.factors.map((f) => `${f.name} ${fmtFactor(it.run.planned[f.key], f)}${f.unit}`).join(" · ")}</td>
                <td><span className={`chip status-${it.run.status}`}>{STATUS_LABEL[it.run.status]}</span></td>
                <td className="r"><Link className="btn small" to={`/projects/${it.project_id}/runs/${it.run.id}`}>입력</Link></td>
              </tr>
            )).concat(runs.length > 4 ? [
              <tr key={`more${runs[0].project_id}`}><td /><td colSpan={4} className="small">
                <Link to={`/projects/${runs[0].project_id}/results`}>외 {runs.length - 4}건 더 보기</Link></td></tr>] : []))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function DashboardPage() {
  const [tab, setTab] = useState<Tab>("mine");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [confirmDel, setConfirmDel] = useState<ProjectSummary | null>(null);
  const toast = useToast();
  const nav = useNavigate();

  const load = async () => {
    if (tab === "shared") {
      setShares(await get<Share[]>("/api/shares/received"));
      return;
    }
    setItems(null);
    const qs = new URLSearchParams({ scope: tab, q, status });
    setItems(await get<ProjectSummary[]>(`/api/projects?${qs}`));
  };
  useEffect(() => { const t = setTimeout(() => void load().catch((e) => toast(e.message, true)), 150); return () => clearTimeout(t); }, [tab, q, status]);

  const duplicate = async (p: ProjectSummary) => {
    const n = await post<ProjectSummary>(`/api/projects/${p.id}/duplicate`);
    toast("복제했습니다. 인자·응답 설정만 복사되었습니다.");
    nav(`/projects/${n.id}`);
  };
  const restore = async (p: ProjectSummary) => {
    await post(`/api/projects/${p.id}/restore`);
    toast("복구했습니다.");
    void load();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>내 DOE</h1>
          <p>공정 레시피 개발 실험을 계획하고, 결과를 입력하고, 다음 실험을 제안받습니다.</p>
        </div>
        <Link className="btn primary big" to="/new">새 DOE 만들기</Link>
      </div>

      <TodayPanel />

      <div className="tabs" role="tablist">
        {([["mine", "내가 만든 DOE"], ["member", "함께하는 DOE"], ["shared", "공유받은 예측"], ["trash", "휴지통"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab !== "shared" && (
        <div className="row" style={{ marginBottom: 12 }}>
          <input type="search" placeholder="이름이나 설명으로 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
          {tab !== "trash" && (
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 160 }} aria-label="상태 필터">
              <option value="">모든 상태</option>
              {Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          )}
        </div>
      )}

      {tab === "shared" ? (
        shares === null ? <div className="busy"><span className="spinner" /> 불러오는 중</div> :
        shares.length === 0 ? (
          <div className="panel empty"><h3>공유받은 예측이 없습니다</h3><p>다른 사람이 최적화 예측 페이지를 공유하면 여기에 표시됩니다.</p></div>
        ) : (
          <div className="proj-list">
            {shares.map((s) => (
              <div className="proj-item" key={s.id}>
                <div>
                  <h4><Link to={`/shared/${s.token}`}>{s.project_name}</Link></h4>
                  <div className="meta">{s.created_by}님이 공유 · {when(s.created_at)} · 대상: {s.target_label}</div>
                </div>
                <div><span className="chip">{s.mode === "snapshot" ? "스냅샷" : "실시간"}</span>{" "}
                  {s.surrogate === "tabpfn" && <span className="chip exp">TabPFN 평가용</span>}</div>
                <div className="small muted">{s.permission === "view_simulate" ? "조건 시뮬레이션 가능" : "읽기 전용"}</div>
                <Link className="btn small" to={`/shared/${s.token}`}>열기</Link>
              </div>
            ))}
          </div>
        )
      ) : items === null ? <div className="busy"><span className="spinner" /> 불러오는 중</div> :
        items.length === 0 ? (
          <div className="panel empty">
            {tab === "mine" && <><h3>아직 만든 DOE가 없습니다</h3><p>인자와 응답, 목표만 정하면 첫 실험 계획을 만들어 드립니다.</p><Link className="btn primary" to="/new">새 DOE 만들기</Link></>}
            {tab === "member" && <><h3>초대받은 DOE가 없습니다</h3><p>다른 사람이 실험자나 편집자로 초대하면 여기에 표시됩니다.</p></>}
            {tab === "trash" && <><h3>휴지통이 비어 있습니다</h3><p>삭제한 DOE는 30일 동안 여기서 복구할 수 있습니다.</p></>}
          </div>
        ) : (
          <div className="proj-list">
            {items.map((p) => (
              <div className="proj-item" key={p.id}>
                <div>
                  <h4>{tab === "trash" ? p.name : <Link to={`/projects/${p.id}`}>{p.name}</Link>}</h4>
                  <div className="meta">
                    {tab === "member" && <>{p.owner.name} ({p.owner.department}) · </>}
                    {ROLE_LABEL[p.my_role]} · {PROJECT_STATUS[p.status]} · {when(tab === "trash" ? p.deleted_at : p.updated_at)} {tab === "trash" ? "삭제" : "수정"}
                    {p.tags.length > 0 && <> · {p.tags.join(", ")}</>}
                  </div>
                </div>
                <Progress p={p} />
                <div className="small muted">{p.description ? p.description.slice(0, 60) + (p.description.length > 60 ? "…" : "") : ""}</div>
                <div className="row">
                  {tab === "trash" ? <button className="small" onClick={() => void restore(p)}>복구</button> : (
                    <>
                      <button className="small ghost" onClick={() => void duplicate(p)}>복제</button>
                      {p.my_role === "owner" && <button className="small ghost" onClick={() => setConfirmDel(p)}>삭제</button>}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      {confirmDel && (
        <Confirm title="DOE 삭제" danger confirmLabel="휴지통으로 이동" onClose={() => setConfirmDel(null)}
          message={<>“{confirmDel.name}”을 휴지통으로 옮깁니다. 30일 동안 복구할 수 있으며, 그동안 멤버와 공유 대상은 접근할 수 없습니다.</>}
          onConfirm={async () => { await del(`/api/projects/${confirmDel.id}`); toast("휴지통으로 옮겼습니다."); void load(); }} />
      )}
    </div>
  );
}
