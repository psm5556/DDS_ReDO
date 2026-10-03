import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { get } from "./api";
import type { User } from "./types";

interface AuthState { user: User | null; loading: boolean; refresh: () => Promise<void>; }
const Ctx = createContext<AuthState>({ user: null, loading: true, refresh: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try {
      setUser(await get<User | null>("/api/auth/me"));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, []);
  return <Ctx.Provider value={{ user, loading, refresh }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="page"><div className="busy"><span className="spinner" /> 불러오는 중</div></div>;
  if (!user) return <Navigate to={`/login?return_to=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}
