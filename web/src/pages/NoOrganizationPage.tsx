import { Building2, LogOut, Video } from "lucide-react";
import { Button, Card } from "../components/ui";
import { useAuth } from "../hooks/auth";
import { OrganizationsTab } from "./OrganizationsTab";

/**
 * For someone signed in who belongs to no organization (yet, or any longer). The system
 * administrator can create one here; everyone else waits for an invitation.
 */
export function NoOrganizationPage() {
  const { user, logout } = useAuth();
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
        {user?.isSystemAdmin ? (
          <>
            <h1 className="mb-1 text-xl font-semibold">Organizations</h1>
            <p className="mb-5 text-sm text-ink-secondary">You are not working in an organization. Create one, or open one you belong to.</p>
            <OrganizationsTab />
          </>
        ) : (
          <Card>
            <div className="flex flex-col items-center px-6 py-10 text-center">
              <Building2 className="mb-3 h-8 w-8 text-ink-muted" aria-hidden />
              <h1 className="text-lg font-semibold">You are not in any organization yet</h1>
              <p className="mt-2 max-w-md text-sm text-ink-secondary">
                Cameras, alerts and settings belong to organizations. Ask an organization administrator to add you; once they have, sign in again.
              </p>
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}
