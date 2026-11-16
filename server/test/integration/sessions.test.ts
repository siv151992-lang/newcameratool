import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { describeDevice } from "../../src/services/sessionService.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function signIn(username: string, userAgent = CHROME_WIN) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").set("User-Agent", userAgent).send({ username, password: PASSWORD }).expect(200);
  await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", res.body.csrfToken).send({ password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

beforeAll(prepareDb);
beforeEach(async () => {
  await resetData();
  await pool.query("DELETE FROM app_settings WHERE key = 'security'");
});

describe("sessions", () => {
  it("names devices from the browser's description", () => {
    expect(describeDevice(CHROME_WIN)).toBe("Chrome on Windows");
    expect(describeDevice(SAFARI_IPHONE)).toBe("Safari on iPhone / iPad");
    expect(describeDevice(null)).toBe("Unknown device");
  });

  it("lists a person's sessions, signs out another device, then all others", async () => {
    await createTestUser("operator", "op");
    const laptop = await signIn("op");
    const phone = await signIn("op", SAFARI_IPHONE);
    await signIn("op");

    const list = (await laptop.agent.get("/api/auth/sessions").expect(200)).body;
    expect(list.sessions).toHaveLength(3);
    expect(list.sessions[0]).toMatchObject({ current: true, device: "Chrome on Windows" });
    expect(list.idleTimeoutMinutes).toBe(60);
    const phoneSession = list.sessions.find((s: { device: string }) => s.device === "Safari on iPhone / iPad");

    // The session in use is ended with Sign out, not here.
    await laptop.agent.delete(`/api/auth/sessions/${list.sessions[0].id}`).set("X-CSRF-Token", laptop.csrf).expect(400);
    await laptop.agent.delete(`/api/auth/sessions/${phoneSession.id}`).set("X-CSRF-Token", laptop.csrf).expect(204);
    await phone.agent.get("/api/auth/me").expect(401);

    expect((await laptop.agent.post("/api/auth/sessions/sign-out-others").set("X-CSRF-Token", laptop.csrf).expect(200)).body.ended).toBe(1);
    await laptop.agent.get("/api/auth/me").expect(200);
    expect((await laptop.agent.get("/api/auth/sessions")).body.sessions).toHaveLength(1);
  });

  it("lets an Org Admin sign a member out everywhere, but not the super admin", async () => {
    const owner = await createTestUser("admin", "owner", undefined, { systemAdmin: true });
    const op = await createTestUser("operator", "op");
    await createTestUser("admin", "second");
    const opSession = await signIn("op");
    await signIn("owner");
    const second = await signIn("second");

    expect((await second.agent.get(`/api/users/${op.id}/sessions`).expect(200)).body.sessions).toHaveLength(1);
    expect((await second.agent.post(`/api/users/${op.id}/sign-out`).set("X-CSRF-Token", second.csrf).expect(200)).body.ended).toBe(1);
    await opSession.agent.get("/api/auth/me").expect(401);

    const refused = await second.agent.post(`/api/users/${owner.id}/sign-out`).set("X-CSRF-Token", second.csrf).expect(403);
    expect(refused.body.error.code).toBe("SUPER_ADMIN");
    const actions = (await pool.query("SELECT action FROM audit_logs WHERE action IN ('member.signed_out', 'member.change_refused') ORDER BY id")).rows.map((r) => r.action);
    expect(actions).toEqual(["member.signed_out", "member.change_refused"]);
  });

  it("signs out a session not used for longer than the idle limit", async () => {
    const owner = await createTestUser("admin", "owner", undefined, { systemAdmin: true });
    const admin = await signIn("owner");
    await admin.agent.patch("/api/settings/security").set("X-CSRF-Token", admin.csrf).send({ idleTimeoutMinutes: 15 }).expect(200);
    expect((await admin.agent.get("/api/auth/me").expect(200)).body.idleTimeoutMinutes).toBe(15);
    await admin.agent.patch("/api/settings/security").set("X-CSRF-Token", admin.csrf).send({ idleTimeoutMinutes: 5000 }).expect(400);

    await pool.query("UPDATE sessions SET last_seen_at = now() - interval '25 minutes' WHERE user_id = $1", [owner.id]);
    await new Promise((r) => setTimeout(r, 16_000)); // the setting is cached for 15 s
    await admin.agent.get("/api/auth/me").expect(401);
    expect((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [owner.id])).rows[0].n).toBe(0);
  }, 30_000);
});
