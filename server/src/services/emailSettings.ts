import { z } from "zod";
import { patchOf } from "../lib/validate.js";
import { config } from "../config.js";
import { pool, type Queryable } from "../db/pool.js";
import { getCipher } from "../security/cipher.js";

/**
 * Email and sign-in settings, changed by the system administrator in Settings → Email & sign-in.
 * A value saved there wins; until then the server's environment variables (SMTP_*, PUBLIC_URL,
 * ALLOW_SIGNUP, *_EXPIRY_*) apply. The SMTP password is stored encrypted, like camera passwords,
 * and is never sent back to the browser.
 */

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .url("Enter a full address, such as https://cctv.example.com")
  .refine((v) => /^https?:\/\//i.test(v), "Use an http:// or https:// address")
  .transform((v) => v.replace(/\/+$/, ""));
const optionalText = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable();

export const emailSettingsSchema = patchOf(
  z.object({
    smtpHost: optionalText(253),
    smtpPort: z.number().int().min(1).max(65535),
    smtpSecure: z.boolean(),
    smtpUser: optionalText(254),
    /** Write-only. Omit to keep the saved one; an empty string removes it. */
    smtpPassword: z.string().max(500),
    smtpFrom: z.string().trim().min(3).max(254),
    publicUrl: z.union([httpUrl, z.literal("").transform(() => null), z.null()]),
    allowSignup: z.boolean(),
    invitationExpiryHours: z.number().int().min(1).max(24 * 30),
    emailVerificationExpiryHours: z.number().int().min(1).max(24 * 7),
    passwordResetExpiryMinutes: z.number().int().min(10).max(24 * 60),
  }),
).strict();
export type EmailSettingsPatch = z.infer<typeof emailSettingsSchema>;

export interface EmailSettings {
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFrom: string;
  publicUrl: string | null;
  allowSignup: boolean;
  invitationExpiryHours: number;
  emailVerificationExpiryHours: number;
  passwordResetExpiryMinutes: number;
}
type Key = keyof EmailSettings;

/** What is stored: any subset, with the password encrypted. */
type Stored = Partial<Omit<EmailSettings, "smtpPassword">> & { smtpPasswordEncrypted?: string | null };

const fromEnvironment = (): EmailSettings => ({
  smtpHost: config.SMTP_HOST ?? null,
  smtpPort: config.SMTP_PORT,
  smtpSecure: config.SMTP_SECURE,
  smtpUser: config.SMTP_USER ?? null,
  smtpPassword: config.SMTP_PASSWORD ?? null,
  smtpFrom: config.SMTP_FROM,
  publicUrl: config.PUBLIC_URL?.replace(/\/+$/, "") ?? null,
  allowSignup: config.ALLOW_SIGNUP,
  invitationExpiryHours: config.INVITATION_EXPIRY_HOURS,
  emailVerificationExpiryHours: config.EMAIL_VERIFICATION_EXPIRY_HOURS,
  passwordResetExpiryMinutes: config.PASSWORD_RESET_EXPIRY_MINUTES,
});

async function readStored(db: Queryable = pool): Promise<Stored> {
  const { rows } = await db.query<{ value: Stored }>("SELECT value FROM app_settings WHERE key = 'email'");
  return rows[0]?.value ?? {};
}

function decrypt(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try {
    return getCipher().decrypt(enc);
  } catch {
    return null; // a key change makes it unreadable: treated as no password until saved again
  }
}

function merge(stored: Stored): { settings: EmailSettings; fromEnv: Key[] } {
  const env = fromEnvironment();
  const settings = { ...env };
  const fromEnv: Key[] = [];
  for (const k of Object.keys(env) as Key[]) {
    if (k === "smtpPassword") {
      if ("smtpPasswordEncrypted" in stored) settings.smtpPassword = decrypt(stored.smtpPasswordEncrypted);
      else if (env.smtpPassword) fromEnv.push(k);
    } else if (k in stored) {
      (settings as Record<string, unknown>)[k] = stored[k as keyof Stored];
    } else if (env[k] !== null) fromEnv.push(k);
  }
  return { settings, fromEnv };
}

// Every account email and alert reads these: cache briefly. Other processes see a change within the TTL.
const TTL_MS = 15_000;
let cache: { at: number; value: EmailSettings } | undefined;

export async function getEmailSettings(): Promise<EmailSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = merge(await readStored()).settings;
  cache = { at: Date.now(), value };
  return value;
}

export function clearEmailSettingsCache() {
  cache = undefined;
}

/** For the settings page: no password, and which values still come from the environment. */
export async function emailSettingsView() {
  const { settings, fromEnv } = merge(await readStored());
  const { smtpPassword, ...rest } = settings;
  return { ...rest, smtpPasswordSet: Boolean(smtpPassword), fromEnvironment: fromEnv };
}

export async function updateEmailSettings(patch: EmailSettingsPatch, userId: string | null) {
  const stored = await readStored();
  const { smtpPassword, ...values } = patch;
  const next: Stored = { ...stored, ...values };
  if (smtpPassword !== undefined) next.smtpPasswordEncrypted = smtpPassword === "" ? null : getCipher().encrypt(smtpPassword);
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ('email', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(next), userId],
  );
  clearEmailSettingsCache();
  return emailSettingsView();
}
