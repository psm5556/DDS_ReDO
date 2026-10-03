import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { RequireAuth } from "./auth";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { useSideLayout } from "./components/sideLayout";
import { TopBar } from "./components/TopBar";
import DashboardPage from "./pages/DashboardPage";
import LoginPage from "./pages/LoginPage";
import PrintPage from "./pages/PrintPage";
import ProjectPage from "./pages/ProjectPage";
import RunEntryPage from "./pages/RunEntryPage";
import SharedPage from "./pages/SharedPage";
import WizardPage from "./pages/WizardPage";

function Shell({ children }: { children: React.ReactNode }) {
  return <RequireAuth><TopBar />{children}</RequireAuth>;
}

/** 주소가 바뀌면 오류 상태를 초기화한다 (다른 화면으로 이동하면 다시 정상 표시) */
function RouteBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary key={pathname} label="이 화면">{children}</ErrorBoundary>;
}

/** 왼쪽 DOE 목록(로고·사용자 포함) + 오른쪽 작업 영역. 상단바는 두지 않아 화면 높이를 작업에 쓴다 */
function SideShell({ children }: { children: React.ReactNode }) {
  const side = useSideLayout();
  return (
    <RequireAuth>
      <div className={`app-shell ${side.collapsed ? "side-collapsed" : ""}`} style={{ "--side-w": `${side.width}px` } as React.CSSProperties}>
        <ProjectSidebar layout={side} />
        <div className="app-main"><RouteBoundary>{children}</RouteBoundary></div>
      </div>
    </RequireAuth>
  );
}

/** 예전 설정 수정 주소 → DOE 설정(프로젝트 첫 화면) */
function EditRedirect() {
  const { pid } = useParams();
  return <Navigate to={`/projects/${pid}`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<SideShell><DashboardPage /></SideShell>} />
      <Route path="/new" element={<SideShell><WizardPage /></SideShell>} />
      <Route path="/projects/:pid/edit" element={<EditRedirect />} />
      <Route path="/projects/:pid/runs/:rid" element={<Shell><RunEntryPage /></Shell>} />
      <Route path="/projects/:pid/print" element={<RequireAuth><PrintPage /></RequireAuth>} />
      <Route path="/projects/:pid/*" element={<SideShell><ProjectPage /></SideShell>} />
      <Route path="/shared/:token" element={<SideShell><SharedPage /></SideShell>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
