import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { type MailMessage, setMailSender } from "../../src/notifications/mailer.js";
import { createCamera } from "../../src/services/cameraService.js";
import { updateMonitoringSettings } from "../../src/services/settingsService.js";
import {
  buildWeeklyReport,
  getWeeklyReportSettings,
  reportDue,
  sendDueWeeklyReports,
  sendWeeklyReport,
  updateWeeklyReportSettings,
} from "../../src/services/weeklyReportService.js";
import { createTestUser, prepareDb, resetData, testOrgId } from "../helpers.js";

let actor: { id: string; username: string };
let mail: MailMessage[] = [];
let nextHost = 2;

async function camera(name: string, status: { connection: string; recording: string; days: number | null; devices?: number }) {
  const id = await createCamera(
    testOrgId,
    { name, host: `10.0.0.${nextHost++}`, port: 80, protocol: "http", brand: "hikvision", model: null, location: "Wave Building", username: "a", password: "b",
      monitoringEnabled: true, warningThreshold: null, criticalThreshold: null, caCertificate: null },
    actor,
  );
  await pool.query(
    `UPDATE camera_status SET connection_status = $2, recording_state = $3, recording_days = $4, used_percentage = 80, last_success_at = now()
     WHERE camera_id = $1`,
    [id, status.connection, status.recording, status.days],
  );
  for (let i = 0; i < (status.devices ?? 1); i++) {
    await pool.query("INSERT INTO storage_devices (camera_id, vendor_id, name, health_status) VALUES ($1, $2, 'SD card', 'healthy')", [id, `sd${i}`]);
  }
  return id;
}

const emailChannel = (address: string) =>
  pool.query("INSERT INTO notification_channels (type, name, config, organization_id) VALUES ('email', $1, $2, $3)", [address, JSON.stringify({ recipients: [address] }), testOrgId]);

beforeAll(async () => {
  await prepareDb();
  setMailSender(async (m) => void mail.push(m));
});
afterAll(() => setMailSender(undefined));
beforeEach(async () => {
  await resetData();
  mail = [];
  actor = await createTestUser("admin");
});

describe("weekly report", () => {
  it("lists days of recordings (fewest first) and the open problems", async () => {
    await updateMonitoringSettings(testOrgId, { minRecordingDays: 30 }, actor.id);
    await camera("Gate", { connection: "online", recording: "recording", days: 32 });
    const lobby = await camera("Lobby", { connection: "online", recording: "idle", days: 12.5 });
    await camera("Store", { connection: "online", recording: "recording", days: null, devices: 0 });
    await pool.query(
      "INSERT INTO alerts (camera_id, type, severity, status, title, description) VALUES ($1, 'not_recording', 'warning', 'active', 'Camera not recording', 'x')",
      [lobby],
    );

    const r = await buildWeeklyReport(testOrgId, "Asia/Kolkata");
    expect(r.subject).toContain("1 open issue");
    // Fewest days first; the camera without a reading last.
    const order = ["Lobby (10.0.0.3): 12.5 days", "Gate (10.0.0.2): 32.0 days", "Store (10.0.0.4): unknown"].map((l) => r.text.indexOf(l));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(r.text).toContain("Fewer than 30 days of recordings: 1");
    expect(r.text).toContain("Not recording: 1");
    expect(r.text).toContain("SD card missing or in error: 1");
    expect(r.text).toContain("- Camera not recording (warning, 1): Lobby (10.0.0.3)");
    expect(r.html).toContain("Not recording");
    expect(r.html).toContain("No SD card");
    expect(r.csv.split("\n")[0]).toContain("Recordings available (days)");
  });

  it("goes to the email alert addresses, with the camera list attached", async () => {
    await camera("Gate", { connection: "online", recording: "recording", days: 32 });
    await expect(sendWeeklyReport(testOrgId)).rejects.toThrow(/No email addresses/);
    await emailChannel("ops@example.com");
    await emailChannel("guard@example.com");
    const r = await sendWeeklyReport(testOrgId);
    expect(r.sentTo.sort()).toEqual(["guard@example.com", "ops@example.com"]);
    expect(mail).toHaveLength(2);
    expect(mail[0]!.html).toContain("Gate");
    expect(mail[0]!.attachments?.[0]?.filename).toMatch(/^cctv-cameras-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("is sent once on its day and hour, in its time zone", async () => {
    // Monday 9:00 in Kolkata is 03:30 UTC.
    const monday0930 = new Date("2026-11-16T04:00:00Z");
    expect(reportDue({ day: 1, hour: 9, timeZone: "Asia/Kolkata" }, null, monday0930)).toBe("2026-11-16");
    expect(reportDue({ day: 1, hour: 9, timeZone: "Asia/Kolkata" }, "2026-11-16", monday0930)).toBeNull();
    expect(reportDue({ day: 1, hour: 10, timeZone: "Asia/Kolkata" }, null, monday0930)).toBeNull();
    expect(reportDue({ day: 2, hour: 9, timeZone: "Asia/Kolkata" }, null, monday0930)).toBeNull();

    await camera("Gate", { connection: "online", recording: "recording", days: 32 });
    await emailChannel("ops@example.com");
    await updateWeeklyReportSettings(testOrgId, { enabled: true, day: 1, hour: 9, timeZone: "Asia/Kolkata" }, actor.id);
    await sendDueWeeklyReports(new Date("2026-11-16T03:00:00Z")); // 08:30 there: not yet
    expect(mail).toHaveLength(0);
    await sendDueWeeklyReports(monday0930);
    await sendDueWeeklyReports(monday0930);
    expect(mail).toHaveLength(1);
    expect((await getWeeklyReportSettings(testOrgId)).lastSent).toBe("2026-11-16");
    // Changing the schedule keeps the record of the last one sent.
    await updateWeeklyReportSettings(testOrgId, { hour: 8 }, actor.id);
    expect((await getWeeklyReportSettings(testOrgId)).lastSent).toBe("2026-11-16");

    await updateWeeklyReportSettings(testOrgId, { enabled: false }, actor.id);
    await sendDueWeeklyReports(new Date("2026-11-23T04:00:00Z"));
    expect(mail).toHaveLength(1);
  });
});
