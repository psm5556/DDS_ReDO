import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { get, post } from "../api";
import { useAuth } from "../auth";
import { Brand } from "../components/TopBar";
import type { User } from "../types";

/** 로그인. 사내 로그인 연계(corporate) 시에는 사내 로그인 페이지로 이동하고,
 *  개발 환경(mock)에서만 사용자 선택 화면을 보여준다 (CLAUDE.md 8.1절). */
export default function LoginPage() {
  const [params] = useSearchParams();
  const returnTo = params.get("return_to") || "/";
  const safeReturn = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (user) nav(safeReturn, { replace: true }); }, [user]);
  useEffect(() => {
    get<{ auth_mode: string }>("/api/auth/config").then(async (c) => {
      setMode(c.auth_mode);
      if (c.auth_mode === "mock") setUsers(await get<User[]>("/api/auth/mock-users"));
      else {
        const r = await get<{ url: string }>(`/api/auth/login-url?return_to=${encodeURIComponent(safeReturn)}`);
        if (r.url) window.location.assign(r.url);
      }
    }).catch((e: Error) => setErr(e.message));
  }, []);

  const login = async (u: User) => {
    try {
      await post("/api/auth/mock-login", { user_key: u.user_key });
      await refresh();
      nav(safeReturn, { replace: true });
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="login-wrap">
      <div className="login-side">
        <Brand />
        <div>
          <h1 style={{ color: "#fff", marginBottom: 12 }}>적은 실험으로, 흔들리지 않는 레시피를.</h1>
          <p>실험 결과를 입력하면 다음에 해볼 조건을 제안합니다. 평균뿐 아니라 산포까지 예측해서, 양산에서도 재현되는 공정 레시피를 찾도록 돕습니다.</p>
        </div>
        <p className="small" style={{ fontSize: 12 }}>DDS 플랫폼 · ReDO (Recipe Design Optimization)</p>
      </div>
      <div className="login-main">
        {mode === null && !err && <div className="busy"><span className="spinner" /> 로그인 방식을 확인하는 중</div>}
        {err && <div className="notice err">{err}</div>}
        {mode === "corporate" && !err && <div className="busy"><span className="spinner" /> 사내 로그인 페이지로 이동하는 중</div>}
        {mode === "mock" && (
          <>
            <h2>개발용 로그인</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              이 화면은 개발 환경 전용입니다. 운영에서는 사내 로그인 페이지로 연결됩니다. 사용할 계정을 고르세요.
            </p>
            <div className="user-pick">
              {users.map((u) => (
                <button key={u.id} onClick={() => login(u)}>
                  <span>{u.name} <small>{u.user_key}</small></span>
                  <small>{u.department} · {u.business_unit}{u.system_role !== "user" ? ` · ${u.system_role === "admin" ? "시스템관리자" : "사업부 관리자"}` : ""}</small>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
