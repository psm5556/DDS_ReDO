import { createContext, useContext } from "react";
import type { ProjectDetail, Role } from "./types";

export interface ProjectCtx { project: ProjectDetail; reload: () => Promise<void>; }
export const ProjectContext = createContext<ProjectCtx | null>(null);
export function useProject(): ProjectCtx {
  const c = useContext(ProjectContext);
  if (!c) throw new Error("ProjectContext 없음");
  return c;
}
const RANK: Record<Role, number> = { viewer: 1, runner: 2, editor: 3, owner: 4 };
export const can = (role: Role, min: Role) => RANK[role] >= RANK[min];
