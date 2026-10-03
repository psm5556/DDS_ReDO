import { LogOut, User } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { post } from "../api";
import { useAuth } from "../auth";

export function Brand({ sub = true }: { sub?: boolean }) {
  return (
    <Link to="/" className="brand" aria-label="DDS ReDO 홈">
      <span className="logo" aria-hidden="true">Re</span>
      <span className="redo">DDS Re<b>DO</b></span>
      {sub && <span className="sub">공정 레시피 최적화</span>}
    </Link>
  );
}

export function TopBar() {
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  return (
    <header className="topbar">
      <Brand />
      <div className="spacer" />
      {user && (
        <div className="who">
          <span className="avatar" aria-hidden="true"><User size={14} /></span>
          <span className="name">{user.name}<small>{user.department} · {user.business_unit}</small></span>
          <button className="icon-btn danger" title="로그아웃" aria-label="로그아웃"
            onClick={async () => { await post("/api/auth/logout").catch(() => {}); await refresh(); nav("/login"); }}>
            <LogOut size={15} />
          </button>
        </div>
      )}
    </header>
  );
}
