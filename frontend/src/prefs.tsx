import { createContext, useContext, useState, type ReactNode } from "react";

interface Prefs { expert: boolean; setExpert: (v: boolean) => void; }
const Ctx = createContext<Prefs>({ expert: false, setExpert: () => {} });

function load(): boolean {
  try { return localStorage.getItem("redo.expert") === "1"; } catch { return false; }
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [expert, setE] = useState(load);
  const setExpert = (v: boolean) => {
    setE(v);
    try { localStorage.setItem("redo.expert", v ? "1" : "0"); } catch { /* 저장 불가 환경 */ }
  };
  return <Ctx.Provider value={{ expert, setExpert }}>{children}</Ctx.Provider>;
}
export const usePrefs = () => useContext(Ctx);
