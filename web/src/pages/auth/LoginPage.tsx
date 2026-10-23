import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { Button, ErrorMessage, Field, Input } from "../../components/ui";
import { useAuth } from "../../hooks/auth";
import { AuthLayout, authLink, useSignInOptions } from "./AuthLayout";
import { ProviderButtons } from "./ProviderButtons";
import { ResendVerification } from "./SignupPage";

/** Username/email and password. Also used on the invitation page, with `onSignedIn` to accept afterwards. */
export function SignInForm({ onSignedIn, defaultUsername = "" }: { onSignedIn?: () => Promise<void> | void; defaultUsername?: string }) {
  const { login } = useAuth();
  const options = useSignInOptions();
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      await onSignedIn?.();
    } catch (err) {
      setError(err);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };
  const unverified = error instanceof ApiError && error.code === "EMAIL_NOT_VERIFIED";

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Username or email">
        {(id) => <Input id={id} autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!defaultUsername} />}
      </Field>
      <Field label="Password">
        {(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!defaultUsername} />}
      </Field>
      <ErrorMessage error={error} />
      {unverified && username.includes("@") && <ResendVerification email={username} />}
      <Button type="submit" variant="primary" className="w-full" loading={busy}>
        Sign in
      </Button>
      {options.data?.passwordResetEnabled && (
        <div className="text-center text-sm">
          <Link to="/forgot-password" className={authLink}>Forgot your password?</Link>
        </div>
      )}
    </form>
  );
}

export function LoginPage() {
  const options = useSignInOptions();
  // A Google / Zoho sign-in that did not work comes back here with the reason.
  const [params] = useSearchParams();
  const providerError = params.get("signin_error");
  if (options.data?.needsSetup) {
    return (
      <AuthLayout title="Welcome" subtitle="No account exists yet. Create the first one: it becomes the system administrator and gets the first organization.">
        <ProviderButtons />
        <Link to="/signup" className="flex h-9 w-full items-center justify-center rounded-md bg-accent px-3.5 text-sm font-medium text-white hover:brightness-110">
          Create the administrator account
        </Link>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout
      title="Sign in"
      footer={options.data?.signupEnabled && <>New here? <Link to="/signup" className={authLink}>Create an account</Link></>}
    >
      {providerError && <ErrorMessage error={new Error(providerError)} className="mb-4" />}
      <ProviderButtons />
      <SignInForm />
    </AuthLayout>
  );
}
