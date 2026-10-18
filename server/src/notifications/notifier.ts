import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { SEVERITY_RANK } from "../monitoring/evaluate.js";
import { EmailDriver } from "./emailDriver.js";
import type { NotificationChannel, NotificationDriver, NotificationEvent } from "./types.js";

export function formatMessage(e: NotificationEvent) {
  const prefix = e.kind === "resolved" ? "RESOLVED" : e.severity.toUpperCase();
  const subject = `[CCTV ${prefix}] ${e.title} – ${e.cameraName} (${e.cameraHost})`;
  const lines = [
    e.kind === "resolved" ? `The following alert has been resolved: ${e.title}` : e.description,
    "",
    `Camera: ${e.cameraName} (${e.cameraHost})`,
    `Alert type: ${e.type}`,
    `Severity: ${e.severity}`,
  ];
  if (config.PUBLIC_URL) lines.push("", `Details: ${config.PUBLIC_URL.replace(/\/$/, "")}/cameras/${e.cameraId}`);
  return { subject, text: lines.join("\n") };
}

/**
 * Sends alert notifications through configured channels with:
 * - a minimum severity per channel
 * - a cooldown per channel + camera + alert type (prevents flooding when a condition flaps)
 * - optional recovery notifications, only for alerts the channel was told about
 * Every attempt is recorded in notification_deliveries.
 */
export class Notifier {
  private readonly drivers = new Map<string, NotificationDriver>();

  constructor(drivers: NotificationDriver[] = [new EmailDriver()]) {
    for (const d of drivers) this.drivers.set(d.type, d);
  }

  driver(type: string) {
    return this.drivers.get(type);
  }

  async dispatch(events: NotificationEvent[]) {
    if (events.length === 0) return;
    const { rows: channels } = await pool.query<NotificationChannel>("SELECT * FROM notification_channels WHERE enabled");
    for (const event of events) {
      for (const channel of channels) {
        await this.deliver(channel, event).catch((err) =>
          logger.error({ err: (err as Error).message, channel: channel.id }, "Notification delivery bookkeeping failed"),
        );
      }
    }
  }

  private async record(channel: NotificationChannel, event: NotificationEvent, status: string, detail?: string) {
    await pool.query(
      "INSERT INTO notification_deliveries (channel_id, alert_id, event, status, detail) VALUES ($1, $2, $3, $4, $5)",
      [channel.id, event.alertId, event.kind, status, detail ?? null],
    );
  }

  private async deliver(channel: NotificationChannel, event: NotificationEvent) {
    if (SEVERITY_RANK[event.severity] < SEVERITY_RANK[channel.min_severity]) return;
    if (event.kind === "resolved") {
      if (!channel.notify_on_recovery) return;
      const told = await pool.query(
        "SELECT 1 FROM notification_deliveries WHERE channel_id = $1 AND alert_id = $2 AND status = 'sent' AND event <> 'resolved' LIMIT 1",
        [channel.id, event.alertId],
      );
      if (!told.rowCount) return;
    } else if (channel.cooldown_minutes > 0) {
      const recent = await pool.query(
        `SELECT 1 FROM notification_deliveries d JOIN alerts a ON a.id = d.alert_id
         WHERE d.channel_id = $1 AND d.status = 'sent' AND d.event <> 'resolved'
           AND a.camera_id = $2 AND a.type = $3 AND d.created_at > now() - make_interval(mins => $4)
         LIMIT 1`,
        [channel.id, event.cameraId, event.type, channel.cooldown_minutes],
      );
      // Escalations to critical always go out; everything else respects the cooldown.
      if (recent.rowCount && !(event.kind === "escalated" && event.severity === "critical")) {
        await this.record(channel, event, "skipped", "cooldown");
        return;
      }
    }
    const driver = this.drivers.get(channel.type);
    if (!driver) {
      await this.record(channel, event, "failed", `No driver for channel type ${channel.type}`);
      return;
    }
    try {
      await driver.send(channel, formatMessage(event));
      await this.record(channel, event, "sent");
    } catch (err) {
      await this.record(channel, event, "failed", (err as Error).message.slice(0, 500));
      logger.warn({ channel: channel.name, err: (err as Error).message }, "Notification failed");
    }
  }
}

export const notifier = new Notifier();
