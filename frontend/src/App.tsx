import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { RequireAuth } from "./auth";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProjectSidebar } from "./components/ProjectSidebar";
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

/** 왼쪽 DOE 목록 + 오른쪽 작업 영역 */
/** 주소가 바뀌면 오류 상태를 초기화한다 (다른 화면으로 이동하면 다시 정상 표시) */
function RouteBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary key={pathname} label="이 화면">{children}</ErrorBoundary>;
}

function SideShell({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <TopBar />
      <div className="app-shell">
        <ProjectSidebar />
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
