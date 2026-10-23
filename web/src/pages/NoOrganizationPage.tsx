import { Building2, LogOut, Mail, Video } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import type { PendingInvitation } from "../api/types";
import { Button, Card } from "../components/ui";
import { useToast } from "../components/toast";
import { ROLE_LABELS, useAuth } from "../hooks/auth";
import { relativeTime } from "../lib/format";
import { useRedirectNotice } from "./ConnectedAccounts";
import { OrganizationsTab } from "./OrganizationsTab";

/**
 * For someone signed in who belongs to no organization (yet, or any longer). The system
 * administrator can create one here; everyone else waits for an invitation.
 */
/** Invitations to the user's confirmed address, accepted here without the emailed link. */
function PendingInvitations() {
  const { invitations, switchOrganization } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (!invitations.length) return null;
  const accept = async (inv: PendingInvitation) => {
    setBusy(inv.id);
    try {
      const joined = await api<{ organizationId: string }>("/auth/invitations/accept", { method: "POST", body: { id: inv.id } });
      await switchOrganization(joined.organizationId);
      toast("success", `Welcome to ${inv.organizationName}`);
    } catch (err) {
      toast("error", (err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Invitations for you" className="mb-6">
      <ul className="divide-y divide-line">
        {invitations.map((inv) => (
          <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <Mail className="h-4 w-4 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{inv.organizationName}</div>
              <div className="text-xs text-ink-secondary">As {ROLE_LABELS[inv.role]} · expires {relativeTime(inv.expiresAt)}</div>
            </div>
            <Button size="sm" variant="primary" loading={busy === inv.id} onClick={() => void accept(inv)}>Accept</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function NoOrganizationPage() {
  const { user, logout, invitations } = useAuth();
  useRedirectNotice();
  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center gap-2 border-b border-line bg-surface px-4">
        <Video className="h-5 w-5 text-accent" aria-hidden />
        <span className="font-semibold">Zoho IBMS CCTV Monitoring</span>
        <div className="flex-1" />
        <span className="hidden text-sm text-ink-secondary sm:inline">{user?.displayName ?? user?.username}</span>
        <Button variant="ghost" size="sm" onClick={() => void logout()} icon={<LogOut className="h-4 w-4" />}>Sign out</Button>
      </header>
      <main className="mx-auto w-full max-w-4xl px-4 py-8">
        {invitations.length > 0 && !user?.isSystemAdmin && (
          <>
            <h1 className="mb-1 text-xl font-semibold">Welcome{user?.displayName ? `, ${user.displayName}` : ""}</h1>
            <p className="mb-5 text-sm text-ink-secondary">You are not in an organization yet. Accept an invitation to start.</p>
          </>
        )}
        <PendingInvitations />
        {user?.isSystemAdmin ? (
          <>
            <h1 className="mb-1 text-xl font-semibold">Organizations</h1>
            <p className="mb-5 text-sm text-ink-secondary">You are not working in an organization. Create one, or open one you belong to.</p>
            <OrganizationsTab />
          </>
        ) : invitations.length ? null : (
          <Card>
            <div className="flex flex-col items-center px-6 py-10 text-center">
              <Building2 className="mb-3 h-8 w-8 text-ink-muted" aria-hidden />
              <h1 className="text-lg font-semibold">You are not in any organization yet</h1>
              <p className="mt-2 max-w-md text-sm text-ink-secondary">
                Cameras, alerts and settings belong to organizations. Ask an organization administrator to invite you
                {user?.email ? <> at <strong>{user.email}</strong></> : null}; the invitation appears here and in your email.
              </p>
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}
