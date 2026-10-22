import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/ui";
import { useAuth } from "./hooks/auth";
import { AiPage } from "./pages/AiPage";
import { AlertsPage } from "./pages/AlertsPage";
import { BrandsPage } from "./pages/BrandsPage";
import { CameraDetailPage } from "./pages/CameraDetailPage";
import { CameraFormPage } from "./pages/CameraFormPage";
import { CamerasPage } from "./pages/CamerasPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ImportPage } from "./pages/ImportPage";
import { LoginPage } from "./pages/LoginPage";
import { NoOrganizationPage } from "./pages/NoOrganizationPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const { user, loading, can } = useAuth();
  if (loading) return <Spinner label="Starting" />;
  if (!user) return <LoginPage />;
  if (!user.organizationId) return <NoOrganizationPage />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="cameras" element={<CamerasPage />} />
        {can("cameras:write") && <Route path="cameras/new" element={<CameraFormPage />} />}
        {can("cameras:write") && <Route path="cameras/import" element={<ImportPage />} />}
        {can("cameras:write") && <Route path="cameras/:id/edit" element={<CameraFormPage />} />}
        <Route path="cameras/:id" element={<CameraDetailPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="ai/*" element={<AiPage />} />
        <Route path="integrations" element={<BrandsPage />} />
        <Route path="settings/*" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
