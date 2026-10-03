import { useCallback, useEffect, useState } from "react";

/** 사이드바 너비(드래그로 조절)와 접힘 상태. 사람마다 편한 너비가 달라 브라우저에 기억해 둔다(실패해도 기본값으로 동작). */
export const SIDE_MIN = 200;
export const SIDE_MAX = 480;
export const SIDE_DEFAULT = 264;
const KEY = "redo.sidebar";

function load(): { width: number; collapsed: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { width?: number; collapsed?: boolean };
    const w = Number(v.width);
    return { width: Number.isFinite(w) ? Math.min(SIDE_MAX, Math.max(SIDE_MIN, w)) : SIDE_DEFAULT, collapsed: !!v.collapsed };
  } catch {
    return { width: SIDE_DEFAULT, collapsed: false };
  }
}

export function useSideLayout() {
  const [state, setState] = useState(load);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 저장 못 해도 화면은 그대로 */ }
  }, [state]);
  const setWidth = useCallback((w: number) => setState((s) => ({ ...s, width: Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w))) })), []);
  const toggle = useCallback(() => setState((s) => ({ ...s, collapsed: !s.collapsed })), []);
  // Ctrl+B (Mac: ⌘B): 사이드바 접기/펼치기
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") { e.preventDefault(); toggle(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [toggle]);
  return { ...state, setWidth, toggle };
}
