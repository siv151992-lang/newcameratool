import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Monitor } from "lucide-react";
import { api } from "../api/client";
import { absoluteTime, relativeTime } from "../lib/format";
import { useToast } from "./toast";
import { Button, Card, ErrorMessage, Spinner } from "./ui";

export interface SessionRow {
  id: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
  organizationName: string | null;
}

/** Where a person is signed in: the device, IP address, when it started and was last used. */
export function SessionTable({ sessions, onEnd, ending }: { sessions: SessionRow[]; onEnd?: (id: string) => void; ending?: string | null }) {
  if (!sessions.length) return <p className="px-4 py-4 text-sm text-ink-secondary">Not signed in anywhere.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-ink-secondary">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">Device</th>
            <th scope="col" className="px-4 py-2 font-medium">IP address</th>
            <th scope="col" className="px-4 py-2 font-medium">Signed in</th>
            <th scope="col" className="px-4 py-2 font-medium">Last active</th>
            {onEnd && <th scope="col" className="px-4 py-2 text-right font-medium"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} className="border-t border-line">
              <td className="px-4 py-2">
                <div className="flex items-center gap-2 font-medium">
                  <Monitor className="h-4 w-4 text-ink-muted" aria-hidden />
                  {s.device}
                  {s.current && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-ink">This device</span>}
                </div>
                {s.organizationName && <div className="text-xs text-ink-muted">{s.organizationName}</div>}
              </td>
              <td className="tabular px-4 py-2 text-ink-secondary">{s.ip ?? "—"}</td>
              <td className="px-4 py-2 text-ink-secondary" title={absoluteTime(s.createdAt)}>{relativeTime(s.createdAt)}</td>
              <td className="px-4 py-2 text-ink-secondary" title={absoluteTime(s.lastSeenAt)}>{relativeTime(s.lastSeenAt)}</td>
              {onEnd && (
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  {!s.current && (
                    <Button size="sm" variant="ghost" icon={<LogOut className="h-4 w-4" />} loading={ending === s.id} onClick={() => onEnd(s.id)}>
                      Sign out
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Account & theme: the user's own sessions, to sign out a lost or shared device. */
export function SessionsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["auth", "sessions"], queryFn: () => api<{ sessions: SessionRow[]; idleTimeoutMinutes: number }>("/auth/sessions"), refetchInterval: 30_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["auth", "sessions"] });
  const end = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast("success", "Signed out on that device"); void refresh(); },
    onError: (e: Error) => toast("error", e.message),
  });
  const others = useMutation({
    mutationFn: () => api<{ ended: number }>("/auth/sessions/sign-out-others", { method: "POST" }),
    onSuccess: (r) => { toast("success", r.ended ? `Signed out on ${r.ended} other device${r.ended === 1 ? "" : "s"}` : "No other sessions"); void refresh(); },
    onError: (e: Error) => toast("error", e.message),
  });
  const otherCount = q.data?.sessions.filter((s) => !s.current).length ?? 0;
  return (
    <Card
      title="Where you're signed in"
      actions={otherCount > 0 && (
        <Button size="sm" icon={<LogOut className="h-4 w-4" />} loading={others.isPending} onClick={() => others.mutate()}>
          Sign out all other devices
        </Button>
      )}
    >
      {q.isLoading ? <Spinner /> : q.error ? <ErrorMessage error={q.error} className="m-4" /> : (
        <>
          <SessionTable sessions={q.data!.sessions} onEnd={(id) => end.mutate(id)} ending={end.isPending ? end.variables : null} />
          <p className="border-t border-line px-4 py-2 text-xs text-ink-secondary">
            {q.data!.idleTimeoutMinutes > 0
              ? `You are signed out after ${q.data!.idleTimeoutMinutes} minutes without use (the Live page stays open). Changing your password signs out every other device.`
              : "Changing your password signs out every other device."}
          </p>
        </>
      )}
    </Card>
  );
}
