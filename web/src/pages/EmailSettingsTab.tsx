import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Send } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import type { EmailSettings } from "../api/types";
import { Button, Card, Checkbox, ErrorMessage, Field, Input, Select, Spinner } from "../components/ui";
import { useToast } from "../components/toast";
import { useAuth } from "../hooks/auth";
import { PROVIDER_LABELS, providerMark, type ProviderKey } from "./auth/ProviderButtons";

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

  useEffect(() => {
    if (settings.data) setDraft(toDraft(settings.data));
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
            {field("publicUrl", "Address people open the dashboard at", "Used for the links in emails, such as https://cctv.example.com.", { inputMode: "url", placeholder: "https://cctv.example.com" })}
          </div>
        </Card>

        <Card title="Mail server (SMTP)">
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Provider" hint="Optional: fills in the server, port and security below.">
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
            {field("smtpUser", "Username", "Usually the full email address of the sending mailbox.", { autoComplete: "off" })}
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
      <SignInProvidersCard />
    </div>
  );
}

interface ProviderView {
  enabled: boolean;
  clientId: string | null;
  clientSecretSet: boolean;
  fromEnvironment: boolean;
}
interface ProvidersResponse {
  providers: Record<ProviderKey, ProviderView>;
  redirectUris: Record<ProviderKey, string | null>;
}

const SETUP: Record<ProviderKey, { console: string; consoleUrl: string; steps: string }> = {
  google: {
    console: "Google Cloud console → APIs & Services → Credentials",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    steps: "Create an OAuth client ID of type Web application and add the redirect address below as an authorized redirect URI.",
  },
  zoho: {
    console: "Zoho API Console",
    consoleUrl: "https://api-console.zoho.com/",
    steps: "Add a Server-based Application with the redirect address below. In its Settings, turn on multi-DC so people in every Zoho data centre (.com, .in, .eu, …) can sign in.",
  },
};

/** Sign in with Google / Zoho: client ID and secret per provider (system administrator). */
function SignInProvidersCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ["settings", "sign-in-providers"], queryFn: () => api<ProvidersResponse>("/settings/sign-in-providers") });
  const [draft, setDraft] = useState<Record<ProviderKey, { enabled: boolean; clientId: string; clientSecret: string }> | null>(null);
  useEffect(() => {
    if (!data.data) return;
    const p = data.data.providers;
    setDraft({
      google: { enabled: p.google.enabled, clientId: p.google.clientId ?? "", clientSecret: "" },
      zoho: { enabled: p.zoho.enabled, clientId: p.zoho.clientId ?? "", clientSecret: "" },
    });
  }, [data.data]);
  const save = useMutation({
    mutationFn: (key: ProviderKey) => {
      const d = draft![key];
      return api<ProvidersResponse>("/settings/sign-in-providers", {
        method: "PATCH",
        body: { [key]: { enabled: d.enabled, clientId: d.clientId, ...(d.clientSecret ? { clientSecret: d.clientSecret } : {}) } },
      });
    },
    onSuccess: (r, key) => {
      qc.setQueryData(["settings", "sign-in-providers"], r);
      void qc.invalidateQueries({ queryKey: ["auth", "options"] });
      toast("success", `Sign in with ${PROVIDER_LABELS[key]} saved`);
    },
    onError: (e: Error) => toast("error", e.message),
  });

  if (!data.data || !draft) return data.error ? <ErrorMessage error={data.error} /> : <Spinner />;
  const { providers, redirectUris } = data.data;

  return (
    <Card title="Sign in with Google and Zoho">
      <div className="divide-y divide-line">
        {(["google", "zoho"] as const).map((key) => {
          const v = providers[key];
          const d = draft[key];
          const set = (patch: Partial<typeof d>) => setDraft({ ...draft, [key]: { ...d, ...patch } });
          const live = v.enabled && v.clientId && v.clientSecretSet && redirectUris[key];
          return (
            <div key={key} className="space-y-4 p-4">
              <div className="flex flex-wrap items-center gap-2">
                {providerMark(key, "h-5 w-5")}
                <span className="font-medium">{PROVIDER_LABELS[key]}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${live ? "bg-good/15" : "bg-line text-ink-secondary"}`}>
                  {live ? "On the sign-in page" : "Not set up"}
                </span>
              </div>
              <p className="text-sm text-ink-secondary">
                In the <a href={SETUP[key].consoleUrl} target="_blank" rel="noreferrer" className="font-medium text-accent-ink hover:underline">{SETUP[key].console}</a>:{" "}
                {SETUP[key].steps}
              </p>
              <Field label="Redirect address" hint={redirectUris[key] ? "Copy this into the provider exactly." : "Save the dashboard address above first."}>
                {(id, h) => (
                  <div className="flex gap-2">
                    <Input id={id} aria-describedby={h} readOnly value={redirectUris[key] ?? ""} onFocus={(e) => e.target.select()} />
                    <Button
                      icon={<Copy className="h-4 w-4" />}
                      disabled={!redirectUris[key]}
                      onClick={() => void navigator.clipboard.writeText(redirectUris[key]!).then(() => toast("success", "Copied"), () => toast("error", "Copy failed: select it and copy"))}
                    >
                      Copy
                    </Button>
                  </div>
                )}
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Client ID" hint={v.fromEnvironment ? "From the server environment until saved here." : undefined}>
                  {(id, h) => <Input id={id} aria-describedby={h} autoComplete="off" value={d.clientId} onChange={(e) => set({ clientId: e.target.value })} />}
                </Field>
                <Field label="Client secret" hint={v.clientSecretSet ? "A secret is saved. Leave blank to keep it." : undefined}>
                  {(id, h) => <Input id={id} aria-describedby={h} type="password" autoComplete="new-password" placeholder={v.clientSecretSet ? "••••••••" : ""} value={d.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} />}
                </Field>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Checkbox label={`Show "Continue with ${PROVIDER_LABELS[key]}" on the sign-in page`} checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                <Button variant="primary" loading={save.isPending && save.variables === key} onClick={() => save.mutate(key)}>Save {PROVIDER_LABELS[key]}</Button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="border-t border-line px-4 py-3 text-xs text-ink-muted">
        People who sign in this way for the first time get an account for their confirmed address: it joins an organization when they were invited, and otherwise
        follows "Let people create an account" above. Someone who already has an account with that address signs in to it.
      </p>
    </Card>
  );
}
