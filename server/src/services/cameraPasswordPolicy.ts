import { z } from "zod";
import { pool, type Queryable } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { getCipher } from "../security/cipher.js";

/**
 * The standard for the cameras' own passwords, per organization. Based on Hikvision and Dahua
 * firmware rules (8+ characters, several character types), ETSI EN 303 645 (no default or
 * guessable passwords) and NIST SP 800-63B (refuse common passwords).
 */

export const cameraPasswordPolicySchema = z
  .object({
    minLength: z.number().int().min(6).max(32),
    /** How many of uppercase, lowercase, number and symbol a password must use. */
    minCharTypes: z.number().int().min(1).max(4),
    /** Refuse default and common passwords, the username, and runs like "1111" or "12345". */
    blockCommon: z.boolean(),
    /** Change the password at least this often; 0 = never due. */
    maxAgeDays: z.number().int().min(0).max(3650),
    /** "warn": save and flag; "block": refuse to save a password that breaks the policy. */
    enforcement: z.enum(["warn", "block"]),
  })
  .strict();
export type CameraPasswordPolicy = z.infer<typeof cameraPasswordPolicySchema>;

export const DEFAULT_CAMERA_PASSWORD_POLICY: CameraPasswordPolicy = { minLength: 8, minCharTypes: 3, blockCommon: true, maxAgeDays: 90, enforcement: "warn" };

export const PASSWORD_ISSUES = ["too_short", "few_char_types", "common", "contains_username", "repetitive"] as const;
export type PasswordIssue = (typeof PASSWORD_ISSUES)[number];

/** Factory defaults and the passwords most often tried against cameras (compared in lower case). */
const COMMON = new Set([
  "12345", "123456", "1234567", "12345678", "123456789", "1234567890", "54321", "654321", "123123", "112233",
  "111111", "000000", "666666", "888888", "999999", "1111", "0000", "admin", "admin1", "admin12", "admin123",
  "admin1234", "admin12345", "admin@123", "admin#123", "administrator", "password", "password1", "password123",
  "password@123", "p@ssw0rd", "p@ssword", "pass", "pass123", "root", "toor", "user", "guest", "default",
  "camera", "ipcam", "hikvision", "hik12345", "hik123456", "dahua", "dahua123", "cpplus", "uniview", "wisenet",
  "4321", "qwerty", "qwerty123", "abc123", "abcd1234", "welcome", "welcome1", "welcome@123", "letmein", "system",
  "service", "support", "supervisor", "meinsm", "ikwd", "jvc", "ubnt", "pass1234", "test", "test123",
]);

const ALPHABETS = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

function isRepetitive(password: string): boolean {
  const p = password.toLowerCase();
  if (/(.)\1{3,}/.test(p)) return true; // aaaa, 1111
  for (const a of ALPHABETS) {
    for (const s of [a, [...a].reverse().join("")]) {
      for (let i = 0; i + 5 <= s.length; i++) if (p.includes(s.slice(i, i + 5))) return true; // 12345, abcde, qwert
    }
  }
  return false;
}

export function charTypes(password: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
}

/** What is wrong with `password` under `policy` (empty: it meets the policy). The age is checked separately. */
export function passwordIssues(password: string, username: string | null | undefined, policy: CameraPasswordPolicy): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  if (password.length < policy.minLength) issues.push("too_short");
  if (charTypes(password) < policy.minCharTypes) issues.push("few_char_types");
  if (policy.blockCommon) {
    const lower = password.toLowerCase();
    if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9@#]/g, ""))) issues.push("common");
    if (username && username.length >= 3 && lower.includes(username.toLowerCase())) issues.push("contains_username");
    if (isRepetitive(password)) issues.push("repetitive");
  }
  return issues;
}

export const ISSUE_MESSAGES: Record<PasswordIssue, (p: CameraPasswordPolicy) => string> = {
  too_short: (p) => `shorter than ${p.minLength} characters`,
  few_char_types: (p) => `uses fewer than ${p.minCharTypes} of uppercase, lowercase, numbers and symbols`,
  common: () => "a default or commonly used password",
  contains_username: () => "contains the username",
  repetitive: () => "has repeated or sequential characters (like 1111 or 12345)",
};

