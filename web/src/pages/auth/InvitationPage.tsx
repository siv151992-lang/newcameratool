import { useQuery } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client";
import type { InvitationPreview } from "../../api/types";
import { Button, ErrorMessage, Spinner } from "../../components/ui";
import { useToast } from "../../components/toast";
import { ROLE_LABELS, useAuth } from "../../hooks/auth";
import { relativeTime } from "../../lib/format";
import { AuthLayout, BackToSignIn } from "./AuthLayout";
import { SignInForm } from "./LoginPage";
import { ProviderButtons } from "./ProviderButtons";
import { SignupForm } from "./SignupPage";

const CLOSED: Record<Exclude<InvitationPreview["status"], "pending">, string> = {
  accepted: "This invitation has already been used.",
  revoked: "This invitation was withdrawn by the organization.",
  expired: "This invitation has expired. Ask the organization's administrator to send a new one.",
};

/**
 * /invite/:token — what the invitation is for, then accept it: signed in already, by signing in
 * with the invited address, or by creating an account for it.
 */
export function InvitationPage() {
  const { token = "" } = useParams();
  const { user, switchOrganization, refresh, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const invitation = useQuery({ queryKey: ["invitation", token], queryFn: () => api<InvitationPreview>(`/auth/invitations/${token}`), retry: false });
  const [mode, setMode] = useState<"signin" | "signup" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const inv = invitation.data;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const joined = await api<{ organizationId: string; organizationName: string }>("/auth/invitations/accept", { method: "POST", body: { token } });
      await switchOrganization(joined.organizationId);
      toast("success", `Welcome to ${joined.organizationName}`);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err);
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const done = () => {
    toast("success", `Welcome to ${inv?.organizationName}`);
    navigate("/", { replace: true });
  };

  if (invitation.isLoading) return <AuthLayout title="Invitation"><Spinner /></AuthLayout>;
  if (!inv) {
    return (
      <AuthLayout title="Invitation" footer={<BackToSignIn />}>
        <ErrorMessage error={invitation.error} />
      </AuthLayout>
    );
  }

  const summary = (
    <div className="mb-5 flex items-start gap-3 rounded-md border border-line bg-raised p-3 text-sm">
      <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
      <div>
        <div className="font-medium">{inv.organizationName}</div>
        <div className="text-ink-secondary">
          {inv.invitedBy ? `${inv.invitedBy} invited ` : "Invitation for "}<strong className="text-ink">{inv.email}</strong> as {ROLE_LABELS[inv.role]}
        </div>
        {inv.status === "pending" && <div className="text-xs text-ink-muted">Expires {relativeTime(inv.expiresAt)}</div>}
      </div>
    </div>
  );

  if (inv.status !== "pending") {
    return (
      <AuthLayout title="Invitation" footer={<BackToSignIn />}>
        {summary}
        <p className="text-sm">{CLOSED[inv.status]}</p>
      </AuthLayout>
    );
  }

  if (user) {
    const other = user.email && user.email.toLowerCase() !== inv.email;
    return (
      <AuthLayout title={`Join ${inv.organizationName}`}>
        {summary}
        {other ? (
          <div className="space-y-4 text-sm">
            <p>You are signed in as <strong>{user.email}</strong>. This invitation is for <strong>{inv.email}</strong>: sign out and sign in with that address.</p>
            <Button className="w-full" onClick={() => void logout()}>Sign out</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">Signed in as {user.displayName ?? user.username}.</p>
            <ErrorMessage error={error} />
            <Button variant="primary" className="w-full" loading={busy} onClick={() => void accept()}>Accept invitation</Button>
          </div>
        )}
      </AuthLayout>
    );
  }

  const current = mode ?? (inv.accountExists ? "signin" : "signup");
  return (
    <AuthLayout
      title={`Join ${inv.organizationName}`}
      footer={
        current === "signin" ? (
          <>No account for {inv.email}? <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => setMode("signup")}>Create one</button></>
        ) : (
          <>Already have an account? <button type="button" className="font-medium text-accent-ink hover:underline" onClick={() => setMode("signin")}>Sign in to accept</button></>
        )
      }
    >
      {summary}
      <ProviderButtons invitationToken={token} />
      {current === "signin" ? (
        <>
          <p className="mb-4 text-sm text-ink-secondary">Sign in with the account for {inv.email} to accept.</p>
          <ErrorMessage error={error} className="mb-4" />
          <SignInForm defaultUsername={inv.email} onSignedIn={accept} />
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-ink-secondary">Create your account to accept. You join {inv.organizationName} straight away.</p>
          <SignupForm invitationToken={token} invitedEmail={inv.email} onSignedIn={done} />
        </>
      )}
    </AuthLayout>
  );
}
