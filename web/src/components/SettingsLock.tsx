import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, LockKeyhole, LockOpen } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import { Button, Card, Dialog, ErrorMessage, Field, Input, PageHeader, Spinner } from "./ui";

export const SETTINGS_UNLOCK_KEY = ["settings-unlock"];

/**
 * Settings are password protected: the user enters their password again to open them. They stay
 * open while in use and lock after 15 minutes without settings work (the server enforces this too).
 * Locked again while a page is open, the page stays and the password is asked over it, so nothing
 * typed is lost.
 */
export function SettingsLock({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: SETTINGS_UNLOCK_KEY,
    queryFn: () => api<{ until: string | null }>("/auth/confirm-password"),
    staleTime: 30_000,
    placeholderData: undefined,
  });
  const until = status.data?.until ? Date.parse(status.data.until) : null;
  const open = until !== null && until > Date.now();
  const [wasOpen, setWasOpen] = useState(false);
  useEffect(() => {
    if (open) setWasOpen(true);
  }, [open]);
  // Check again when it would lock (each change keeps it open longer on the server).
  useEffect(() => {
    if (!until) return;
    const t = setTimeout(() => void status.refetch(), Math.max(1000, until - Date.now() + 500));
    return () => clearTimeout(t);
  }, [until, status]);
  const lockNow = useMutation({
    mutationFn: () => api("/auth/confirm-password", { method: "DELETE" }),
    onSuccess: () => {
      setWasOpen(false);
      qc.setQueryData(SETTINGS_UNLOCK_KEY, { until: null });
    },
  });

  if (status.isLoading) return <Spinner />;
  if (!open && !wasOpen) {
    return (
      <>
        <PageHeader title="Settings" description="Settings are password protected." />
        <Card>
          <UnlockForm />
        </Card>
      </>
    );
  }
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2 text-xs text-ink-secondary">
        <LockOpen className="h-3.5 w-3.5 text-good" aria-hidden />
        Settings are unlocked; they lock after 15 minutes without changes.
        <Button size="sm" variant="ghost" icon={<Lock className="h-3.5 w-3.5" />} onClick={() => lockNow.mutate()} loading={lockNow.isPending}>
          Lock now
        </Button>
      </div>
      {children}
      <Dialog open={!open} onClose={() => undefined} title="Settings locked">
        <p className="mb-2 text-sm text-ink-secondary">Settings locked after a while without changes. Enter your password to continue; what you typed is kept.</p>
        <UnlockForm compact />
      </Dialog>
    </>
  );
}

function UnlockForm({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [creating, setCreating] = useState(false);
  const unlock = useMutation({
    mutationFn: async () => {
      // Accounts that sign in with Google or Zoho have no password yet: set one, then open with it.
      if (creating) {
        if (password !== repeat) throw new Error("The two passwords do not match");
        await api("/auth/password", { method: "POST", body: { currentPassword: "-", newPassword: password } });
      }
      return api<{ until: string }>("/auth/confirm-password", { method: "POST", body: { password } });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "NO_PASSWORD") setCreating(true);
    },
    onSuccess: (r) => {
      setPassword("");
      setRepeat("");
      setCreating(false);
      qc.setQueryData(SETTINGS_UNLOCK_KEY, r);
    },
  });
  return (
    <form
      className={compact ? "space-y-3" : "mx-auto flex max-w-sm flex-col items-center gap-4 px-4 py-10 text-center"}
      onSubmit={(e) => {
        e.preventDefault();
        if (password) unlock.mutate();
      }}
    >
      {!compact && (
        <>
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
            <LockKeyhole className="h-6 w-6" aria-hidden />
          </span>
          <div>
            <h2 className="font-semibold">Enter your password to open Settings</h2>
            <p className="mt-1 text-sm text-ink-secondary">They stay open while you work and lock after 15 minutes without changes.</p>
          </div>
        </>
      )}
      <div className="w-full space-y-3 text-left">
        {creating && <p className="text-sm text-ink-secondary">Your account signs in with Google or Zoho and has no password yet. Choose one to protect Settings.</p>}
        <Field label={creating ? "New password" : "Your password"}>
          {(id) => <Input id={id} type="password" autoComplete={creating ? "new-password" : "current-password"} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        {creating && (
          <Field label="Repeat the password">
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />}
          </Field>
        )}
      </div>
      {unlock.error && !(unlock.error instanceof ApiError && unlock.error.code === "NO_PASSWORD") && <ErrorMessage error={unlock.error} className="w-full text-left" />}
      <Button type="submit" variant="primary" className="w-full" loading={unlock.isPending} disabled={!password || (creating && !repeat)} icon={<LockKeyhole className="h-4 w-4" />}>
        {creating ? "Set password and unlock" : "Unlock"}
      </Button>
    </form>
  );
}
