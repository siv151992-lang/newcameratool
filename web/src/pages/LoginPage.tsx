import { Moon, Sun, Video } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button, ErrorMessage, Field, Input } from "../components/ui";
import { useAuth } from "../hooks/auth";
import { useTheme } from "../hooks/theme";

export function LoginPage() {
  const { login } = useAuth();
  const { theme, toggle } = useTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle theme" icon={theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} />
      </div>
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <Video className="h-6 w-6 text-accent" aria-hidden />
          <div>
            <h1 className="text-lg font-semibold">CCTV Storage Monitor</h1>
            <p className="text-sm text-ink-secondary">Sign in to continue</p>
          </div>
        </div>
        <div className="space-y-4">
          <Field label="Username">
            {(id) => <Input id={id} autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />}
          </Field>
          <Field label="Password">
            {(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <ErrorMessage error={error} />
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Sign in
          </Button>
        </div>
      </form>
    </div>
  );
}
