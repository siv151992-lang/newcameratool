import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Copy, Mail, Send } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "../api/client";
import type { Invitation, InvitationSent, Role } from "../api/types";
import { Button, Card, ConfirmDialog, Dialog, EmptyState, Field, Input, Select, Spinner } from "../components/ui";
import { useToast } from "../components/toast";
import { ROLE_LABELS, useAuth } from "../hooks/auth";
import { absoluteTime, relativeTime } from "../lib/format";
import { useSignInOptions } from "./auth/AuthLayout";

const STATUS: Record<Invitation["status"], { label: string; tone: string }> = {
  pending: { label: "Waiting", tone: "bg-accent-soft text-accent-ink" },
  expired: { label: "Expired", tone: "bg-warn/15 text-ink" },
  accepted: { label: "Accepted", tone: "bg-good/15 text-ink" },
  revoked: { label: "Revoked", tone: "bg-line text-ink-secondary" },
};

/** Invite form state; `sent` holds the answer, whose link is shown once. */
interface InviteState {
  email: string;
  role: Role;
  sent?: InvitationSent;
}

/**
 * Invitations into the current organization. People join only when they accept; the link expires
 * and stops working once used or revoked. The link is also shown for the Org Admin to share in chat.
 */
export function useInvitations() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const options = useSignInOptions();
  const [inviting, setInviting] = useState<InviteState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["invitations"] });

  const announce = (sent: InvitationSent, email: string) => {
    if (sent.emailSent) toast("success", sent.outcome === "resent" ? `Invitation sent again to ${email} with a new link` : `Invitation sent to ${email}`);
    void refresh();
  };
  const send = useMutation({
    mutationFn: () => api<InvitationSent>("/invitations", { method: "POST", body: { email: inviting!.email, role: inviting!.role } }),
    onSuccess: (sent) => {
      setError(null);
      announce(sent, inviting!.email);
      // Show the link every time, to share in chat as well as (or instead of) the email.
      setInviting((s) => s && { ...s, sent });
    },
    onError: (e) => setError(e instanceof ApiError && e.fieldErrors[0] ? e.fieldErrors[0].message : (e as Error).message),
  });
  const resend = useMutation({
    mutationFn: (inv: Invitation) => api<InvitationSent>(`/invitations/${inv.id}/resend`, { method: "POST" }),
    onSuccess: (sent, inv) => {
      announce(sent, inv.email);
      setInviting({ email: inv.email, role: inv.role, sent });
    },
    onError: (e: Error) => toast("error", e.message),
  });

  const open = () => {
    setError(null);
    setInviting({ email: "", role: "viewer" });
  };

  const dialog = (
    <Dialog
      open={!!inviting}
      onClose={() => setInviting(null)}
      title={inviting?.sent ? "Invitation link" : `Invite someone to ${user?.organizationName}`}
      footer={
        inviting?.sent ? (
          <Button variant="primary" onClick={() => setInviting(null)}>Done</Button>
        ) : (
          <>
            <Button onClick={() => setInviting(null)}>Cancel</Button>
            <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={send.isPending} disabled={!inviting?.email.trim()} onClick={() => send.mutate()}>Send invitation</Button>
          </>
        )
      }
    >
      {inviting && (inviting.sent ? (
        <InvitationLink email={inviting.email} sent={inviting.sent} />
      ) : (
        <div className="space-y-3">
          <p className="text-ink-secondary">
            They get an email with a link to join. They become a member only when they accept, signed in with this address (or a new account for it). The link expires in {options.data?.invitationExpiryHours ?? 72} hours.
          </p>
          <Field label="Email address" required error={error ?? undefined}>
            {(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="off" autoFocus value={inviting.email} invalid={!!error} onChange={(e) => setInviting({ ...inviting, email: e.target.value })} />}
          </Field>
          <Field label="Role">
            {(id) => (
              <Select id={id} value={inviting.role} onChange={(e) => setInviting({ ...inviting, role: e.target.value as Role })}>
                <option value="viewer">{ROLE_LABELS.viewer}: read-only</option>
                <option value="operator">{ROLE_LABELS.operator}: run checks and manage alerts</option>
                <option value="admin">{ROLE_LABELS.admin}: everything, including members</option>
              </Select>
            )}
          </Field>
        </div>
      ))}
    </Dialog>
  );
  return { open, dialog, resend };
}

