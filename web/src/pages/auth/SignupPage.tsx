import { MailCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { Button, ErrorMessage, Field, Input } from "../../components/ui";
import { useAuth } from "../../hooks/auth";
import { AuthLayout, authLink, BackToSignIn, useSignInOptions } from "./AuthLayout";
import { ProviderButtons } from "./ProviderButtons";

interface SignupProps {
  /** From an invitation: the address is fixed and the account joins that organization at once. */
  invitationToken?: string;
  invitedEmail?: string;
  onSignedIn?: () => void;
}

/** Name, email, username and password. Says "check your email" when the address must be confirmed. */
export function SignupForm({ invitationToken, invitedEmail, onSignedIn }: SignupProps) {
  const { refresh } = useAuth();
  const [form, setForm] = useState({ displayName: "", email: invitedEmail ?? "", username: "", password: "", confirm: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const fieldError = (f: string) => (error instanceof ApiError ? error.fieldErrors.find((e) => e.field === f)?.message : undefined);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError(new Error("The passwords do not match"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: "signed_in" | "verification_sent" }>("/auth/signup", {
        method: "POST",
        body: { username: form.username, displayName: form.displayName || undefined, email: form.email, password: form.password, invitationToken },
      });
      if (r.status === "signed_in") {
        await refresh();
        onSignedIn?.();
      } else setSentTo(form.email);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) return <CheckEmail email={sentTo} />;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Your name">{(id) => <Input id={id} autoComplete="name" value={form.displayName} onChange={set("displayName")} autoFocus />}</Field>
      <Field label="Email" required error={fieldError("email")} hint={invitedEmail ? "The invitation was sent to this address" : undefined}>
        {(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="email" required readOnly={!!invitedEmail} value={form.email} onChange={set("email")} invalid={!!fieldError("email")} />}
      </Field>
      <Field label="Username" required hint="Letters, numbers, dot, dash and underscore" error={fieldError("username")}>
        {(id, d) => <Input id={id} aria-describedby={d} autoComplete="username" required value={form.username} onChange={set("username")} invalid={!!fieldError("username")} />}
      </Field>
      <Field label="Password" required hint="At least 10 characters" error={fieldError("password")}>
        {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" required value={form.password} onChange={set("password")} invalid={!!fieldError("password")} />}
      </Field>
      <Field label="Confirm password" required>
        {(id) => <Input id={id} type="password" autoComplete="new-password" required value={form.confirm} onChange={set("confirm")} />}
      </Field>
      <ErrorMessage error={error instanceof ApiError && error.fieldErrors.length ? null : error} />
      <Button type="submit" variant="primary" className="w-full" loading={busy}>Create account</Button>
    </form>
  );
}

/** After creating an account: confirm the address before signing in. */
export function CheckEmail({ email }: { email: string }) {
  const options = useSignInOptions();
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start gap-3 rounded-md border border-line bg-raised p-3">
        <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
        <p>
          We sent a confirmation link to <strong>{email}</strong>. Open it to finish creating your account; you can sign in after that.
        </p>
      </div>
      <p className="text-ink-secondary">The link expires in {options.data?.emailVerificationExpiryHours ?? 24} hours. Not there? Check spam, or send it again.</p>
      <ResendVerification email={email} />
    </div>
  );
}

export function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  return state === "sent" ? (
    <p className="text-sm text-ink-secondary">If {email} is waiting for confirmation, a new link is on its way.</p>
  ) : (
    <Button
      variant="secondary"
      className="w-full"
      loading={state === "busy"}
      onClick={() => {
        setState("busy");
        void api("/auth/resend-verification", { method: "POST", body: { email } }).finally(() => setState("sent"));
      }}
    >
      Send the confirmation link again
    </Button>
  );
}

export function SignupPage() {
  const options = useSignInOptions();
  const navigate = useNavigate();
  const setup = options.data?.needsSetup;
  if (options.data && !options.data.signupEnabled) {
    return (
      <AuthLayout title="Create an account" footer={<BackToSignIn />}>
        <p className="text-sm text-ink-secondary">
          Creating accounts is not available on this server. Ask an organization administrator to invite you; the invitation email has a link to create your account.
        </p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title={setup ? "Create the administrator account" : "Create an account"}
      subtitle={setup
        ? "This first account becomes the system administrator, with its own organization."
        : "After confirming your email you can join organizations that invite you."}
      footer={<>Already have an account? <Link to="/" className={authLink}>Sign in</Link></>}
    >
      <ProviderButtons verb="Sign up" />
      <SignupForm onSignedIn={() => navigate("/")} />
    </AuthLayout>
  );
}
