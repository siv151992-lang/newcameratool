import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import type { EmailSettings } from "../api/types";
import { Button, Card, Checkbox, ErrorMessage, Field, Input, Select, Spinner } from "../components/ui";
import { useToast } from "../components/toast";
import { useAuth } from "../hooks/auth";

/** Common mail servers: fill host, port and security in one step. */
const PRESETS = [
  { key: "", label: "Choose a provider to fill in…" },
  { key: "zoho-com", label: "Zoho Mail (zoho.com)", host: "smtp.zoho.com", port: 465, secure: true },
  { key: "zoho-in", label: "Zoho Mail India (zoho.in)", host: "smtp.zoho.in", port: 465, secure: true },
  { key: "zoho-eu", label: "Zoho Mail Europe (zoho.eu)", host: "smtp.zoho.eu", port: 465, secure: true },
  { key: "zoho-au", label: "Zoho Mail Australia (zoho.com.au)", host: "smtp.zoho.com.au", port: 465, secure: true },
  { key: "zoho-pro", label: "Zoho Workplace custom domain (smtppro.zoho.com)", host: "smtppro.zoho.com", port: 465, secure: true },
  { key: "office365", label: "Microsoft 365 / Outlook", host: "smtp.office365.com", port: 587, secure: false },
  { key: "gmail", label: "Google Workspace / Gmail", host: "smtp.gmail.com", port: 465, secure: true },
] as const;

interface Draft {
  publicUrl: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  removePassword: boolean;
  smtpFrom: string;
  allowSignup: boolean;
  invitationExpiryHours: string;
  emailVerificationExpiryHours: string;
  passwordResetExpiryMinutes: string;
}

const toDraft = (s: EmailSettings): Draft => ({
  publicUrl: s.publicUrl ?? "",
  smtpHost: s.smtpHost ?? "",
  smtpPort: String(s.smtpPort),
  smtpSecure: s.smtpSecure,
  smtpUser: s.smtpUser ?? "",
  smtpPassword: "",
  removePassword: false,
  smtpFrom: s.smtpFrom,
  allowSignup: s.allowSignup,
  invitationExpiryHours: String(s.invitationExpiryHours),
  emailVerificationExpiryHours: String(s.emailVerificationExpiryHours),
  passwordResetExpiryMinutes: String(s.passwordResetExpiryMinutes),
});

/** A localhost address opens only on the server itself: never suggest it for links. */
const openedAtLocalhost = /^(localhost|127\.|\[::1\]$)/.test(window.location.hostname);

function toBody(d: Draft) {
  const num = (v: string) => Number(v.trim());
  return {
    publicUrl: d.publicUrl.trim(),
    smtpHost: d.smtpHost.trim(),
    smtpPort: num(d.smtpPort),
    smtpSecure: d.smtpSecure,
    smtpUser: d.smtpUser.trim(),
    // Blank keeps the saved password; "remove" clears it.
    ...(d.removePassword ? { smtpPassword: "" } : d.smtpPassword ? { smtpPassword: d.smtpPassword } : {}),
    smtpFrom: d.smtpFrom.trim(),
    allowSignup: d.allowSignup,
    invitationExpiryHours: num(d.invitationExpiryHours),
    emailVerificationExpiryHours: num(d.emailVerificationExpiryHours),
    passwordResetExpiryMinutes: num(d.passwordResetExpiryMinutes),
  };
}

/**
 * Settings → Email & sign-in (system administrator): the mail server for alerts, invitations,
 * email confirmation and password reset; the dashboard address used in links; who may create accounts.
 */
