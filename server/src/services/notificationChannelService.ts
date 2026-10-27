import { z } from "zod";
import { pool } from "../db/pool.js";
import { HttpError, notFound } from "../lib/errors.js";
import { type Notifier, withSecret } from "../notifications/notifier.js";
import { getCipher } from "../security/cipher.js";
import type { NotificationChannel } from "../notifications/types.js";
import { type Actor, audit } from "./auditService.js";

export const channelInputSchema = z
  .object({
    type: z.enum(["email", "webhook"]),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    config: z.record(z.unknown()),
    minSeverity: z.enum(["info", "warning", "critical"]).default("warning"),
    cooldownMinutes: z.number().int().min(0).max(10080).default(60),
    notifyOnRecovery: z.boolean().default(true),
  })
  .strict();
export const channelUpdateSchema = channelInputSchema.partial().omit({ type: true }).strict();

type StoredChannel = NotificationChannel & { secret_encrypted: string | null };

/** The secret itself is never returned; the view says one is set (and, for an address, its host). */
const toView = (c: StoredChannel) => ({
  id: c.id, type: c.type, name: c.name, enabled: c.enabled, config: c.config,
  minSeverity: c.min_severity, cooldownMinutes: c.cooldown_minutes, notifyOnRecovery: c.notify_on_recovery,
  hasSecret: Boolean(c.secret_encrypted),
});

export async function listChannels(orgId: string) {
  const { rows } = await pool.query<StoredChannel>("SELECT * FROM notification_channels WHERE organization_id = $1 ORDER BY created_at", [orgId]);
  return rows.map(toView);
}

/**
 * Validates a channel's config. A driver's secret field (a webhook's address) is split off to be
 * stored encrypted; left blank on an edit, the stored one is kept. The shown config keeps only the
 * secret's host, so people can tell channels apart.
 */
function validated(notifier: Notifier, type: string, config: unknown, current?: StoredChannel) {
  const driver = notifier.driver(type);
  if (!driver) throw new HttpError(400, "VALIDATION_ERROR", `Unsupported channel type ${type}`);
  const field = driver.secretField;
  let input = config;
  if (field && config && typeof config === "object") {
    const given = (config as Record<string, unknown>)[field];
    if ((given === undefined || given === "") && current?.secret_encrypted) input = { ...config, [field]: withSecret(current).secret };
  }
  let cfg: Record<string, unknown>;
  try {
    cfg = driver.validateConfig(input);
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : "Invalid channel configuration";
    throw new HttpError(400, "VALIDATION_ERROR", msg);
  }
  if (!field) return { config: cfg, secretEncrypted: null };
  const { [field]: secret, ...shown } = cfg;
  const value = String(secret);
  return {
    config: { ...shown, ...(URL.canParse(value) ? { host: new URL(value).host } : {}) },
    secretEncrypted: getCipher().encrypt(value),
    secretChanged: value !== (current ? withSecret(current).secret : null),
  };
}

export async function createChannel(orgId: string, notifier: Notifier, input: z.infer<typeof channelInputSchema>, actor: Actor, ip?: string | null) {
  const v = validated(notifier, input.type, input.config);
  const { rows } = await pool.query<StoredChannel>(
    `INSERT INTO notification_channels (type, name, enabled, config, min_severity, cooldown_minutes, notify_on_recovery, organization_id, secret_encrypted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [input.type, input.name, input.enabled, JSON.stringify(v.config), input.minSeverity, input.cooldownMinutes, input.notifyOnRecovery, orgId, v.secretEncrypted],
  );
  await audit({ actor, ip, action: "notification_channel.created", entityType: "notification_channel", entityId: rows[0]!.id, details: { name: input.name, type: input.type } });
  return toView(rows[0]!);
}

async function getChannel(orgId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("Channel");
  const { rows } = await pool.query<StoredChannel>("SELECT * FROM notification_channels WHERE id = $1 AND organization_id = $2", [id, orgId]);
  if (!rows[0]) throw notFound("Channel");
  return rows[0];
}

export async function updateChannel(
  orgId: string, notifier: Notifier, id: string, patch: z.infer<typeof channelUpdateSchema>, actor: Actor, ip?: string | null,
) {
  const c = await getChannel(orgId, id);
  const v = patch.config ? validated(notifier, c.type, patch.config, c) : { config: c.config, secretEncrypted: c.secret_encrypted, secretChanged: false };
  const { rows } = await pool.query<StoredChannel>(
    `UPDATE notification_channels SET name = $2, enabled = $3, config = $4, min_severity = $5, cooldown_minutes = $6,
            notify_on_recovery = $7, secret_encrypted = $8, updated_at = now() WHERE id = $1 RETURNING *`,
    [
      id, patch.name ?? c.name, patch.enabled ?? c.enabled, JSON.stringify(v.config), patch.minSeverity ?? c.min_severity,
      patch.cooldownMinutes ?? c.cooldown_minutes, patch.notifyOnRecovery ?? c.notify_on_recovery, v.secretEncrypted,
    ],
  );
  const fields = Object.keys(patch).concat("secretChanged" in v && v.secretChanged ? ["webhook address (changed)"] : []);
  await audit({ actor, ip, action: "notification_channel.updated", entityType: "notification_channel", entityId: id, details: { fields } });
  return toView(rows[0]!);
}

export async function deleteChannel(orgId: string, id: string, actor: Actor, ip?: string | null) {
  const c = await getChannel(orgId, id);
  await pool.query("DELETE FROM notification_channels WHERE id = $1", [id]);
  await audit({ actor, ip, action: "notification_channel.deleted", entityType: "notification_channel", entityId: id, details: { name: c.name } });
}

export async function testChannel(orgId: string, notifier: Notifier, id: string) {
  const c = await getChannel(orgId, id);
  const driver = notifier.driver(c.type);
  if (!driver) throw new HttpError(400, "VALIDATION_ERROR", `Unsupported channel type ${c.type}`);
  try {
    await driver.send(withSecret(c), {
      subject: "[CCTV] Test notification",
      text: "This is a test notification from Zoho IBMS CCTV Monitoring. If you received it, the channel works.",
    });
    return { ok: true, message: "Test notification sent" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
