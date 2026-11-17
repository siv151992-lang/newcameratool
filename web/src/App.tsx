import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/ui";
import { useAuth } from "./hooks/auth";
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from "./pages/auth/EmailLinkPages";
import { InvitationPage } from "./pages/auth/InvitationPage";
import { LoginPage } from "./pages/auth/LoginPage";
import { SignupPage } from "./pages/auth/SignupPage";
import { NoOrganizationPage } from "./pages/NoOrganizationPage";

// The app's pages load when first opened (the sign-in page and the first screen load less).
const AiPage = lazy(() => import("./pages/AiPage").then((m) => ({ default: m.AiPage })));
const AlertsPage = lazy(() => import("./pages/AlertsPage").then((m) => ({ default: m.AlertsPage })));
const BrandsPage = lazy(() => import("./pages/BrandsPage").then((m) => ({ default: m.BrandsPage })));
const CameraDetailPage = lazy(() => import("./pages/CameraDetailPage").then((m) => ({ default: m.CameraDetailPage })));
const CameraFormPage = lazy(() => import("./pages/CameraFormPage").then((m) => ({ default: m.CameraFormPage })));
const CamerasPage = lazy(() => import("./pages/CamerasPage").then((m) => ({ default: m.CamerasPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const ImportPage = lazy(() => import("./pages/ImportPage").then((m) => ({ default: m.ImportPage })));
const ScanPage = lazy(() => import("./pages/ScanPage").then((m) => ({ default: m.ScanPage })));
const LiveWallPage = lazy(() => import("./pages/LiveWallPage").then((m) => ({ default: m.LiveWallPage })));
const UptimePage = lazy(() => import("./pages/UptimePage").then((m) => ({ default: m.UptimePage })));
const FirmwarePage = lazy(() => import("./pages/FirmwarePage").then((m) => ({ default: m.FirmwarePage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));

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
          {can("cameras:write") && <Route path="cameras/scan" element={<ScanPage />} />}
          {can("cameras:write") && <Route path="cameras/:id/edit" element={<CameraFormPage />} />}
          {/* Without the right to add cameras, these addresses go to the camera list (not "Camera not found"). */}
          {!can("cameras:write") && ["cameras/new", "cameras/import", "cameras/scan", "cameras/:id/edit"].map((p) => <Route key={p} path={p} element={<Navigate to="/cameras" replace />} />)}
          <Route path="cameras/:id" element={<CameraDetailPage />} />
          {can("cameras:live") && <Route path="live" element={<LiveWallPage />} />}
          <Route path="uptime" element={<UptimePage />} />
          <Route path="firmware" element={<FirmwarePage />} />
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
