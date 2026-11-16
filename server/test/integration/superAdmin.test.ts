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

describe("usernames and the super admin", () => {
  it("accepts any username without spaces, such as an email address, and signs in with it", async () => {
    await createTestUser("admin", "owner", undefined, { systemAdmin: true });
    const admin = await signIn("owner");
    const add = (username: string, email?: string) =>
      admin.agent.post("/api/users").set("X-CSRF-Token", admin.csrf).send({ username, email, password: PASSWORD, role: "viewer" });
    expect((await add("deepak.k@zohocorphelpdesk.com", "deepak.k@zohocorphelpdesk.com")).status).toBe(201);
    expect((await add("Ravi+ops#1")).status).toBe(201);
    expect((await add("has space")).status).toBe(400);
    expect((await add("tab\tname")).status).toBe(400);
    expect((await add("zero​width")).status).toBe(400);
    // Someone else's email cannot become a username (sign-in would be ambiguous), nor the reverse.
    expect((await add("other", "deepak.k@zohocorphelpdesk.com")).status).toBe(409);
    expect((await add("ops@site.com")).status).toBe(201);
    expect((await add("someone", "ops@site.com")).status).toBe(409);
    await request(app).post("/api/auth/login").send({ username: "deepak.k@zohocorphelpdesk.com", password: PASSWORD }).expect(200);
  });

  it("lets nobody else change the super admin's rights or remove them", async () => {
    const owner = await createTestUser("admin", "owner", undefined, { systemAdmin: true });
    await createTestUser("admin", "second-admin");
    const second = await signIn("second-admin");
    const as = (r: request.Test) => r.set("X-CSRF-Token", second.csrf);

    const list = (await second.agent.get("/api/users").expect(200)).body as { username: string; superAdmin: boolean }[];
    expect(list.find((u) => u.username === "owner")?.superAdmin).toBe(true);
    expect(list.find((u) => u.username === "second-admin")?.superAdmin).toBe(false);

    for (const body of [{ role: "viewer" }, { isActive: false }, { password: "New-Passw0rd-123" }, { displayName: "X" }]) {
      const r = await as(second.agent.patch(`/api/users/${owner.id}`)).send(body).expect(403);
      expect(r.body.error.code).toBe("SUPER_ADMIN");
    }
    await as(second.agent.put(`/api/users/${owner.id}/camera-access`)).send({ mode: "limited", locations: ["Site A"] }).expect(403);
    await as(second.agent.delete(`/api/users/${owner.id}`)).expect(403);

    // The super admin can still manage everyone else, and rename themself.
    const me = await signIn("owner");
    await me.agent.patch(`/api/users/${owner.id}`).set("X-CSRF-Token", me.csrf).send({ displayName: "Owner" }).expect(204);
    await me.agent.patch(`/api/users/${owner.id}`).set("X-CSRF-Token", me.csrf).send({ role: "viewer" }).expect(403);
    const secondId = list.find((u) => u.username === "second-admin") as unknown as { id: string };
    await me.agent.patch(`/api/users/${secondId.id}`).set("X-CSRF-Token", me.csrf).send({ role: "operator" }).expect(204);
  });
});
