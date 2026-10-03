import { Archive, ArchiveRestore, CircleCheck, CopyPlus, RotateCcw, Settings, Star, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { del, get, patch, post } from "../api";
import { notifyDataChanged, notifyProjectsChanged } from "../guide/steps";
import { can, ProjectContext } from "../project";
import MembersShare from "../sections/ShareSection";
import { useToast } from "../toast";
import type { ProjectDetail, ProjectSummary } from "../types";
import { Confirm, Modal } from "./Modal";

/** 멤버·공유 창: 사이드바에서 열기 때문에 프로젝트 정보를 직접 불러와 ProjectContext로 감싼다 */
export function MembersShareModal({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const reload = useCallback(async () => {
    setProject(await get<ProjectDetail>(`/api/projects/${projectId}`));
    notifyProjectsChanged();
  }, [projectId]);
  useEffect(() => { void reload(); }, [reload]);
  return (
    <Modal title={project ? `${project.name} · 멤버·공유` : "멤버·공유"} wide onClose={onClose}>
      {project ? (
        <ProjectContext.Provider value={{ project, reload }}><MembersShare /></ProjectContext.Provider>
      ) : <div className="busy"><span className="spinner" /> 불러오는 중</div>}
    </Modal>
  );
}

/** DOE 이름 옆 ⋯ 버튼이나 우클릭으로 여는 메뉴 */
export function ProjectMenu({ p, at, onClose, onFav }: {
  p: ProjectSummary; at: { x: number; y: number }; onClose: () => void; onFav: (p: ProjectSummary) => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [members, setMembers] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const menuOpen = !members && !confirmDel;

  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", key); window.removeEventListener("resize", onClose); };
  }, [menuOpen, onClose]);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);

  const duplicate = async () => {
    try {
      const n = await post<ProjectDetail>(`/api/projects/${p.id}/duplicate`);
      toast("복제했습니다. 인자·응답 설정만 복사되었습니다.");
      notifyProjectsChanged();
      onClose();
      nav(`/projects/${n.id}`);
    } catch (e) { toast((e as Error).message, true); }
  };
  // DOE 상태(진행 중·완료·보관): 편집자 이상. 보관하면 첫 화면 목록에서 빠지고 사이드바에서 흐리게 보인다
  const setStatus = async (status: string, msg: string) => {
    onClose();
    try {
      await patch(`/api/projects/${p.id}`, { status });
      toast(msg);
      notifyProjectsChanged();
      notifyDataChanged(); // 열려 있는 DOE 머리글도 바로 바뀌게
    } catch (e) { toast((e as Error).message, true); }
  };
  const editor = can(p.my_role, "editor");
  const item = (icon: React.ReactNode, label: string, on: () => void, danger = false) => (
    <button role="menuitem" className={danger ? "danger" : ""} onClick={on}>{icon}{label}</button>
  );
  // 화면 밖으로 나가지 않게 위치 보정
  const style = { left: Math.min(at.x, window.innerWidth - 220), top: Math.min(at.y, window.innerHeight - 320) };
  return (
    <>
      {menuOpen && (
        <div ref={ref} className="ctx-menu" role="menu" aria-label={`${p.name} 메뉴`} style={style}>
          {item(<Settings size={14} />, "DOE 설정", () => { onClose(); nav(`/projects/${p.id}`); })}
          {item(<Users size={14} />, p.my_role === "owner" ? "멤버·공유" : "멤버 보기", () => setMembers(true))}
          {item(<Star size={14} fill={p.is_favorite ? "currentColor" : "none"} />, p.is_favorite ? "즐겨찾기 해제" : "즐겨찾기 추가", () => { onFav(p); onClose(); })}
          {item(<CopyPlus size={14} />, "새 DOE로 복제", duplicate)}
          {editor && <>
            <div className="ctx-sep" />
            {p.status === "active" && item(<CircleCheck size={14} />, "완료로 표시", () => void setStatus("completed", "완료로 표시했습니다."))}
            {p.status === "completed" && item(<RotateCcw size={14} />, "진행 중으로 되돌리기", () => void setStatus("active", "진행 중으로 되돌렸습니다."))}
            {p.status === "archived"
              ? item(<ArchiveRestore size={14} />, "보관 해제", () => void setStatus("active", "보관을 해제했습니다."))
              : item(<Archive size={14} />, "보관", () => void setStatus("archived", "보관했습니다. 첫 화면에서는 빠지고, 사이드바에는 흐리게 남습니다."))}
          </>}
          {p.my_role === "owner" && <><div className="ctx-sep" />{item(<Trash2 size={14} />, "삭제", () => setConfirmDel(true), true)}</>}
        </div>
      )}
      {members && <MembersShareModal projectId={p.id} onClose={onClose} />}
      {confirmDel && (
        <Confirm title="DOE 삭제" danger confirmLabel="삭제" onClose={onClose}
          message={<>“{p.name}”을(를) 삭제합니다. 멤버와 공유받은 사람도 더 이상 볼 수 없습니다.</>}
          onConfirm={async () => {
            try { await del(`/api/projects/${p.id}`); toast("삭제했습니다."); notifyProjectsChanged(); nav("/"); }
            catch (e) { toast((e as Error).message, true); }
          }} />
      )}
    </>
  );
}
