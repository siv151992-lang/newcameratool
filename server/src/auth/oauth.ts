import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "../config.js";
import { pool, withTransaction, type Queryable } from "../db/pool.js";
import { HttpError } from "../lib/errors.js";
import { audit } from "../services/auditService.js";
import { getEmailSettings } from "../services/emailSettings.js";
import { acceptInvitation, invitationForSignup, pendingInvitationsFor } from "../services/invitationService.js";
import { addMember } from "../services/organizationService.js";
import { type Provider, providerCredentials } from "../services/providerSettings.js";
import { createAccount } from "../services/userService.js";
import { hashLinkToken, isLinkToken } from "../security/tokens.js";

/**
 * Sign in with Google or Zoho (OpenID Connect, authorization code flow with PKCE). The callback
 * checks the single-use state (bound to this browser by a cookie), exchanges the code, and verifies
 * the ID token's signature, issuer, audience, expiry and nonce before trusting its email address.
 *
 * Zoho keeps accounts in several data centres (zoho.com, .eu, .in, …). Sign-in starts at
 * accounts.zoho.com, which sends the person to their own data centre; the callback names it
 * ("accounts-server") and only the known Zoho data centres are accepted.
 */

interface Endpoints {
  authorize: string;
  token: string;
  jwks: string;
  issuers: string[];
  scope: string;
  extraParams?: Record<string, string>;
}

/** Exported so tests can point them at a simulated provider. */
export const PROVIDER_ENDPOINTS: Record<Provider, Endpoints> = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    scope: "openid email profile",
    extraParams: { prompt: "select_account" },
  },
  zoho: {
    authorize: "https://accounts.zoho.com/oauth/v2/auth",
    // Per data centre: <accounts-server>/oauth/v2/token and /oauth/v2/keys, issuer <accounts-server>.
    token: "/oauth/v2/token",
    jwks: "/oauth/v2/keys",
    issuers: [],
    scope: "openid email profile",
    extraParams: { access_type: "online", prompt: "consent" },
  },
};

/** Zoho data centres whose accounts may sign in. */
export const ZOHO_ACCOUNT_SERVERS = [
  "https://accounts.zoho.com",
  "https://accounts.zoho.eu",
  "https://accounts.zoho.in",
  "https://accounts.zoho.com.au",
  "https://accounts.zoho.jp",
  "https://accounts.zohocloud.ca",
  "https://accounts.zoho.sa",
  "https://accounts.zoho.uk",
  "https://accounts.zoho.com.cn",
];

export const PROVIDER_NAMES: Record<Provider, string> = { google: "Google", zoho: "Zoho" };
const STATE_MINUTES = 10;
const b64url = (b: Buffer) => b.toString("base64url");

/** Where the provider sends people back; it must be registered with the provider exactly. */
export async function redirectUri(provider: Provider): Promise<string | null> {
  const base = (await getEmailSettings()).publicUrl;
  return base ? `${base}/api/auth/oauth/${provider}/callback` : null;
}

/** Providers set up and usable (credentials saved and the dashboard address known). */
export async function availableProviders(): Promise<Provider[]> {
  if (!(await getEmailSettings()).publicUrl) return [];
  const out: Provider[] = [];
  for (const p of ["google", "zoho"] as const) if (await providerCredentials(p)) out.push(p);
  return out;
}

/** Starts a sign-in: stores the state and returns the provider URL and the state for the browser cookie. */
export async function startSignIn(provider: Provider, opts: { linkUserId?: string; invitationToken?: string }) {
  const creds = await providerCredentials(provider);
  const redirect = await redirectUri(provider);
  if (!creds || !redirect) throw new HttpError(404, "PROVIDER_UNAVAILABLE", `Sign in with ${PROVIDER_NAMES[provider]} is not set up on this server.`);
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  await pool.query("DELETE FROM oauth_states WHERE expires_at < now()");
  await pool.query(
    `INSERT INTO oauth_states (state_hash, provider, code_verifier, nonce, link_user_id, invitation_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))`,
    [hashLinkToken(state), provider, verifier, nonce, opts.linkUserId ?? null, isLinkToken(opts.invitationToken) ? opts.invitationToken : null, STATE_MINUTES],
  );
  const e = PROVIDER_ENDPOINTS[provider];
  const url = new URL(e.authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId!,
    redirect_uri: redirect,
    scope: e.scope,
    state,
    nonce,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    ...e.extraParams,
  }).toString();
  return { url: url.toString(), state };
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const jwksFor = (url: string) => {
  let j = jwksCache.get(url);
  if (!j) jwksCache.set(url, (j = createRemoteJWKSet(new URL(url), { timeoutDuration: 10_000 })));
  return j;
};

export interface ProviderProfile {
  provider: Provider;
  subject: string;
  email: string;
  name: string | null;
}

const fail = (code: string, message: string) => new HttpError(400, code, message);

