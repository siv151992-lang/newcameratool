import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();

async function signIn(username: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", res.body.csrfToken).send({ password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

beforeAll(prepareDb);
beforeEach(resetData);

describe("audit log scope", () => {
  it("records refused changes to the super admin and sign-outs, and filters by user and kind of action", async () => {
    const owner = await createTestUser("admin", "owner", undefined, { systemAdmin: true });
    await createTestUser("admin", "second-admin");
    const second = await signIn("second-admin");
    await second.agent.patch(`/api/users/${owner.id}`).set("X-CSRF-Token", second.csrf).send({ role: "viewer" }).expect(403);
    await second.agent.delete(`/api/users/${owner.id}`).set("X-CSRF-Token", second.csrf).expect(403);
    await second.agent.post("/api/auth/logout").set("X-CSRF-Token", second.csrf).expect(204);

    const admin = await signIn("owner");
    const list = async (q: string) => (await admin.agent.get(`/api/audit?pageSize=200${q}`).expect(200)).body as { total: number; items: { action: string; actor_username: string; details: Record<string, unknown> }[] };

    const refused = (await list("&category=users")).items.filter((e) => e.action === "member.change_refused");
    expect(refused.map((e) => e.details.attempt).sort()).toEqual(["remove", "update"]);
    expect(refused.every((e) => e.actor_username === "second-admin")).toBe(true);

    const bySecond = await list("&user=SECOND-ADMIN&category=signin");
    expect(bySecond.items.map((e) => e.action)).toEqual(expect.arrayContaining(["auth.logout", "auth.login", "auth.password_confirmed"]));
    expect(bySecond.items.every((e) => e.actor_username === "second-admin" && e.action.startsWith("auth."))).toBe(true);

    // The CSV export takes the same filters, and records them.
    const csv = await admin.agent.get("/api/audit/export?category=users&timeZone=UTC").expect(200);
    expect(csv.text).toContain("member.change_refused");
    expect(csv.text).not.toContain("auth.login");
    expect((await list("&category=audit")).items[0]!.details).toMatchObject({ category: "users" });

    await admin.agent.get("/api/audit?category=everything").expect(400);
  });
});
