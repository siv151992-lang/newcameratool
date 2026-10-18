import { z } from "zod";
import { pool } from "../db/pool.js";
import { HttpError, notFound } from "../lib/errors.js";
import type { Notifier } from "../notifications/notifier.js";
import type { NotificationChannel } from "../notifications/types.js";
import { type Actor, audit } from "./auditService.js";

export const channelInputSchema = z
  .object({
    type: z.enum(["email"]),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    config: z.record(z.unknown()),
    minSeverity: z.enum(["info", "warning", "critical"]).default("warning"),
    cooldownMinutes: z.number().int().min(0).max(10080).default(60),
    notifyOnRecovery: z.boolean().default(true),
  })
  .strict();
export const channelUpdateSchema = channelInputSchema.partial().omit({ type: true }).strict();

const toView = (c: NotificationChannel & { created_at?: Date }) => ({
  id: c.id, type: c.type, name: c.name, enabled: c.enabled, config: c.config,
  minSeverity: c.min_severity, cooldownMinutes: c.cooldown_minutes, notifyOnRecovery: c.notify_on_recovery,
});

export async function listChannels() {
  const { rows } = await pool.query<NotificationChannel>("SELECT * FROM notification_channels ORDER BY created_at");
  return rows.map(toView);
}

function validated(notifier: Notifier, type: string, config: unknown) {
  const driver = notifier.driver(type);
  if (!driver) throw new HttpError(400, "VALIDATION_ERROR", `Unsupported channel type ${type}`);
  try {
    return driver.validateConfig(config);
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : "Invalid channel configuration";
    throw new HttpError(400, "VALIDATION_ERROR", msg);
  }
}

export async function createChannel(notifier: Notifier, input: z.infer<typeof channelInputSchema>, actor: Actor, ip?: string | null) {
  const cfg = validated(notifier, input.type, input.config);
  const { rows } = await pool.query<NotificationChannel>(
    `INSERT INTO notification_channels (type, name, enabled, config, min_severity, cooldown_minutes, notify_on_recovery)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.type, input.name, input.enabled, JSON.stringify(cfg), input.minSeverity, input.cooldownMinutes, input.notifyOnRecovery],
  );
  await audit({ actor, ip, action: "notification_channel.created", entityType: "notification_channel", entityId: rows[0]!.id, details: { name: input.name } });
  return toView(rows[0]!);
}

async function getChannel(id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("Channel");
  const { rows } = await pool.query<NotificationChannel>("SELECT * FROM notification_channels WHERE id = $1", [id]);
  if (!rows[0]) throw notFound("Channel");
  return rows[0];
}

export async function updateChannel(notifier: Notifier, id: string, patch: z.infer<typeof channelUpdateSchema>, actor: Actor, ip?: string | null) {
  const c = await getChannel(id);
  const cfg = patch.config ? validated(notifier, c.type, patch.config) : c.config;
  const { rows } = await pool.query<NotificationChannel>(
    `UPDATE notification_channels SET name = $2, enabled = $3, config = $4, min_severity = $5, cooldown_minutes = $6,
            notify_on_recovery = $7, updated_at = now() WHERE id = $1 RETURNING *`,
    [
      id, patch.name ?? c.name, patch.enabled ?? c.enabled, JSON.stringify(cfg), patch.minSeverity ?? c.min_severity,
      patch.cooldownMinutes ?? c.cooldown_minutes, patch.notifyOnRecovery ?? c.notify_on_recovery,
    ],
  );
  await audit({ actor, ip, action: "notification_channel.updated", entityType: "notification_channel", entityId: id, details: { fields: Object.keys(patch) } });
  return toView(rows[0]!);
}

export async function deleteChannel(id: string, actor: Actor, ip?: string | null) {
  const c = await getChannel(id);
  await pool.query("DELETE FROM notification_channels WHERE id = $1", [id]);
  await audit({ actor, ip, action: "notification_channel.deleted", entityType: "notification_channel", entityId: id, details: { name: c.name } });
}

export async function testChannel(notifier: Notifier, id: string) {
  const c = await getChannel(id);
  const driver = notifier.driver(c.type);
  if (!driver) throw new HttpError(400, "VALIDATION_ERROR", `Unsupported channel type ${c.type}`);
  try {
    await driver.send(c, {
      subject: "[CCTV] Test notification",
      text: "This is a test notification from the CCTV Storage Monitor. If you received it, the channel works.",
    });
    return { ok: true, message: "Test notification sent" };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
