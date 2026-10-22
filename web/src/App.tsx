import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/ui";
import { useAuth } from "./hooks/auth";
import { AiPage } from "./pages/AiPage";
import { AlertsPage } from "./pages/AlertsPage";
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from "./pages/auth/EmailLinkPages";
import { InvitationPage } from "./pages/auth/InvitationPage";
import { LoginPage } from "./pages/auth/LoginPage";
import { SignupPage } from "./pages/auth/SignupPage";
import { BrandsPage } from "./pages/BrandsPage";
import { CameraDetailPage } from "./pages/CameraDetailPage";
import { CameraFormPage } from "./pages/CameraFormPage";
import { CamerasPage } from "./pages/CamerasPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ImportPage } from "./pages/ImportPage";
import { NoOrganizationPage } from "./pages/NoOrganizationPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const { user, loading, can } = useAuth();
  if (loading) return <Spinner label="Starting" />;
  return (
    <Routes>
      {/* Links from emails work whether or not someone is signed in. */}
      <Route path="invite/:token" element={<InvitationPage />} />
      <Route path="verify-email" element={<VerifyEmailPage />} />
      <Route path="reset-password" element={<ResetPasswordPage />} />
      {!user ? (
        <>
          <Route path="signup" element={<SignupPage />} />
          <Route path="forgot-password" element={<ForgotPasswordPage />} />
          <Route path="*" element={<LoginPage />} />
        </>
      ) : !user.organizationId ? (
        <Route path="*" element={<NoOrganizationPage />} />
      ) : (
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
      )}
    </Routes>
  );
}
