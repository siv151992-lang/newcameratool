import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearInsightsCache, getFleetInsights } from "../../src/ai/insightsService.js";
import { runTool } from "../../src/ai/tools.js";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { createCamera } from "../../src/services/cameraService.js";
import { createTestUser, PASSWORD, prepareDb, resetData, testOrgId } from "../helpers.js";

const app = createApp();
const TOTAL = 128_000_000_000;

async function signIn(role: "admin" | "operator" | "viewer") {
  const { username } = await createTestUser(role);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  // Settings are locked until the password is entered again: open them, as a user would.
  await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", res.body.csrfToken).send({ password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

/** A camera with `hours` of hourly storage history growing `perDay` points per day up to `nowPct`. */
async function cameraWithHistory(name: string, host: string, nowPct: number, perDay: number, hours = 72) {
  const actor = await createTestUser("admin", `seed-${name.toLowerCase().replace(/\W/g, "")}`);
  const id = await createCamera(
    testOrgId,
    {
      name, host, port: 80, protocol: "http", brand: "hikvision", model: null, location: "Office", username: "admin",
      password: "Secret-Cam-Pass-1", monitoringEnabled: true, warningThreshold: null, criticalThreshold: null, caCertificate: null,
    },
    actor,
  );
  for (let i = hours; i >= 0; i--) {
    const pct = nowPct - (perDay * i) / 24;
    await pool.query(
      `INSERT INTO storage_checks (camera_id, checked_at, trigger, outcome, duration_ms, attempts, storage_health,
                                   total_bytes, used_bytes, free_bytes, used_percentage, recording_state)
       VALUES ($1, now() - make_interval(hours => $2), 'scheduled', 'success', 100, 1, 'healthy', $3, $4, $5, $6, 'recording')`,
      [id, i, TOTAL, Math.round((pct / 100) * TOTAL), Math.round(((100 - pct) / 100) * TOTAL), pct],
    );
  }
  await pool.query(
    `UPDATE camera_status SET connection_status = 'online', storage_health = 'healthy', recording_state = 'recording',
            used_percentage = $2, total_bytes = $3, used_bytes = $4, free_bytes = $5, last_success_at = now()
     WHERE camera_id = $1`,
    [id, nowPct, TOTAL, Math.round((nowPct / 100) * TOTAL), Math.round(((100 - nowPct) / 100) * TOTAL)],
  );
  return id;
}

beforeAll(prepareDb);
beforeEach(async () => {
  await resetData();
  clearInsightsCache();
});

describe("AI Mode API", () => {
  it("reports status, and AI Mode can be switched off by an administrator only", async () => {
    const admin = await signIn("admin");
    const status = await admin.agent.get("/api/ai/status").expect(200);
    expect(status.body).toMatchObject({ enabled: true, assistant: { available: false, model: "claude-opus-5-5" } });
    expect(status.body.assistant.reason).toMatch(/ANTHROPIC_API_KEY/);

    const viewer = await signIn("viewer");
    await viewer.agent.patch("/api/ai/settings").set("X-CSRF-Token", viewer.csrf).send({ enabled: false }).expect(403);
    await admin.agent.patch("/api/ai/settings").set("X-CSRF-Token", admin.csrf).send({ enabled: false }).expect(200);
    const off = await admin.agent.get("/api/ai/insights").expect(403);
    expect(off.body.error.code).toBe("AI_DISABLED");
    // Regular monitoring endpoints are unaffected.
    await admin.agent.get("/api/cameras/summary").expect(200);
    await admin.agent.patch("/api/ai/settings").set("X-CSRF-Token", admin.csrf).send({ enabled: true }).expect(200);
    await admin.agent.get("/api/ai/insights").expect(200);
  });

  it("forecasts from stored history and returns chart series with actual and projected points", async () => {
    const id = await cameraWithHistory("Office Camera 03", "10.10.15.3", 84, 2);
    await cameraWithHistory("Lobby", "10.10.15.4", 40, 0.1);
    const { agent } = await signIn("viewer");

    const insights = await agent.get("/api/ai/insights").expect(200);
    const office = insights.body.cameras.find((c: { camera: { id: string } }) => c.camera.id === id);
    expect(office.forecast).toMatchObject({ status: "growing", daysToWarning: 0, daysToCritical: 3 });
    expect(office.forecast.growthPercentPerDay).toBeCloseTo(2, 1);
    expect(office.actions[0]).toMatchObject({ priority: "high", cameraName: "Office Camera 03" });
    expect(insights.body.summary).toMatchObject({ cameras: 2, criticalWithin7Days: 1 });
    expect(JSON.stringify(insights.body)).not.toContain("Secret-Cam-Pass-1");

    const f = await agent.get(`/api/ai/cameras/${id}/forecast?days=7`).expect(200);
    expect(f.body.actual.length).toBeGreaterThan(70);
    expect(f.body.projected[0].usedPercentage).toBeCloseTo(84, 0);
    expect(f.body.projected.at(-1).usedPercentage).toBeGreaterThan(84);
    await agent.get("/api/ai/cameras/00000000-0000-0000-0000-000000000000/forecast").expect(404);
  });

  it("builds a report without any AI service, and the assistant explains it is not configured", async () => {
    await cameraWithHistory("Office Camera 03", "10.10.15.3", 84, 2);
    const { agent, csrf } = await signIn("operator");
    const report = await agent.get("/api/ai/report?period=7d").expect(200);
    expect(report.body.title).toMatch(/last 7 days/);
    expect(report.body.forecasts[0]).toMatchObject({ name: "Office Camera 03", daysToCritical: 3 });
    expect(report.body.markdown).toContain("## Storage forecast (estimated)");
    expect(report.body.markdown).toMatch(/\[Office Camera 03\]\(\/cameras\/[0-9a-f-]+\)/);
    await agent.get("/api/ai/report?period=1y").expect(400);

    const chat = await agent.post("/api/ai/assistant").set("X-CSRF-Token", csrf)
      .send({ messages: [{ role: "user", content: "Which cameras are offline?" }] }).expect(503);
    expect(chat.body.error.code).toBe("AI_UNAVAILABLE");
    await agent.post("/api/ai/assistant").set("X-CSRF-Token", csrf).send({ messages: [] }).expect(400);
  });
});

describe("assistant tools against the database", () => {
  it("return alerts, incidents and connection history without any credential", async () => {
    const id = await cameraWithHistory("Entrance Camera 07", "10.10.15.7", 50, 1);
    await pool.query("INSERT INTO connection_events (camera_id, from_status, to_status, reason) VALUES ($1, 'online', 'offline', 'Timed out')", [id]);
    const { rows } = await pool.query(
      `INSERT INTO alerts (camera_id, type, severity, status, title, description) VALUES ($1, 'offline', 'critical', 'active', 'Camera offline', 'No response') RETURNING id`,
      [id],
    );
    await pool.query("INSERT INTO alert_events (alert_id, event_type, severity, message) VALUES ($1, 'opened', 'critical', 'Camera offline')", [rows[0].id]);

    const ctx = { permissions: ["cameras:read", "alerts:read"], organizationId: testOrgId, now: Date.now(), insights: () => getFleetInsights(testOrgId, { fresh: true }) };
    const alerts = JSON.parse((await runTool("get_alerts", { severity: "critical" }, ctx)).content);
    expect(alerts.alerts[0]).toMatchObject({ title: "Camera offline", camera: { name: "Entrance Camera 07", ip: "10.10.15.7" } });

    const incidents = JSON.parse((await runTool("get_incidents", { since_hours: 24 }, ctx)).content);
    expect(incidents.alertEvents[0]).toMatchObject({ event: "opened", title: "Camera offline" });
    expect(incidents.connectionChanges[0]).toMatchObject({ to: "offline", reason: "Timed out" });

    const details = JSON.parse((await runTool("get_camera_details", { camera: "10.10.15.7" }, ctx)).content);
    expect(details.recentConnectionChanges[0]).toMatchObject({ to: "offline" });

    const everything = await Promise.all(
      ["get_fleet_overview", "list_cameras", "get_anomalies", "compare_storage_usage", "get_recommended_actions"].map((t) => runTool(t, {}, ctx)),
    );
    const dump = [alerts, incidents, details, ...everything.map((r) => r.content)].map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
    expect(everything.every((r) => !r.isError)).toBe(true);
    expect(dump).not.toContain("Secret-Cam-Pass-1");
    expect(dump).not.toMatch(/password|v1:[A-Za-z0-9+/=]+:/i);
  });
});
