import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth";
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

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Shell><DashboardPage /></Shell>} />
      <Route path="/new" element={<Shell><WizardPage /></Shell>} />
      <Route path="/projects/:pid/edit" element={<Shell><WizardPage /></Shell>} />
      <Route path="/projects/:pid/runs/:rid" element={<Shell><RunEntryPage /></Shell>} />
      <Route path="/projects/:pid/print" element={<RequireAuth><PrintPage /></RequireAuth>} />
      <Route path="/projects/:pid/*" element={<Shell><ProjectPage /></Shell>} />
      <Route path="/shared/:token" element={<Shell><SharedPage /></Shell>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
