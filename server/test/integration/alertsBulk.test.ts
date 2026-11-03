import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();

async function signIn(role: "admin" | "viewer" = "admin") {
  const { username } = await createTestUser(role, undefined, undefined, { systemAdmin: role === "admin" });
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

async function camera(agent: request.Agent, csrf: string, host: string) {
  return (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
    .send({ name: `Cam ${host}`, host, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam-Pass-123" }).expect(201)).body.id as string;
}
const alert = async (cameraId: string, type: string, severity: string, status = "active") =>
  String((await pool.query("INSERT INTO alerts (camera_id, type, severity, status, title, description) VALUES ($1, $2, $3, $4, 't', 'd') RETURNING id", [cameraId, type, severity, status])).rows[0].id);
const statusOf = async (id: string) => (await pool.query("SELECT status FROM alerts WHERE id = $1", [id])).rows[0].status;

beforeAll(prepareDb);
beforeEach(resetData);

describe("bulk alert actions", () => {
  it("acknowledges the chosen alerts (active ones only) and records who did it", async () => {
    const { agent, csrf } = await signIn();
    const c1 = await camera(agent, csrf, "10.0.0.1");
    const c2 = await camera(agent, csrf, "10.0.0.2");
    const a = await alert(c1, "auth_failure", "critical");
    const b = await alert(c2, "auth_failure", "critical");
    const done = await alert(c2, "offline", "critical", "acknowledged");
    const r = (await agent.post("/api/alerts/bulk").set("X-CSRF-Token", csrf).send({ action: "acknowledge", ids: [a, b, done], note: "Passwords being reset" }).expect(200)).body;
    expect(r).toEqual({ done: 2, skipped: 1 });
    expect([await statusOf(a), await statusOf(b)]).toEqual(["acknowledged", "acknowledged"]);
    const events = (await pool.query("SELECT event_type, message FROM alert_events WHERE alert_id = $1", [a])).rows;
    expect(events).toEqual([{ event_type: "acknowledged", message: "Passwords being reset" }]);
    const audit = (await pool.query("SELECT details FROM audit_logs WHERE action = 'alert.bulk_acknowledged'")).rows;
    expect(audit[0].details).toMatchObject({ count: 2, note: "Passwords being reset" });
  });

  it("resolves every open alert matching the filters, on all pages, and nothing else", async () => {
    const { agent, csrf } = await signIn();
    const ids: string[] = [];
    for (let i = 1; i <= 30; i++) ids.push(await alert(await camera(agent, csrf, `10.0.1.${i}`), "auth_failure", "critical"));
    const other = await alert(await camera(agent, csrf, "10.0.2.1"), "storage_usage", "warning");
    const r = (await agent.post("/api/alerts/bulk").set("X-CSRF-Token", csrf).send({ action: "resolve", filter: { status: "open", type: "auth_failure" } }).expect(200)).body;
    expect(r).toEqual({ done: 30, skipped: 0 });
    expect(await statusOf(ids[29]!)).toBe("resolved");
    expect(await statusOf(other)).toBe("active");
  });

  it("needs the manage permission, and only touches the organization's own alerts", async () => {
    const admin = await signIn();
    const a = await alert(await camera(admin.agent, admin.csrf, "10.0.3.1"), "offline", "critical");
    const viewer = await signIn("viewer");
    await viewer.agent.post("/api/alerts/bulk").set("X-CSRF-Token", viewer.csrf).send({ action: "acknowledge", ids: [a] }).expect(403);
    await admin.agent.post("/api/alerts/bulk").set("X-CSRF-Token", admin.csrf).send({ action: "acknowledge" }).expect(400);
    await admin.agent.post("/api/alerts/bulk").set("X-CSRF-Token", admin.csrf).send({ action: "acknowledge", ids: [a], filter: {} }).expect(400);
    // Another organization's alert id is not found among this one's: skipped silently, unchanged.
    const r = (await admin.agent.post("/api/alerts/bulk").set("X-CSRF-Token", admin.csrf).send({ action: "resolve", ids: ["999999"] }).expect(200)).body;
    expect(r).toEqual({ done: 0, skipped: 0 });
  });
});