/** Exchanges the code and verifies the ID token. `query` is the callback's query string. */
async function verifyCallback(provider: Provider, query: Record<string, unknown>, stored: { code_verifier: string; nonce: string }): Promise<ProviderProfile> {
  const creds = await providerCredentials(provider);
  const redirect = await redirectUri(provider);
  if (!creds || !redirect) throw fail("PROVIDER_UNAVAILABLE", `Sign in with ${PROVIDER_NAMES[provider]} is not set up on this server.`);
  const e = PROVIDER_ENDPOINTS[provider];
  let tokenUrl = e.token;
  let jwksUrl = e.jwks;
  let issuers = e.issuers;
  if (provider === "zoho") {
    const server = String(query["accounts-server"] ?? "https://accounts.zoho.com").replace(/\/+$/, "");
    if (!ZOHO_ACCOUNT_SERVERS.includes(server)) throw fail("PROVIDER_ERROR", "Zoho answered from an unknown data centre.");
    tokenUrl = server + e.token;
    jwksUrl = server + e.jwks;
    issuers = [server];
  }

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: String(query.code ?? ""),
      redirect_uri: redirect,
      client_id: creds.clientId!,
      client_secret: creds.clientSecret!,
      code_verifier: stored.code_verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw fail("PROVIDER_ERROR", `${PROVIDER_NAMES[provider]} could not be reached. Try again.`);
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!res.ok || !body.id_token) {
    throw fail("PROVIDER_ERROR", `${PROVIDER_NAMES[provider]} refused the sign-in${body.error ? ` (${body.error})` : ""}. Check the client ID, secret and redirect address.`);
  }

  let claims: JWTPayload & { email?: string; email_verified?: boolean | string; nonce?: string; name?: string };
  try {
    ({ payload: claims } = await jwtVerify(body.id_token, jwksFor(jwksUrl), { issuer: issuers, audience: creds.clientId!, clockTolerance: 60 }));
  } catch {
    throw fail("PROVIDER_ERROR", `The ${PROVIDER_NAMES[provider]} sign-in could not be verified.`);
  }
  if (claims.nonce !== stored.nonce) throw fail("PROVIDER_ERROR", `The ${PROVIDER_NAMES[provider]} sign-in could not be verified.`);
  const verified = claims.email_verified === true || claims.email_verified === "true";
  // Zoho only issues addresses it has confirmed; Google says so explicitly.
  if (!claims.sub || !claims.email || (provider === "google" ? !verified : claims.email_verified === false || claims.email_verified === "false")) {
    throw fail("EMAIL_NOT_VERIFIED", `Your ${PROVIDER_NAMES[provider]} account has no confirmed email address.`);
  }
  return { provider, subject: claims.sub, email: claims.email.toLowerCase(), name: typeof claims.name === "string" ? claims.name.slice(0, 120) : null };
}

/** A free username from the email address (alice, alice2, …). */
async function freeUsername(email: string, db: Queryable): Promise<string> {
  const base = (email.split("@")[0]!.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 50) || "user").padEnd(3, "0");
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? base : `${base}${i + 1}`;
    if (!(await db.query("SELECT 1 FROM users WHERE lower(username) = lower($1)", [candidate])).rowCount) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

export type CallbackResult =
  | { kind: "signed_in"; userId: string; organizationId: string | null; created: boolean }
  | { kind: "linked"; userId: string };

/**
 * Handles the callback: signs in the account linked to this provider account, or the account with
 * the same confirmed address (linking it), or creates one (first account on a new installation, an
 * invitation, an open invitation to that address, or when creating accounts is allowed).
 */
