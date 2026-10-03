import { useEffect, useState } from "react";
import { get } from "../api";
import type { User } from "../types";

export type Target =
  | { type: "user"; id: number; label: string }
  | { type: "department"; id: number; label: string }
  | { type: "business_unit"; id: number; label: string }
  | { type: "company"; id: null; label: string };

type Org = { type: "department" | "business_unit"; id: number; name: string };

/** 사람 또는 부서·사업부 검색 */
export function TargetPicker({ kinds, value, onChange }: {
  kinds: ("user" | "org")[]; value: Target | null; onChange: (t: Target | null) => void;
}) {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const wantUser = kinds.includes("user"), wantOrg = kinds.includes("org");
  useEffect(() => {
    const t = setTimeout(async () => {
      if (wantUser) setUsers(await get<User[]>(`/api/users/search?q=${encodeURIComponent(q)}`).catch(() => []));
      if (wantOrg) setOrgs(await get<Org[]>(`/api/org-units?q=${encodeURIComponent(q)}`).catch(() => []));
    }, 200);
    return () => clearTimeout(t);
  }, [q, wantUser, wantOrg]);
  if (value) {
    return (
      <div className="row">
        <span className="chip mean">{value.label}</span>
        <button className="small ghost" onClick={() => onChange(null)}>바꾸기</button>
      </div>
    );
  }
  return (
    <div>
      <input type="search" placeholder={wantOrg && wantUser ? "이름, 사번, 부서, 사업부 검색" : wantOrg ? "부서·사업부 검색" : "이름 또는 사번 검색"}
        value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="table-wrap" style={{ maxHeight: 220, overflowY: "auto", marginTop: 6 }}>
        <table><tbody>
          {wantUser && users.map((u) => (
            <tr key={`u${u.id}`} className="clickable" onClick={() => onChange({ type: "user", id: u.id, label: `${u.name} (${u.department ?? ""})` })}>
              <td>{u.name}</td><td className="muted">{u.user_key}</td><td className="muted">{u.department} · {u.business_unit}</td>
            </tr>
          ))}
          {wantOrg && orgs.map((o) => (
            <tr key={`${o.type}${o.id}`} className="clickable" onClick={() => onChange({ type: o.type, id: o.id, label: o.name })}>
              <td colSpan={2}>{o.name}</td><td className="muted">{o.type === "department" ? "부서 전체" : "사업부 전체"}</td>
            </tr>
          ))}
          {users.length === 0 && orgs.length === 0 && <tr><td className="muted">검색 결과가 없습니다.</td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}
