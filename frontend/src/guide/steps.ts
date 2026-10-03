import { can } from "../project";
import type { ProjectSummary, Role } from "../types";

/** 한 사이클: ① 실험 데이터 입력(첫 DOE 생성·시트 인쇄·결과 입력) → ② 능동학습 결과(레시피 최적화·추가 DOE 제안·확정) → 다음 차수 ①
 *  0은 아직 실험 계획이 없는 상태(① 화면에서 첫 DOE 생성). */
export type Step = 0 | 1 | 2;

export const STEPS: { n: 1 | 2; label: string; hint: string }[] = [
  { n: 1, label: "실험 데이터 입력", hint: "시트 인쇄 · 결과 입력" },
  { n: 2, label: "능동학습 결과", hint: "추천 레시피 · 다음 실험 확정" },
];

/** 역할별로 들어갈 수 있는 단계: 실험자·편집자는 둘 다, 열람자는 결과만 */
export function allowedSteps(role: Role): Step[] {
  if (can(role, "runner")) return [1, 2];
  return [2];
}

/** 데이터로 현재 단계를 정한다: 계획 없음 → 0, 결과 대기 런이 있으면 → ①, 모두 입력됨 → ② */
export function autoStep(p: Pick<ProjectSummary, "runs_total" | "runs_open" | "my_role">): Step {
  if (p.runs_total === 0) return 0;
  if (p.runs_open > 0 && allowedSteps(p.my_role).includes(1)) return 1;
  return 2;
}

/** 목록·사이드바에 보여 줄 '지금 할 일' 한 줄과, 내가 해야 하는 일인지 여부 */
export function nextAction(p: ProjectSummary): { step: Step; text: string; mine: boolean } {
  const step = autoStep(p);
  if (p.status === "archived") return { step, text: "보관됨", mine: false };
  if (step === 0) {
    return can(p.my_role, "editor")
      ? { step, text: "첫 DOE 생성", mine: true }
      : { step, text: "첫 DOE를 기다리는 중", mine: false };
  }
  if (step === 1) return { step, text: `결과 입력 · ${p.runs_open}건 남음`, mine: true };
  if (p.runs_open > 0) return { step, text: `실험 진행 중 · ${p.runs_open}건 남음`, mine: false };
  return can(p.my_role, "editor")
    ? { step, text: "추천 레시피 확인 → 다음 실험 확정", mine: true }
    : { step, text: "추천 레시피 확인", mine: false };
}

/** 프로젝트 상태가 바뀌었음을 사이드바 등에 알린다 */
export const PROJECTS_CHANGED = "redo:projects-changed";
export const notifyProjectsChanged = () => window.dispatchEvent(new Event(PROJECTS_CHANGED));