export async function completeSignIn(provider: Provider, query: Record<string, unknown>, browserState: string | undefined, ip?: string | null): Promise<CallbackResult> {
  const state = typeof query.state === "string" ? query.state : "";
  if (!state || state !== browserState) throw fail("STATE_MISMATCH", "This sign-in was started in another browser or has expired. Start again.");
  const { rows } = await pool.query(
    "DELETE FROM oauth_states WHERE state_hash = $1 AND provider = $2 RETURNING code_verifier, nonce, link_user_id, invitation_token, expires_at",
    [hashLinkToken(state), provider],
  );
  const stored = rows[0];
  if (!stored || new Date(stored.expires_at) < new Date()) throw fail("STATE_MISMATCH", "This sign-in has expired. Start again.");
  if (query.error) throw fail("PROVIDER_CANCELLED", `${PROVIDER_NAMES[provider]} sign-in was cancelled.`);

  const profile = await verifyCallback(provider, query, stored);
  const method = { method: provider, email: profile.email };

  return withTransaction(async (db) => {
    const linked = await db.query<{ user_id: string }>("SELECT user_id FROM user_identities WHERE provider = $1 AND subject = $2 FOR UPDATE", [provider, profile.subject]);

    // Connecting a provider to the signed-in account.
    if (stored.link_user_id) {
      if (linked.rows[0] && linked.rows[0].user_id !== stored.link_user_id) {
        throw fail("IDENTITY_IN_USE", `This ${PROVIDER_NAMES[provider]} account is already connected to another user.`);
      }
      await db.query(
        `INSERT INTO user_identities (provider, subject, user_id, email, last_used_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email`,
        [provider, profile.subject, stored.link_user_id, profile.email],
      );
      const u = (await db.query("SELECT username FROM users WHERE id = $1", [stored.link_user_id])).rows[0];
      await audit({ actor: { id: stored.link_user_id, username: u.username }, ip, action: "auth.identity_linked", entityType: "user", entityId: stored.link_user_id, details: method, organizationId: null }, db);
      return { kind: "linked" as const, userId: stored.link_user_id };
    }

    let userId: string | undefined = linked.rows[0]?.user_id;
    let created = false;
    if (!userId) {
      // An account with this address: link it, unless nobody ever confirmed that address for it.
      const byEmail = await db.query<{ id: string; pending_verification: boolean }>(
        "SELECT id, pending_verification FROM users WHERE lower(email) = $1 FOR UPDATE",
        [profile.email],
      );
      const existing = byEmail.rows[0];
      if (existing?.pending_verification) {
        // A password sign-up nobody confirmed: the provider proves who owns the address, so it replaces it.
        await db.query("DELETE FROM users WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = $1)", [existing.id]);
      } else if (existing) {
        userId = existing.id;
        await db.query("UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1", [userId]);
      }
    }
    if (!userId) {
      const first = !(await db.query("SELECT 1 FROM users LIMIT 1")).rowCount;
      const invited = stored.invitation_token ? await invitationForSignup(stored.invitation_token, profile.email).then(() => true) : false;
      const openInvitation = (await pendingInvitationsFor(profile.email)).length > 0;
      if (!first && !invited && !openInvitation && !(await getEmailSettings()).allowSignup) {
        throw fail("SIGNUP_DISABLED", `There is no account for ${profile.email}. Ask an organization administrator to invite you.`);
      }
      userId = await createAccount(
        { username: await freeUsername(profile.email, db), displayName: profile.name, email: profile.email, emailVerified: true, isSystemAdmin: first },
        db,
      );
      created = true;
      if (first) {
        const org = (await db.query<{ id: string }>("INSERT INTO organizations (name, created_by) VALUES ($1, $2) RETURNING id", [config.DEFAULT_ORGANIZATION_NAME, userId])).rows[0]!.id;
        await addMember(org, userId, "admin", null, db);
      }
      await audit({ actor: { id: userId, username: profile.email }, ip, action: "auth.signup", entityType: "user", entityId: userId, details: { ...method, firstAccount: first }, organizationId: null }, db);
    }
    await db.query(
      `INSERT INTO user_identities (provider, subject, user_id, email, last_used_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email, last_used_at = now()`,
      [provider, profile.subject, userId, profile.email],
    );
    const user = (await db.query("SELECT username, is_active FROM users WHERE id = $1", [userId])).rows[0];
    if (!user.is_active) throw new HttpError(403, "ACCOUNT_DISABLED", "This account is disabled. Ask an administrator.");

    let organizationId: string | null = null;
    if (stored.invitation_token) {
      organizationId = (await acceptInvitation({ token: stored.invitation_token }, { id: userId, username: user.username }, ip, db)).organizationId;
    }
    await audit({ actor: { id: userId, username: user.username }, ip, action: "auth.login", entityType: "user", entityId: userId, details: method, organizationId: null }, db);
    return { kind: "signed_in" as const, userId, organizationId, created };
  });
}

/** The provider accounts connected to a user (Settings → Account & theme). */
export async function listIdentities(userId: string) {
  const { rows } = await pool.query(
    `SELECT provider, email, created_at AS "connectedAt", last_used_at AS "lastUsedAt" FROM user_identities WHERE user_id = $1 ORDER BY provider`,
    [userId],
  );
  return rows;
}

/** Disconnects a provider, unless it is the only way the account can sign in. */
export async function unlinkIdentity(userId: string, username: string, provider: Provider, ip?: string | null) {
  await withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT (password_hash IS NOT NULL) AS has_password, (SELECT count(*)::int FROM user_identities WHERE user_id = $1) AS identities
       FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!rows[0].has_password && rows[0].identities <= 1) {
      throw new HttpError(400, "LAST_SIGN_IN_METHOD", "Set a password or connect another account first, so you can still sign in.");
    }
    const del = await db.query("DELETE FROM user_identities WHERE user_id = $1 AND provider = $2", [userId, provider]);
    if (!del.rowCount) throw new HttpError(404, "NOT_FOUND", "Not connected");
    await audit({ actor: { id: userId, username }, ip, action: "auth.identity_unlinked", entityType: "user", entityId: userId, details: { method: provider }, organizationId: null }, db);
  });
}
