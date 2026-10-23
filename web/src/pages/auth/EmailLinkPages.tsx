import { CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { Button, ErrorMessage, Field, Input, Spinner } from "../../components/ui";
import { useAuth } from "../../hooks/auth";
import { AuthLayout, authLink, BackToSignIn, useSignInOptions } from "./AuthLayout";

/** /verify-email?token=… — confirms the address from the emailed link and signs the person in. */
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // the link works once: never send it twice
    started.current = true;
    api("/auth/verify-email", { method: "POST", body: { token: params.get("token") ?? "" } })
      .then(() => refresh())
      .then(() => navigate("/", { replace: true }))
      .catch(setError);
  }, [params, refresh, navigate]);

  return (
    <AuthLayout title="Confirming your email" footer={error ? <BackToSignIn /> : undefined}>
      {error ? <ErrorMessage error={error} /> : <Spinner label="Confirming" />}
    </AuthLayout>
  );
}

/** /forgot-password — emails a reset link (the answer is the same whether or not the address has an account). */
export function ForgotPasswordPage() {
  const options = useSignInOptions();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/forgot-password", { method: "POST", body: { email } });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Reset your password" footer={<BackToSignIn />}>
      {sent ? (
        <p className="text-sm">
          If an account uses <strong>{email}</strong>, we sent it a link to choose a new password. The link works once and expires in {options.data?.passwordResetExpiryMinutes ?? 60} minutes.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-ink-secondary">Enter your account's email address and we'll send you a link to choose a new password.</p>
          <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <ErrorMessage error={error} />
          <Button type="submit" variant="primary" className="w-full" loading={busy}>Send reset link</Button>
        </form>
      )}
    </AuthLayout>
  );
}

/** /reset-password?token=… — sets a new password from the emailed link. */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(new Error("The passwords do not match"));
    setBusy(true);
    setError(null);
    try {
      await api("/auth/reset-password", { method: "POST", body: { token: params.get("token") ?? "", password } });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Choose a new password" footer={<BackToSignIn />}>
      {done ? (
        <div className="space-y-4 text-sm">
          <p className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-good" aria-hidden /> Your password was changed. Every session was signed out.</p>
          <Link to="/" className={authLink}>Sign in with your new password</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="New password" hint="At least 10 characters">
            {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Field label="Confirm new password">{(id) => <Input id={id} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
          <ErrorMessage error={error} />
          <Button type="submit" variant="primary" className="w-full" loading={busy}>Set new password</Button>
        </form>
      )}
    </AuthLayout>
  );
}
