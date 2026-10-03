import { Link, useNavigate } from "react-router-dom";
import { post } from "../api";
import { useAuth } from "../auth";
import { usePrefs } from "../prefs";

export function Brand({ sub = true }: { sub?: boolean }) {
  return (
    <Link to="/" className="brand" aria-label="DDS ReDO 홈">
      <span className="dds">DDS</span>
      <span className="redo">Re<b>DO</b></span>
      {sub && <span className="sub">공정 레시피 최적화</span>}
    </Link>
  );
}

export function TopBar() {
  const { user, refresh } = useAuth();
  const { expert, setExpert } = usePrefs();
  const nav = useNavigate();
  return (
    <header className="topbar">
      <Brand />
      <div className="spacer" />
      <label className="mode-toggle" title="전문가 모드에서는 모델 설정, 검증 지표, 모델 비교를 볼 수 있습니다.">
        <input type="checkbox" checked={expert} onChange={(e) => setExpert(e.target.checked)} />
        전문가 모드
      </label>
      {user && (
        <div className="who">
          {user.name}
          <small>{user.department} · {user.business_unit}</small>
        </div>
      )}
      <button className="ghost small" onClick={async () => { await post("/api/auth/logout").catch(() => {}); await refresh(); nav("/login"); }}>
        로그아웃
      </button>
    </header>
  );
}
