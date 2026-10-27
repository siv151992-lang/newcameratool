import type { AlertType, Severity } from "../monitoring/evaluate.js";

export interface NotificationEvent {
  kind: "opened" | "escalated" | "resolved";
  alertId: number;
  type: AlertType;
  severity: Severity;
  title: string;
  description: string;
  cameraId: string;
  cameraName: string;
  cameraHost: string;
}

export interface NotificationChannel {
  id: string;
  type: "email" | "webhook";
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  min_severity: Severity;
  cooldown_minutes: number;
  notify_on_recovery: boolean;
  /** The channel's secret (a webhook's address), decrypted for sending; never shown. */
  secret?: string | null;
}

export interface NotificationMessage {
  subject: string;
  text: string;
  /** The alert behind the message (absent for a test message). */
  event?: NotificationEvent & { url?: string };
}

/** A delivery mechanism: email, or a webhook (Teams, Slack, Google Chat, generic JSON). */
export interface NotificationDriver {
  readonly type: NotificationChannel["type"];
  /** A config field that is a secret: stored encrypted, never returned, kept when left blank on edit. */
  readonly secretField?: string;
  validateConfig(config: unknown): Record<string, unknown>;
  send(channel: NotificationChannel, message: NotificationMessage): Promise<void>;
}
