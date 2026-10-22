import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { Notifier } from "../../src/notifications/notifier.js";
import type { NotificationChannel, NotificationDriver, NotificationEvent } from "../../src/notifications/types.js";
import { createCamera } from "../../src/services/cameraService.js";
import { createTestUser, prepareDb, resetData, testOrgId } from "../helpers.js";

class FakeDriver implements NotificationDriver {
  readonly type = "email" as const;
  sent: { subject: string }[] = [];
  validateConfig(c: unknown) {
    return c as Record<string, unknown>;
  }
  async send(_c: NotificationChannel, m: { subject: string; text: string }) {
    this.sent.push({ subject: m.subject });
  }
}

let cameraId: string;
let alertId: number;
const event = (kind: NotificationEvent["kind"], severity: NotificationEvent["severity"] = "warning"): NotificationEvent => ({
  kind, alertId, type: "storage_usage", severity, title: "Storage usage high", description: "85% used",
  cameraId, cameraName: "Lobby", cameraHost: "10.0.0.5",
});

beforeAll(prepareDb);
beforeEach(async () => {
  await resetData();
  const actor = await createTestUser("admin");
  cameraId = await createCamera(
    testOrgId,
    { name: "Lobby", host: "10.0.0.5", port: 80, protocol: "http", brand: "hikvision", model: null, location: null, username: "a", password: "b",
      monitoringEnabled: true, warningThreshold: null, criticalThreshold: null, caCertificate: null },
    actor,
  );
  alertId = (await pool.query("INSERT INTO alerts (camera_id, type, severity, status, title, description) VALUES ($1, 'storage_usage', 'warning', 'active', 't', 'd') RETURNING id", [cameraId])).rows[0].id;
  await pool.query(
    "INSERT INTO notification_channels (type, name, config, min_severity, cooldown_minutes, notify_on_recovery, organization_id) VALUES ('email', 'IT', '{\"recipients\":[\"it@example.com\"]}', 'warning', 60, true, $1)",
    [testOrgId],
  );
});

describe("Notifier", () => {
  it("applies cooldowns, always sends critical escalations, and sends recovery notices", async () => {
    const driver = new FakeDriver();
    const n = new Notifier([driver]);
    await n.dispatch([event("opened")]);
    await n.dispatch([event("opened")]); // within cooldown
    await n.dispatch([event("escalated", "critical")]);
    await n.dispatch([event("resolved")]);
    expect(driver.sent.map((s) => s.subject)).toEqual([
      "[CCTV WARNING] Storage usage high – Lobby (10.0.0.5)",
      "[CCTV CRITICAL] Storage usage high – Lobby (10.0.0.5)",
      "[CCTV RESOLVED] Storage usage high – Lobby (10.0.0.5)",
    ]);
    const statuses = (await pool.query("SELECT event, status, detail FROM notification_deliveries ORDER BY id")).rows;
    expect(statuses.map((s) => s.status)).toEqual(["sent", "skipped", "sent", "sent"]);
  });

  it("respects minimum severity and skips recovery for alerts never notified", async () => {
    await pool.query("UPDATE notification_channels SET min_severity = 'critical'");
    const driver = new FakeDriver();
    const n = new Notifier([driver]);
    await n.dispatch([event("opened", "warning"), event("resolved", "warning")]);
    expect(driver.sent).toEqual([]);
  });

  it("records failures when the transport fails", async () => {
    const failing: NotificationDriver = { type: "email", validateConfig: (c) => c as Record<string, unknown>, send: async () => { throw new Error("SMTP down"); } };
    await new Notifier([failing]).dispatch([event("opened")]);
    const row = (await pool.query("SELECT status, detail FROM notification_deliveries")).rows[0];
    expect(row).toEqual({ status: "failed", detail: "SMTP down" });
  });
});
