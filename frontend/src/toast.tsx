import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface Toast { id: number; text: string; err?: boolean; }
const Ctx = createContext<(text: string, err?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, err = false) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, err }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), err ? 6000 : 3200);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.err ? "err" : ""}`}>{t.text}</div>)}
      </div>
    </Ctx.Provider>
  );
}
export const useToast = () => useContext(Ctx);