function InvitationLink({ email, sent }: { email: string; sent: InvitationSent }) {
  const toast = useToast();
  // The saved dashboard address (as in the email), else the address this page is open at.
  const url = sent.url ?? `${window.location.origin}${sent.link}`;
  const host = new URL(url).hostname;
  return (
    <div className="space-y-3">
      {sent.emailSent ? (
        <p>The invitation was emailed to <strong>{email}</strong>. You can also send them this link in a chat message.</p>
      ) : (
        <>
          <p>
            The invitation for <strong>{email}</strong> is ready, but the email was not sent
            {sent.emailError ? <>: <span className="text-ink-secondary">{sent.emailError}</span></> : "."}
          </p>
          <p>Copy the link and send it to them yourself.</p>
        </>
      )}
      <p className="text-ink-secondary">It works once, only for {email}, and is shown only now. Resending makes a new link.</p>
      {/^(localhost|127\.|\[::1\])/.test(host) && (
        <p className="text-warn">
          This link starts with {host}, which opens only on the server itself. Set the dashboard address to the server's network address (such as http://10.0.0.5:8080) in Settings → Email &amp; sign-in, then resend the invitation.
        </p>
      )}
      <div className="flex gap-2">
        <Input readOnly value={url} aria-label="Invitation link" onFocus={(e) => e.target.select()} />
        <Button
          icon={<Copy className="h-4 w-4" />}
          onClick={() => void navigator.clipboard.writeText(url).then(() => toast("success", "Link copied"), () => toast("error", "Copy failed: select the link and copy it"))}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

export function InvitationsCard({ resend }: { resend: ReturnType<typeof useInvitations>["resend"] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const invitations = useQuery({ queryKey: ["invitations"], queryFn: () => api<Invitation[]>("/invitations") });
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/invitations/${id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      toast("success", `Invitation for ${revoking?.email} revoked`);
      setRevoking(null);
      void qc.invalidateQueries({ queryKey: ["invitations"] });
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <Card title="Invitations">
      {invitations.isLoading ? (
        <Spinner />
      ) : !invitations.data?.length ? (
        <EmptyState icon={<Mail className="h-6 w-6" />} title="No invitations" description="Invite people by email; they appear under Members once they accept." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-secondary">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Email</th>
                <th scope="col" className="px-4 py-2 font-medium">Role</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="px-4 py-2 font-medium">Sent</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invitations.data.map((inv) => (
                <tr key={inv.id} className="border-t border-line">
                  <td className="px-4 py-2 font-medium">{inv.email}</td>
                  <td className="px-4 py-2">{ROLE_LABELS[inv.role]}</td>
                  <td className="px-4 py-2">
                    <span className={clsx("rounded-full px-2 py-0.5 text-xs font-medium", STATUS[inv.status].tone)}>{STATUS[inv.status].label}</span>
                    <div className="mt-0.5 text-xs text-ink-muted">
                      {inv.status === "pending" && `Expires ${relativeTime(inv.expiresAt)}`}
                      {inv.status === "expired" && `Expired ${relativeTime(inv.expiresAt)}`}
                      {inv.status === "accepted" && `By ${inv.acceptedBy ?? "a removed account"} ${relativeTime(inv.acceptedAt)}`}
                      {inv.status === "revoked" && relativeTime(inv.revokedAt)}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-ink-secondary" title={absoluteTime(inv.sentAt)}>
                    {relativeTime(inv.sentAt)}{inv.invitedBy ? ` by ${inv.invitedBy}` : ""}{inv.sendCount > 1 ? ` · sent ${inv.sendCount}×` : ""}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    {(inv.status === "pending" || inv.status === "expired") && (
                      <>
                        <Button size="sm" variant="ghost" loading={resend.isPending && resend.variables?.id === inv.id} onClick={() => resend.mutate(inv)}>
                          Send again
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRevoking(inv)}>Revoke</Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!revoking}
        danger
        title={`Revoke the invitation for ${revoking?.email}?`}
        confirmLabel="Revoke"
        loading={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => revoke.mutate(revoking!.id)}
      >
        <p>The link stops working at once. You can invite them again later.</p>
      </ConfirmDialog>
    </Card>
  );
}

/** Type an email address and press Send: the joining link is emailed and shown to copy. */
export function QuickInvite() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; sent: InvitationSent } | null>(null);
  const send = useMutation({
    mutationFn: () => api<InvitationSent>("/invitations", { method: "POST", body: { email: email.trim(), role } }),
    onSuccess: (r) => {
      setError(null);
      setSent({ email: email.trim(), sent: r });
      if (r.emailSent) toast("success", `Invitation sent to ${email.trim()}`);
      setEmail("");
      void qc.invalidateQueries({ queryKey: ["invitations"] });
    },
    onError: (e) => setError(e instanceof ApiError && e.fieldErrors[0] ? e.fieldErrors[0].message : (e as Error).message),
  });

  return (
    <Card title={`Add someone to ${user?.organizationName ?? "this organization"}`}>
      <form
        className="space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) send.mutate();
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1">
            <Field label="Their email address" error={error ?? undefined}>
              {(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="off" placeholder="name@company.com" value={email} invalid={!!error} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
          </div>
          <div>
            <Field label="Role">
              {(id) => (
                <Select id={id} className="w-auto" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  <option value="viewer">{ROLE_LABELS.viewer}</option>
                  <option value="operator">{ROLE_LABELS.operator}</option>
                  <option value="admin">{ROLE_LABELS.admin}</option>
                </Select>
              )}
            </Field>
          </div>
          <Button type="submit" variant="primary" icon={<Send className="h-4 w-4" />} loading={send.isPending} disabled={!email.trim()}>Send link</Button>
        </div>
        <p className="text-xs text-ink-secondary">They get an email with a link to create their account and join. Nothing else to fill in.</p>
        {sent && (
          <div className="rounded-md border border-line bg-raised p-3 text-sm">
            <InvitationLink email={sent.email} sent={sent.sent} />
          </div>
        )}
      </form>
    </Card>
  );
}
