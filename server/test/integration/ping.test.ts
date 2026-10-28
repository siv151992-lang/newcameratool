import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
let port: number;

async function signIn(role: "admin" | "viewer") {
  const { username } = await createTestUser(role);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

beforeAll(async () => {
  await prepareDb();
  port = await cam.start();
});
afterAll(() => cam.stop());
beforeEach(() => resetData());

describe("pinging a camera", () => {
  it("times connections to its web and RTSP ports, and ICMP where the server may send it", async () => {
    const { agent, csrf } = await signIn("admin");
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Gate", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam-Pass-123" }).expect(201)).body.id;

    const r = (await agent.post(`/api/cameras/${id}/ping`).set("X-CSRF-Token", csrf).expect(200)).body;
    expect(r).toMatchObject({ host: "127.0.0.1", address: "127.0.0.1", reachable: true, portOpen: true });
    expect(r.ports[0]).toMatchObject({ port, label: "HTTP" });
    expect(r.ports[0].times).toHaveLength(4);
    expect(r.ports[0].times.every((t: number | null) => typeof t === "number" && t >= 0)).toBe(true);
    expect(r.ports[1]).toMatchObject({ port: 554, label: "RTSP (video)" });
    expect(r.ports[1].times).toHaveLength(4);
    expect("times" in r.icmp || "unavailable" in r.icmp).toBe(true);
    expect(JSON.stringify(r)).not.toContain("Cam-Pass-123");

    // Camera gone, address still there: refused, so the address answers but no port is open.
    await cam.stop();
    const gone = (await agent.post(`/api/cameras/${id}/ping`).set("X-CSRF-Token", csrf).expect(200)).body;
    expect(gone).toMatchObject({ reachable: true, portOpen: false });
    expect(gone.ports[0]).toMatchObject({ refused: true, times: [null, null, null, null] });
    port = await cam.start(port);
  });

  it("needs the check permission, and only reaches the organization's own cameras", async () => {
    const { agent, csrf } = await signIn("viewer");
    await agent.post("/api/cameras/00000000-0000-4000-8000-000000000000/ping").set("X-CSRF-Token", csrf).expect(403);
    const admin = await signIn("admin");
    await admin.agent.post("/api/cameras/00000000-0000-4000-8000-000000000000/ping").set("X-CSRF-Token", admin.csrf).expect(404);
  });
});