export async function getCameraPasswordPolicy(orgId: string, db: Queryable = pool): Promise<CameraPasswordPolicy> {
  const { rows } = await db.query<{ value: unknown }>(
    "SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'camera_password_policy'",
    [orgId],
  );
  const parsed = cameraPasswordPolicySchema.safeParse({ ...DEFAULT_CAMERA_PASSWORD_POLICY, ...(rows[0]?.value as object | undefined) });
  return parsed.success ? parsed.data : DEFAULT_CAMERA_PASSWORD_POLICY;
}

export async function updateCameraPasswordPolicy(orgId: string, patch: Partial<CameraPasswordPolicy>, userId: string | null) {
  const next = cameraPasswordPolicySchema.parse({ ...(await getCameraPasswordPolicy(orgId)), ...patch });
  await pool.query(
    `INSERT INTO organization_settings (organization_id, key, value, updated_by) VALUES ($1, 'camera_password_policy', $2, $3)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, JSON.stringify(next), userId],
  );
  await refreshPasswordIssues(orgId);
  return next;
}

/** Re-checks stored camera passwords (decrypted in memory only) against their organization's policy. */
export async function refreshPasswordIssues(orgId: string | null = null) {
  const { rows } = await pool.query<{ camera_id: string; organization_id: string; username: string; password_encrypted: string; password_issues: string[] }>(
    `SELECT cr.camera_id, c.organization_id, cr.username, cr.password_encrypted, cr.password_issues
     FROM camera_credentials cr JOIN cameras c ON c.id = cr.camera_id
     WHERE c.deleted_at IS NULL AND ($1::uuid IS NULL OR c.organization_id = $1)`,
    [orgId],
  );
  const policies = new Map<string, CameraPasswordPolicy>();
  let changed = 0;
  for (const r of rows) {
    let policy = policies.get(r.organization_id);
    if (!policy) policies.set(r.organization_id, (policy = await getCameraPasswordPolicy(r.organization_id)));
    let password: string;
    try {
      password = getCipher().decrypt(r.password_encrypted);
    } catch {
      continue; // unreadable with the current key: left as it is
    }
    const issues = passwordIssues(password, r.username, policy);
    if (issues.join() !== r.password_issues.join()) {
      await pool.query("UPDATE camera_credentials SET password_issues = $2 WHERE camera_id = $1", [r.camera_id, issues]);
      changed++;
    }
  }
  if (changed) logger.info({ changed }, "Camera password policy checked");
}

/** SQL: the organization's maximum password age in days (0 = no limit), for cameras c. */
export const MAX_AGE_SQL = `coalesce((SELECT (os.value->>'maxAgeDays')::int FROM organization_settings os
  WHERE os.organization_id = c.organization_id AND os.key = 'camera_password_policy'), ${DEFAULT_CAMERA_PASSWORD_POLICY.maxAgeDays})`;
/** SQL: 'ok' | 'weak' | 'expired' | 'unknown' (no stored password) for cameras c with credentials cr. */
export const PASSWORD_STATUS_SQL = `CASE
  WHEN cr.camera_id IS NULL THEN 'unknown'
  WHEN cardinality(cr.password_issues) > 0 THEN 'weak'
  WHEN ${MAX_AGE_SQL} > 0 AND cr.password_changed_at < now() - make_interval(days => ${MAX_AGE_SQL}) THEN 'expired'
  ELSE 'ok' END`;

/** How many of the organization's cameras meet the policy, have a weak password, or are due a change. */
export async function cameraPasswordCounts(orgId: string): Promise<{ ok: number; weak: number; expired: number }> {
  const { rows } = await pool.query<{ status: string; n: number }>(
    `SELECT ${PASSWORD_STATUS_SQL} AS status, count(*)::int AS n
     FROM cameras c JOIN camera_credentials cr ON cr.camera_id = c.id
     WHERE c.organization_id = $1 AND c.deleted_at IS NULL GROUP BY 1`,
    [orgId],
  );
  const n = (k: string) => rows.find((r) => r.status === k)?.n ?? 0;
  return { ok: n("ok"), weak: n("weak"), expired: n("expired") };
}
