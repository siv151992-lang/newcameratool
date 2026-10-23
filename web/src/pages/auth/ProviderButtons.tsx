import { useSignInOptions } from "./AuthLayout";

export type ProviderKey = "google" | "zoho";
export const PROVIDER_LABELS: Record<ProviderKey, string> = { google: "Google", zoho: "Zoho" };

/** Google's "G" mark, as its sign-in guidelines ask for. */
export function GoogleMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** Four squares in Zoho's colors (not the Zoho logo). */
export function ZohoMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden>
      <rect x="1" y="1" width="8" height="8" rx="1.5" fill="#E42527" />
      <rect x="11" y="1" width="8" height="8" rx="1.5" fill="#089949" />
      <rect x="1" y="11" width="8" height="8" rx="1.5" fill="#226DB4" />
      <rect x="11" y="11" width="8" height="8" rx="1.5" fill="#F9B21D" />
    </svg>
  );
}

export const providerMark = (p: ProviderKey, className?: string) => (p === "google" ? <GoogleMark className={className} /> : <ZohoMark className={className} />);

/**
 * "Continue with Google / Zoho" for the providers set up on the server, then an "or" divider before
 * the form. Each is a plain link: the server sends the browser on to the provider.
 */
export function ProviderButtons({ invitationToken, verb = "Continue" }: { invitationToken?: string; verb?: string }) {
  const options = useSignInOptions();
  const providers = options.data?.providers ?? [];
  if (!providers.length) return null;
  const query = invitationToken ? `?invitation=${encodeURIComponent(invitationToken)}` : "";
  return (
    <div className="mb-5 space-y-2.5">
      {providers.map((p) => (
        <a
          key={p}
          href={`/api/auth/oauth/${p}/start${query}`}
          className="flex h-10 w-full items-center justify-center gap-2.5 rounded-md border border-line-strong bg-raised px-3.5 text-sm font-medium text-ink transition hover:bg-line/40"
        >
          {providerMark(p)}
          {verb} with {PROVIDER_LABELS[p]}
        </a>
      ))}
      <div className="flex items-center gap-3 pt-2 text-xs text-ink-muted">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
    </div>
  );
}
