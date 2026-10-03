import { useCallback, useEffect, useState } from "react";
import { NavLink, Route, Routes, useParams } from "react-router-dom";
import { get } from "../api";
import { PROJECT_STATUS, ROLE_LABEL } from "../format";
import { usePrefs } from "../prefs";
import { can, ProjectContext } from "../project";
import AnalysisSection from "../sections/AnalysisSection";
import CompareSection from "../sections/CompareSection";
import OverviewSection from "../sections/OverviewSection";
import PlanSection from "../sections/PlanSection";
import RecipeSection from "../sections/RecipeSection";
import RecommendSection from "../sections/RecommendSection";
import ResultsSection from "../sections/ResultsSection";
import SettingsSection from "../sections/SettingsSection";
import ShareSection from "../sections/ShareSection";
import type { ProjectDetail } from "../types";

export default function ProjectPage() {
  const { pid } = useParams();
  const { expert } = usePrefs();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setProject(await get<ProjectDetail>(`/api/projects/${pid}`)); } catch (e) { setErr((e as Error).message); }
  }, [pid]);
  useEffect(() => { void reload(); }, [reload]);

  if (err) return <div className="page"><div className="notice err">{err}</div></div>;
  if (!project) return <div className="page"><div className="busy"><span className="spinner" /> 불러오는 중</div></div>;
  const role = project.my_role;
  const base = `/projects/${project.id}`;
  const link = (to: string, label: string, extra?: React.ReactNode) => (
    <NavLink to={`${base}${to}`} end={to === ""} className={({ isActive }) => (isActive ? "active" : "")}>
      <span>{label}</span>{extra}
    </NavLink>
  );
  return (
    <ProjectContext.Provider value={{ project, reload }}>
      <div className="page">
        <div className="page-head">
          <div className="grow">
            <h1>{project.name}</h1>
            <p className="small">
              {project.owner.name} ({project.owner.department}) · {PROJECT_STATUS[project.status]} · 내 역할: {ROLE_LABEL[role]}
            </p>
          </div>
        </div>
        {project.warnings.map((w) => <div key={w} className="notice warn" style={{ marginBottom: 12 }}>{w}</div>)}
        <div className="project-shell">
          <nav className="section-nav" aria-label="프로젝트 메뉴">
            {link("", "개요")}
            {link("/plan", "실험 계획", <span className="count">{project.batches}차</span>)}
            {link("/results", "결과 입력", project.runs_open > 0 ? <span className="count">{project.runs_open}건 남음</span> : null)}
            <div className="divider" />
            {link("/analysis", "분석")}
            {can(role, "editor") && link("/recommend", "다음 실험 제안")}
            {link("/recipe", "최적 레시피")}
            {expert && link("/compare", "모델 비교", <span className="expert-tag">전문가</span>)}
            <div className="divider" />
            {role === "owner" && link("/share", "멤버·공유")}
            {can(role, "editor") && link("/settings", "설정")}
          </nav>
          <main>
            <Routes>
              <Route index element={<OverviewSection />} />
              <Route path="plan" element={<PlanSection />} />
              <Route path="results" element={<ResultsSection />} />
              <Route path="analysis" element={<AnalysisSection />} />
              <Route path="recommend" element={<RecommendSection />} />
              <Route path="recipe" element={<RecipeSection />} />
              <Route path="compare" element={<CompareSection />} />
              <Route path="share" element={<ShareSection />} />
              <Route path="settings" element={<SettingsSection />} />
            </Routes>
          </main>
        </div>
      </div>
    </ProjectContext.Provider>
  );
}
