import { useEffect, useState } from "react";
import { del, get, post } from "../api";
import { Modal } from "../components/Modal";
import { TargetPicker, type Target } from "../components/UserPicker";
import { ROLE_LABEL, when } from "../format";
import { useProject } from "../project";
import { useToast } from "../toast";
import type { Member, Share, Surrogate } from "../types";

function ShareDialog({ onClose, onDone, preset }: { onClose: () => void; onDone: () => void; preset?: Target | null }) {
  const { project } = useProject();
  const toast = useToast();
  const cfg = project.config;
  const [kind, setKind] = useState<"user" | "org" | "company">(preset?.type === "user" ? "user" : "user");
  const [target, setTarget] = useState<Target | null>(preset ?? null);
  const [perm, setPerm] = useState<"view" | "view_simulate">("view_simulate");
  const [mode, setMode] = useState<"snapshot" | "live">("snapshot");
  const [raw, setRaw] = useState(false);
  const [expires, setExpires] = useState("");
  const [sur, setSur] = useState<Surrogate>(cfg.settings.default_surrogate);
  const [rk, setRk] = useState(cfg.settings.primary_response ?? cfg.responses[0].key);
  const [busy, setBusy] = useState(false);
  const t: Target | null = kind === "company" ? { type: "company", id: null, label: "전사" } : target;
  const save = async () => {
    if (!t) return;
    setBusy(true);
    try {
      await post(`/api/projects/${project.id}/shares`, {
        target_type: t.type, target_id: t.id, permission: perm, mode, include_raw: raw, response_key: rk, surrogate: sur,
        expires_at: expires ? new Date(expires).toISOString() : null,
      });
      toast(`${t.label}에 공유했습니다.`);
      onDone(); onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <Modal title="최적화 예측 페이지 공유" onClose={onClose} footer={<>
      <button onClick={onClose}>취소</button>
      <button className="primary" disabled={!t || busy} onClick={save}>{busy ? "만드는 중" : "공유하기"}</button>
    </>}>
      <div className="stack">
        <div>
          <span className="seg" role="tablist">
            <button className={kind === "user" ? "on" : ""} onClick={() => { setKind("user"); setTarget(null); }}>사람</button>
            <button className={kind === "org" ? "on" : ""} onClick={() => { setKind("org"); setTarget(null); }}>부서·사업부</button>
            <button className={kind === "company" ? "on" : ""} onClick={() => setKind("company")}>전사</button>
          </span>
          <div style={{ marginTop: 10 }}>
            {kind === "company" ? <div className="notice warn">회사의 모든 임직원이 로그인 후 볼 수 있습니다. 기밀 여부를 확인하세요.</div>
              : <TargetPicker kinds={kind === "user" ? ["user"] : ["org"]} value={target} onChange={setTarget} />}
          </div>
        </div>
        <div className="grid-2">
          <label className="field"><span className="lbl">공유 방식</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="snapshot">스냅샷 — 지금 결과로 고정 (보고·의사결정용)</option>
              <option value="live">실시간 — 실험이 추가되면 바뀜</option>
            </select></label>
          <label className="field"><span className="lbl">권한</span>
            <select value={perm} onChange={(e) => setPerm(e.target.value as typeof perm)}>
              <option value="view_simulate">보기 + 조건 시뮬레이션</option>
              <option value="view">보기만</option>
            </select></label>
          {cfg.responses.length > 1 && (
            <label className="field"><span className="lbl">응답</span>
              <select value={rk} onChange={(e) => setRk(e.target.value)}>{cfg.responses.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></label>
          )}
          <label className="field"><span className="lbl">예측 모델</span>
            <select value={sur} onChange={(e) => setSur(e.target.value as Surrogate)}>
              <option value="gp">Gaussian Process</option><option value="tabpfn">TabPFN (평가용 표시됨)</option>
            </select></label>
          <label className="field"><span className="lbl">만료일 (선택)</span>
            <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />원본 실험 데이터도 함께 보여주기 (기본: 예측 결과만)</label>
      </div>
    </Modal>
  );
}

function AddMemberDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (m: Member[]) => void }) {
  const { project } = useProject();
  const toast = useToast();
  const [who, setWho] = useState<Target | null>(null);
  const [role, setRole] = useState<"editor" | "runner" | "viewer">("runner");
  const add = async () => {
    if (!who || who.type !== "user") return;
    try {
      onAdded(await post<Member[]>(`/api/projects/${project.id}/members`, { user_id: who.id, role }));
      toast(`${who.label}: ${ROLE_LABEL[role]} 권한으로 추가했습니다.`);
      onClose();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <Modal title="멤버 추가" onClose={onClose} footer={<>
      <button onClick={onClose}>취소</button>
      <button className="primary" disabled={!who} onClick={add}>추가</button>
    </>}>
      <div className="stack">
        <TargetPicker kinds={["user"]} value={who} onChange={setWho} />
        <label className="field"><span className="lbl">권한</span>
          <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="runner">실험자 — 결과 입력</option>
            <option value="editor">편집자 — 설정 변경·다음 실험 확정까지</option>
            <option value="viewer">열람자 — 보기만</option>
          </select></label>
      </div>
    </Modal>
  );
}

function TransferDialog({ onClose }: { onClose: () => void }) {
  const { project, reload } = useProject();
  const toast = useToast();
  const [who, setWho] = useState<Target | null>(null);
  const go = async () => {
    if (!who) return;
    try {
      await post(`/api/projects/${project.id}/transfer`, { new_owner_id: who.id });
      toast("소유권을 이전했습니다. 나는 편집자로 남습니다.");
      await reload();
      onClose();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <Modal title="소유권 이전" onClose={onClose} footer={<>
      <button onClick={onClose}>취소</button>
      <button className="danger" disabled={!who} onClick={go}>소유권 넘기기</button>
    </>}>
      <p className="small muted" style={{ marginBottom: 10 }}>담당이 바뀌면 다른 사람에게 이 DOE를 넘기세요. 넘긴 뒤 나는 편집자로 남습니다.</p>
      <TargetPicker kinds={["user"]} value={who} onChange={setWho} />
    </Modal>
  );
}

type AccessRequest = { user_id: number; user: string; department: string | null; message: string; at: string };

/** 멤버·공유 창 (사이드바 DOE의 ⋯ 메뉴/우클릭): 멤버 조회·권한 변경, 예측 공유. 추가·공유는 위에 뜨는 모달에서. */
export default function MembersShare() {
  const { project } = useProject();
  const toast = useToast();
  const owner = project.my_role === "owner";
  const [members, setMembers] = useState<Member[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [adding, setAdding] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const [dialog, setDialog] = useState<{ preset?: Target | null } | null>(null);
  const [views, setViews] = useState<{ share: Share; rows: { user: string; department: string | null; viewed_at: string }[] } | null>(null);
  const load = async () => {
    setMembers(await get<Member[]>(`/api/projects/${project.id}/members`));
    if (owner) {
      setShares(await get<Share[]>(`/api/projects/${project.id}/shares`));
      setRequests(await get<AccessRequest[]>(`/api/projects/${project.id}/access-requests`).catch(() => []));
    }
  };
  useEffect(() => { void load(); }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async (s: Share) => {
    const url = `${window.location.origin}/shared/${s.token}`;
    try { await navigator.clipboard.writeText(url); toast("링크를 복사했습니다. 공유 대상만 로그인 후 열 수 있습니다."); }
    catch { window.prompt("링크를 복사하세요", url); }
  };
  const active = shares.filter((s) => !s.revoked_at);

  return (
    <div className="stack">
      <section>
        <div className="panel-head">
          <h3>멤버 {members.length}명</h3>
          {owner && <button className="small primary" onClick={() => setAdding(true)}>+ 멤버 추가</button>}
        </div>
        <p className="small muted" style={{ marginBottom: 8 }}>실험자는 결과 입력, 편집자는 설정 변경과 다음 실험 확정까지, 열람자는 보기만 할 수 있습니다.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>이름</th><th>소속</th><th>권한</th><th /></tr></thead>
          <tbody>{members.map((m) => (
            <tr key={m.user.id}>
              <td>{m.user.name}</td><td className="muted small">{m.user.department} · {m.user.business_unit}</td>
              <td>{m.role === "owner" ? <span className="chip">소유자</span> : owner ? (
                <select value={m.role} style={{ width: "auto" }} aria-label={`${m.user.name} 권한`}
                  onChange={async (e) => { setMembers(await post<Member[]>(`/api/projects/${project.id}/members`, { user_id: m.user.id, role: e.target.value })); toast("권한을 바꿨습니다."); }}>
                  {["editor", "runner", "viewer"].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>) : ROLE_LABEL[m.role]}</td>
              <td className="r">{owner && m.role !== "owner" && (
                <button className="ghost small" onClick={async () => setMembers(await del<Member[]>(`/api/projects/${project.id}/members/${m.user.id}`))}>내보내기</button>)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>

      {owner && (
        <section>
          <div className="panel-head">
            <h3>예측 공유 {active.length}건</h3>
            <button className="small primary" onClick={() => setDialog({})}>+ 새로 공유</button>
          </div>
          <p className="small muted" style={{ marginBottom: 8 }}>공유받은 사람은 로그인 후 추천 레시피와 평균·산포 지도를 봅니다. 원본 데이터는 허용한 경우에만 보입니다.</p>
          {requests.length > 0 && (
            <div className="notice info" style={{ marginBottom: 8 }}>
              <div><b>접근 요청</b>
                <ul>{requests.slice(0, 5).map((r, i) => (
                  <li key={i}>{r.user} ({r.department}) · {when(r.at)}{r.message ? ` · ${r.message}` : ""}{" "}
                    <button className="link-btn small" onClick={() => setDialog({ preset: { type: "user", id: r.user_id, label: r.user } })}>공유하기</button></li>
                ))}</ul>
              </div>
            </div>
          )}
          {active.length === 0 ? <p className="muted small">아직 공유하지 않았습니다.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>대상</th><th>방식</th><th>권한</th><th>만료</th><th className="r">열람</th><th /></tr></thead>
              <tbody>{active.map((s) => (
                <tr key={s.id}>
                  <td>{s.target_label}</td>
                  <td>{s.mode === "snapshot" ? "스냅샷" : "실시간"}{s.surrogate === "tabpfn" && <span className="chip exp" style={{ marginLeft: 4 }}>TabPFN</span>}
                    {s.include_raw && <span className="chip warn" style={{ marginLeft: 4 }}>원본 포함</span>}</td>
                  <td>{s.permission === "view_simulate" ? "보기+시뮬레이션" : "보기"}</td>
                  <td>{s.expires_at ? new Date(s.expires_at).toLocaleDateString("ko-KR") : "없음"}</td>
                  <td className="r"><button className="link-btn" onClick={async () => setViews({ share: s, rows: await get(`/api/projects/${project.id}/shares/${s.id}/views`) })}>{s.view_count}회</button></td>
                  <td className="r"><div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                    <button className="small" onClick={() => copy(s)}>링크 복사</button>
                    <button className="small danger" onClick={async () => { await del(`/api/projects/${project.id}/shares/${s.id}`); toast("공유를 철회했습니다."); void load(); }}>철회</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <p style={{ marginTop: 14 }}><button className="link-btn small" onClick={() => setTransfer(true)}>소유권을 다른 사람에게 넘기기…</button></p>
        </section>
      )}

      {adding && <AddMemberDialog onClose={() => setAdding(false)} onAdded={setMembers} />}
      {transfer && <TransferDialog onClose={() => setTransfer(false)} />}
      {dialog && <ShareDialog preset={dialog.preset} onClose={() => setDialog(null)} onDone={load} />}
      {views && (
        <Modal title={`열람 기록 · ${views.share.target_label}`} onClose={() => setViews(null)}>
          {views.rows.length === 0 ? <p className="muted">아직 열람한 사람이 없습니다.</p> : (
            <div className="table-wrap"><table><tbody>{views.rows.map((v, i) => <tr key={i}><td>{v.user}</td><td className="muted">{v.department}</td><td>{when(v.viewed_at)}</td></tr>)}</tbody></table></div>
          )}
        </Modal>
      )}
    </div>
  );
}
