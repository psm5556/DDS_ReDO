import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { del, get, patch, post } from "../api";
import { Confirm } from "../components/Modal";
import { PROJECT_STATUS, when } from "../format";
import { usePrefs } from "../prefs";
import { useProject } from "../project";
import { useToast } from "../toast";
import type { ProjectDetail } from "../types";

const ACTION: Record<string, string> = {
  "project.create": "DOE 생성", "project.update": "설정 변경", "project.duplicate": "복제", "project.delete": "삭제", "project.restore": "복구",
  "project.transfer": "소유권 이전", "member.set": "멤버 권한 변경", "member.remove": "멤버 제외", "batch.create": "배치 생성",
  "batch.cancel": "배치 취소", "results.save": "결과 저장", "measurement.exclude": "측정값 제외", "measurement.include": "측정값 복원",
  "share.create": "공유", "share.revoke": "공유 철회", "share.access_request": "접근 요청", "model.compare": "모델 비교",
};

export default function SettingsSection() {
  const { project, reload } = useProject();
  const { expert } = usePrefs();
  const toast = useToast();
  const nav = useNavigate();
  const [confirmDel, setConfirmDel] = useState(false);
  const [log, setLog] = useState<{ action: string; user: string | null; detail: Record<string, unknown>; at: string }[]>([]);
  useEffect(() => { get<typeof log>(`/api/projects/${project.id}/audit`).then(setLog).catch(() => {}); }, [project.id]);
  const setStatus = async (s: string) => { await patch(`/api/projects/${project.id}`, { status: s }); await reload(); toast("상태를 바꿨습니다."); };
  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head"><h3>설정</h3></div>
        <div className="row">
          <Link className="btn primary" to={`/projects/${project.id}/edit`}>인자·응답·목표 수정</Link>
          <label className="row small" style={{ gap: 6 }}>상태
            <select value={project.status} onChange={(e) => void setStatus(e.target.value)} style={{ width: "auto" }}>
              {Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          <button onClick={async () => { const n = await post<ProjectDetail>(`/api/projects/${project.id}/duplicate`); toast("복제했습니다."); nav(`/projects/${n.id}`); }}>새 DOE로 복제</button>
          {project.my_role === "owner" && <button className="danger" onClick={() => setConfirmDel(true)}>삭제</button>}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head"><h3>변경 이력</h3><span className="hint">최근 200건</span></div>
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}><table>
          <tbody>{log.map((l, i) => (
            <tr key={i}><td style={{ whiteSpace: "nowrap" }}>{when(l.at)}</td><td>{l.user}</td><td>{ACTION[l.action] ?? l.action}</td>
              <td className="small muted">{expert ? JSON.stringify(l.detail) : (l.detail.reason as string) || ""}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
      {confirmDel && <Confirm title="DOE 삭제" danger confirmLabel="휴지통으로 이동" onClose={() => setConfirmDel(false)}
        message="휴지통으로 옮깁니다. 30일 동안 ‘내 DOE > 휴지통’에서 복구할 수 있습니다. 그동안 멤버와 공유 대상은 접근할 수 없습니다."
        onConfirm={async () => { await del(`/api/projects/${project.id}`); toast("휴지통으로 옮겼습니다."); nav("/"); }} />}
    </div>
  );
}
