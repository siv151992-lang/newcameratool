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
  type: "email";
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  min_severity: Severity;
  cooldown_minutes: number;
  notify_on_recovery: boolean;
}

/** A delivery mechanism (email today; Slack, Teams, Telegram later). */
export interface NotificationDriver {
  readonly type: NotificationChannel["type"];
  validateConfig(config: unknown): Record<string, unknown>;
  send(channel: NotificationChannel, message: { subject: string; text: string }): Promise<void>;
}