export function EmailSettingsTab() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "email"], queryFn: () => api<EmailSettings>("/settings/email") });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testTo, setTestTo] = useState(user?.email ?? "");
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    const d = toDraft(settings.data);
    // Nothing saved yet: start from the address this page is open at (not a local-only one).
    if (!d.publicUrl && !openedAtLocalhost) d.publicUrl = window.location.origin;
    setDraft(d);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => api<EmailSettings>("/settings/email", { method: "PATCH", body: toBody(draft!) }),
    onSuccess: (s) => {
      qc.setQueryData(["settings", "email"], s);
      void qc.invalidateQueries({ queryKey: ["auth", "options"] });
      setErrors({});
      toast("success", "Email and sign-in settings saved");
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field, f.message])));
      toast("error", (e as Error).message);
    },
  });
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; message: string }>("/settings/email/test", { method: "POST", body: { to: testTo, settings: toBody(draft!) } }),
    onSuccess: (r) => toast(r.ok ? "success" : "error", r.ok ? r.message : `Test failed: ${r.message}`),
    onError: (e: Error) => toast("error", e.message),
  });

  if (settings.isLoading || !draft) return settings.error ? <ErrorMessage error={settings.error} /> : <Spinner />;
  const s = settings.data!;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  // Fill server, port, SSL and From from the mailbox address (its domain's mail service).
  const detectFrom = async (email: string) => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return;
    setDetecting(true);
    try {
      const r = await api<{ found: boolean; provider?: string; smtpHost?: string; smtpPort?: number; smtpSecure?: boolean; passwordHint?: string }>(
        `/settings/email/detect?email=${encodeURIComponent(email.trim())}`,
      );
      if (!r.found) {
        setDetected(`Could not tell which mail service ${email.split("@")[1]} uses: choose a Provider or enter the server.`);
        return;
      }
      setDraft((d) => d && {
        ...d,
        smtpHost: r.smtpHost!,
        smtpPort: String(r.smtpPort),
        smtpSecure: r.smtpSecure!,
        smtpFrom: !d.smtpFrom || d.smtpFrom === settings.data?.smtpFrom ? email.trim() : d.smtpFrom,
      });
      setDetected(`${r.provider}: server, port and SSL filled in. ${r.passwordHint ?? ""}`);
    } catch {
      setDetected(null);
    } finally {
      setDetecting(false);
    }
  };
  const env = (k: string) => (s.fromEnvironment.includes(k) ? "From the server environment until saved here. " : "");
  const field = (k: keyof Draft & string, label: string, hint?: string, props: Record<string, unknown> = {}) => (
    <Field label={label} hint={`${env(k)}${hint ?? ""}` || undefined} error={errors[k]}>
      {(id, d) => (
        <Input id={id} aria-describedby={d} value={draft[k] as string} invalid={!!errors[k]} onChange={(e) => set(k, e.target.value as never)} {...props} />
      )}
    </Field>
  );
  const ready = Boolean(s.smtpHost && s.publicUrl);

  return (
    <div className="space-y-5">
      <form
        className="space-y-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className={`rounded-md border px-4 py-3 text-sm ${ready ? "border-good/40 bg-good/10" : "border-warn/40 bg-warn/15"}`}>
          {ready
            ? "Email is set up: alerts, invitations, email confirmation and password reset are sent through this mail server."
            : "Email is not set up yet. Until it is, Create account and Forgot password are hidden on the sign-in page, and invitation links must be copied by hand."}
        </div>

        <Card title="Dashboard address">
          <div className="p-4">
            {field("publicUrl", "Address people open the dashboard at", "Used for the links in emails, such as https://cctv.example.com. Filled in automatically from the server's address when empty.", { inputMode: "url", placeholder: "https://cctv.example.com" })}
            {draft.publicUrl.trim() !== window.location.origin && !openedAtLocalhost && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
                {s.publicUrl ? "You opened this page at" : "Not set yet. You opened this page at"} <code>{window.location.origin}</code>
                <Button size="sm" onClick={() => set("publicUrl", window.location.origin)}>Use this address</Button>
              </div>
            )}
          </div>
        </Card>

        <Card title="Mail server (SMTP)">
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              {detected && <p className="mb-3 rounded-md border border-line bg-raised px-3 py-2 text-sm">{detected}</p>}
            <Field label="Provider" hint="Optional: the server, port and SSL below are also filled in from the Username.">
                {(id, d) => (
                  <Select
                    id={id}
                    aria-describedby={d}
                    value=""
                    onChange={(e) => {
                      const p = PRESETS.find((x) => x.key === e.target.value);
                      if (p && "host" in p) setDraft({ ...draft, smtpHost: p.host, smtpPort: String(p.port), smtpSecure: p.secure });
                    }}
                  >
                    {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </Select>
                )}
              </Field>
            </div>
            {field("smtpHost", "Server", undefined, { placeholder: "smtp.zoho.com", autoComplete: "off" })}
            {field("smtpPort", "Port", "465 with SSL/TLS, or 587 with STARTTLS.", { inputMode: "numeric" })}
            <div className="sm:col-span-2">
              <Checkbox
                label="Use SSL/TLS from the start (port 465)"
                description="Turn off for port 587, where the connection is upgraded with STARTTLS."
                checked={draft.smtpSecure}
                onChange={(e) => set("smtpSecure", e.target.checked)}
              />
            </div>
            {field("smtpUser", "Username (mailbox address)", detecting ? "Looking up the mail service…" : "The full email address of the sending mailbox. Server, port and SSL are filled in from it.", {
              autoComplete: "off",
              type: "email",
              onBlur: (e: { target: { value: string } }) => void detectFrom(e.target.value),
            })}
            <Field
              label="Password"
              hint={draft.removePassword ? "The saved password will be removed." : s.smtpPasswordSet ? "A password is saved. Leave blank to keep it." : `${env("smtpPassword")}For Zoho Mail or Gmail with two-factor sign-in, use an app password.`}
              error={errors.smtpPassword}
            >
              {(id, d) => (
                <div className="flex gap-2">
                  <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" disabled={draft.removePassword} placeholder={s.smtpPasswordSet ? "••••••••" : ""} value={draft.smtpPassword} onChange={(e) => set("smtpPassword", e.target.value)} />
                  {s.smtpPasswordSet && (
                    <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, removePassword: !draft.removePassword, smtpPassword: "" })}>
                      {draft.removePassword ? "Keep" : "Remove"}
                    </Button>
                  )}
                </div>
              )}
            </Field>
            <div className="sm:col-span-2">{field("smtpFrom", "Send as (From address)", "Many providers only accept the mailbox you sign in with.", { type: "email" })}</div>
          </div>
          <div className="flex flex-wrap items-end gap-2 border-t border-line p-4">
            <div className="min-w-[16rem] flex-1">
              <Field label="Send a test email to" hint="Uses the values on this page, saved or not.">
                {(id, d) => <Input id={id} aria-describedby={d} type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />}
              </Field>
            </div>
            <Button icon={<Send className="h-4 w-4" />} loading={test.isPending} disabled={!testTo.includes("@") || !draft.smtpHost.trim()} onClick={() => test.mutate()}>
              Send test
            </Button>
          </div>
        </Card>

        <Card title="Sign-in">
          <div className="grid gap-4 p-4 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Checkbox
                label="Let people create an account"
                description="They confirm their email address and see nothing until an organization invites them. When off, people join only through invitations."
                checked={draft.allowSignup}
                onChange={(e) => set("allowSignup", e.target.checked)}
              />
            </div>
            {field("invitationExpiryHours", "Invitations expire after (hours)", undefined, { inputMode: "numeric" })}
            {field("emailVerificationExpiryHours", "Email confirmation links expire after (hours)", undefined, { inputMode: "numeric" })}
            {field("passwordResetExpiryMinutes", "Password reset links expire after (minutes)", undefined, { inputMode: "numeric" })}
          </div>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={save.isPending}>Save settings</Button>
        </div>
      </form>
    </div>
  );
}
