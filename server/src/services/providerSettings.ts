import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { getCipher } from "../security/cipher.js";

/**
 * OAuth client credentials for "Sign in with Google" and "Sign in with Zoho", set by the system
 * administrator in Settings → Email & sign-in (the GOOGLE_* / ZOHO_* variables are defaults). Client
 * secrets are stored encrypted and never returned to the browser. A provider is offered on the
 * sign-in page when it has both an id and a secret and is not switched off.
 */

export const PROVIDERS = ["google", "zoho"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ProviderCredentials {
  enabled: boolean;
  clientId: string | null;
  clientSecret: string | null;
}

const providerPatch = z
  .object({
    enabled: z.boolean(),
    clientId: z.string().trim().max(300).transform((v) => v || null).nullable(),
    /** Write-only: omit to keep, empty string to remove. */
    clientSecret: z.string().trim().max(500),
  })
  .partial()
  .strict();
export const providerSettingsSchema = z.object({ google: providerPatch, zoho: providerPatch }).partial().strict();

type StoredProvider = { enabled?: boolean; clientId?: string | null; clientSecretEncrypted?: string | null };
type Stored = Partial<Record<Provider, StoredProvider>>;

const env: Record<Provider, { id?: string; secret?: string }> = {
  google: { id: config.GOOGLE_CLIENT_ID, secret: config.GOOGLE_CLIENT_SECRET },
  zoho: { id: config.ZOHO_CLIENT_ID, secret: config.ZOHO_CLIENT_SECRET },
};

async function readStored(): Promise<Stored> {
  const { rows } = await pool.query<{ value: Stored }>("SELECT value FROM app_settings WHERE key = 'sign_in_providers'");
  return rows[0]?.value ?? {};
}

function decrypt(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try {
    return getCipher().decrypt(enc);
  } catch {
    return null;
  }
}

function resolve(p: Provider, stored: Stored): ProviderCredentials & { fromEnvironment: boolean } {
  const s = stored[p] ?? {};
  const clientId = "clientId" in s ? (s.clientId ?? null) : (env[p].id ?? null);
  const clientSecret = "clientSecretEncrypted" in s ? decrypt(s.clientSecretEncrypted) : (env[p].secret ?? null);
  return { enabled: s.enabled ?? true, clientId, clientSecret, fromEnvironment: !("clientId" in s) && Boolean(env[p].id) };
}

let cache: { at: number; value: Stored } | undefined;
const TTL_MS = 15_000;

/** The credentials for `p`, or null when it is not set up or switched off. */
export async function providerCredentials(p: Provider): Promise<ProviderCredentials | null> {
  if (!cache || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), value: await readStored() };
  const c = resolve(p, cache.value);
  return c.enabled && c.clientId && c.clientSecret ? c : null;
}

export async function enabledProviders(): Promise<Provider[]> {
  const out: Provider[] = [];
  for (const p of PROVIDERS) if (await providerCredentials(p)) out.push(p);
  return out;
}

export function clearProviderSettingsCache() {
  cache = undefined;
}

/** For the settings page: ids and switches, whether a secret is saved, never the secret. */
export async function providerSettingsView() {
  const stored = await readStored();
  return Object.fromEntries(
    PROVIDERS.map((p) => {
      const c = resolve(p, stored);
      return [p, { enabled: c.enabled, clientId: c.clientId, clientSecretSet: Boolean(c.clientSecret), fromEnvironment: c.fromEnvironment }];
    }),
  ) as Record<Provider, { enabled: boolean; clientId: string | null; clientSecretSet: boolean; fromEnvironment: boolean }>;
}

export async function updateProviderSettings(patch: z.infer<typeof providerSettingsSchema>, userId: string | null) {
  const stored = await readStored();
  for (const p of PROVIDERS) {
    const change = patch[p];
    if (!change) continue;
    const next: StoredProvider = { ...(stored[p] ?? {}) };
    if (change.enabled !== undefined) next.enabled = change.enabled;
    if (change.clientId !== undefined) next.clientId = change.clientId;
    if (change.clientSecret !== undefined) next.clientSecretEncrypted = change.clientSecret === "" ? null : getCipher().encrypt(change.clientSecret);
    stored[p] = next;
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ('sign_in_providers', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(stored), userId],
  );
  clearProviderSettingsCache();
  return providerSettingsView();
}
