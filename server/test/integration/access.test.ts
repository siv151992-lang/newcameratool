import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { registry } from "../../src/integrations/registry.js";
import { runCheck } from "../../src/monitoring/checkService.js";
import { MockBioStar2, MockGallagher, MockHikvisionAccess } from "../../src/testing/mockAccess.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const cert = readFileSync(new URL("../fixtures/camera-self-signed.pem", import.meta.url), "utf8");
const key = readFileSync(new URL("../fixtures/camera-self-signed.key", import.meta.url), "utf8");
const deps = { registry, notifier: { dispatch: async () => undefined }, sleep: async () => undefined };
const hik = new MockHikvisionAccess("admin", "Acs-Pass-123");
const bio = new MockBioStar2("operator", "BioStar-Pass1!");
const ggl = new MockGallagher();
let hikPort: number, bioPort: number, gglPort: number;

async function signIn() {
  const { username } = await createTestUser("admin", undefined, undefined, { systemAdmin: true });
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}
const openAlerts = async (id: string) =>
  (await pool.query("SELECT type, severity, title, description FROM alerts WHERE camera_id = $1 AND status <> 'resolved' ORDER BY type", [id])).rows;

beforeAll(async () => {
  await prepareDb();
  hikPort = await hik.start();
  bioPort = await bio.start(0, "127.0.0.1", { cert, key });
  gglPort = await ggl.start(0, "127.0.0.1", { cert, key });
});
afterAll(async () => {
  await Promise.all([hik.stop(), bio.stop(), ggl.stop()]);
});
beforeEach(resetData);

describe("access control", () => {
  it("reads a Hikvision access controller: doors, readers, tamper and events, apart from the cameras", async () => {
    const { agent, csrf } = await signIn();
    hik.events = [];
    hik.addEvent(5, 1, { name: "Asha Rao", doorNo: 1, at: Date.now() - 60_000 });
    hik.addEvent(5, 9, { doorNo: 2, at: Date.now() - 30_000 });
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Main entrance", host: "127.0.0.1", port: hikPort, protocol: "http", brand: "hikvision-access", username: "admin", password: "Acs-Pass-123" }).expect(201)).body.id;
    await runCheck(id, "manual", deps);

    const cam = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(cam).toMatchObject({ deviceType: "access", localStorage: false, status: { connection: "online" } });
    // Not a camera: not in the camera list or its counts.
    expect((await agent.get("/api/cameras").expect(200)).body.items).toHaveLength(0);
    expect((await agent.get("/api/cameras/summary").expect(200)).body.totalCameras).toBe(0);

    const access = (await agent.get("/api/access").expect(200)).body;
    expect(access.summary).toMatchObject({ systems: 1, readers: 3, readersOffline: 0, doors: 2, doorAlarms: 0, deniedLastDay: 1 });
    const points = (await agent.get(`/api/access/${id}/points`).expect(200)).body;
    expect(points.find((p: { kind: string }) => p.kind === "controller")).toMatchObject({ name: "Main entrance", online: true, tamper: false });
    expect(points.filter((p: { kind: string }) => p.kind === "door")).toMatchObject([{ name: "Door 1", doorState: "closed", lockState: "locked" }, { name: "Door 2" }]);
    const events = (await agent.get("/api/access/events").expect(200)).body;
    expect(events.map((e: { category: string; description: string; person: string | null }) => [e.category, e.description, e.person])).toEqual([
      ["denied", "Unknown card", null],
      ["granted", "Card accepted", "Asha Rao"],
    ]);
    expect(await openAlerts(id)).toEqual([]);

    // A reader unplugged, the controller opened, a door forced (it says so in its log).
    hik.readers[1]!.online = false;
    hik.hostTamper = true;
    hik.doors[0]!.state = "open";
    hik.addEvent(5, 27, { doorNo: 1 });
    await runCheck(id, "manual", deps);
    expect((await openAlerts(id)).map((a) => [a.type, a.severity])).toEqual([
      ["access_offline", "warning"], ["access_tamper", "critical"], ["door_forced", "critical"],
    ]);
    expect((await openAlerts(id)).find((a) => a.type === "door_forced").description).toMatch(/Door 1/);
    // Events already read are not read again.
    expect((await agent.get("/api/access/events").expect(200)).body).toHaveLength(3);

    // Still open at the next check: still forced, though no new event says so.
    await runCheck(id, "manual", deps);
    expect((await openAlerts(id)).map((a) => a.type)).toContain("door_forced");

    hik.readers[1]!.online = true;
    hik.hostTamper = false;
    hik.doors[0]!.state = "closed";
    await runCheck(id, "manual", deps);
    expect(await openAlerts(id)).toEqual([]);
  });

  it("reads Suprema readers through BioStar 2, over HTTPS only", async () => {
    const { agent, csrf } = await signIn();
    const base = { name: "BioStar 2", host: "127.0.0.1", port: bioPort, brand: "suprema-biostar2", username: "operator", password: "BioStar-Pass1!" };
    // The login sends the password itself: plain HTTP is refused.
    const refused = await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...base, protocol: "http" }).expect(400);
    expect(JSON.stringify(refused.body)).toMatch(/HTTPS/);
    bio.events = [];
    bio.addEvent("4865", "544100001", { door: "1", user: "Ravi Kumar", at: Date.now() - 50_000 });
    bio.addEvent("6401", "542200002", { door: "2", at: Date.now() - 40_000 });
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...base, protocol: "https", caCertificate: cert }).expect(201)).body.id;
    const test = (await agent.post(`/api/cameras/${id}/test-connection`).set("X-CSRF-Token", csrf).expect(200)).body;
    expect(test.ok).toBe(true);
    expect(test.steps.find((s: { key: string }) => s.key === "storage").message).toMatch(/3 reader\(s\), 2 door\(s\)/);

    await runCheck(id, "manual", deps);
    const points = (await agent.get(`/api/access/${id}/points`).expect(200)).body;
    expect(points.filter((p: { kind: string }) => p.kind === "reader").map((p: { model: string }) => p.model).sort()).toEqual(["BioEntry P2", "BioEntry W2", "BioStation 3"]);
    const events = (await agent.get(`/api/access/events?systemId=${id}`).expect(200)).body;
    expect(events.map((e: { category: string; person: string | null; point: string }) => [e.category, e.person, e.point])).toEqual([
      ["denied", null, "Server room door"],
      ["granted", "Ravi Kumar", "Lobby door"],
    ]);

    bio.readers[2]!.online = false;
    bio.addEvent("21504", "542200002", { door: "2" });
    bio.addEvent("25344", "544100001");
    await runCheck(id, "manual", deps);
    expect((await openAlerts(id)).map((a) => a.type)).toEqual(["access_offline", "access_tamper", "door_forced"]);
    expect((await openAlerts(id)).find((a) => a.type === "access_offline").description).toMatch(/Car park BioEntry P2/);
    const problems = (await agent.get("/api/access/events?problems=true").expect(200)).body;
    expect(problems.map((e: { description: string }) => e.description)).toEqual(["Tamper on", "Door forced open", "Access denied"]);

    // The door closed and the tamper cleared (both say so in the log), the reader back.
    bio.readers[2]!.online = true;
    bio.addEvent("21248", "542200002", { door: "2" });
    bio.addEvent("25600", "544100001");
    await runCheck(id, "manual", deps);
    expect(await openAlerts(id)).toEqual([]);
    // Logged out after each read.
    expect(bio.requests.some((r) => r.path === "/api/logout")).toBe(true);

    bio.password = "Changed-1!";
    await runCheck(id, "manual", deps);
    const after = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(after.status.lastErrorCode).toBe("AUTH_FAILED");
    bio.password = "BioStar-Pass1!";
  });

  it("reads Gallagher doors, readers and controllers through Command Centre with an API key", async () => {
    const { agent, csrf } = await signIn();
    ggl.events = [];
    ggl.addEvent("Card authorised", "Card Event", "T15 Reader - Reception", { cardholder: "Mei Lin", door: "Reception door", at: Date.now() - 30_000 });
    ggl.addEvent("Card not authorised", "Card Event", "T20 Reader - Warehouse", { door: "Warehouse door", at: Date.now() - 20_000 });
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Command Centre", host: "127.0.0.1", port: gglPort, protocol: "https", brand: "gallagher", password: ggl.apiKey, caCertificate: cert }).expect(201)).body.id;
    await runCheck(id, "manual", deps);
    const points = (await agent.get(`/api/access/${id}/points`).expect(200)).body;
    expect(points.map((p: { kind: string; name: string; online: boolean | null }) => [p.kind, p.name, p.online])).toEqual([
      ["controller", "Control unit - Gate house", true],
      ["controller", "Controller 6000 - Block A", true],
      ["reader", "T15 Reader - Reception", true],
      ["reader", "T20 Reader - Warehouse", true],
      ["door", "Reception door", true],
      ["door", "Warehouse door", true],
    ]);
    const events = (await agent.get(`/api/access/events?systemId=${id}`).expect(200)).body;
    expect(events.map((e: { category: string; person: string | null }) => [e.category, e.person])).toEqual([["denied", null], ["granted", "Mei Lin"]]);

    ggl.controllers[0]!.online = false;
    ggl.readers[0]!.tamper = true;
    ggl.doors[1]!.state = "held_open";
    await runCheck(id, "manual", deps);
    expect((await openAlerts(id)).map((a) => [a.type, a.severity])).toEqual([
      ["access_offline", "warning"], ["access_tamper", "critical"], ["door_held_open", "warning"],
    ]);
    // The API key is never shown.
    const view = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(JSON.stringify(view)).not.toContain(ggl.apiKey);
    ggl.controllers[0]!.online = true;
    ggl.readers[0]!.tamper = false;
    ggl.doors[1]!.state = "closed";

    // Without the RESTStatus licence there is no live status: not reported, rather than guessed.
    ggl.statusLicence = false;
    await runCheck(id, "manual", deps);
    const unlicensed = (await agent.get(`/api/access/${id}/points`).expect(200)).body;
    expect(unlicensed.every((p: { online: boolean | null }) => p.online === null)).toBe(true);
    ggl.statusLicence = true;

    // A refused key says what Command Centre may want (a client certificate by default).
    const realKey = ggl.apiKey;
    ggl.apiKey = "0000-0000-0000-0000-0000-0000-0000-0000";
    await runCheck(id, "manual", deps);
    const refused = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(refused.status.lastErrorMessage).toMatch(/client certificate/);
    ggl.apiKey = realKey;
  });

  it("keeps each organization's access systems to itself", async () => {
    const { agent } = await signIn();
    await agent.get("/api/access/00000000-0000-4000-8000-000000000000/points").expect(404);
    expect((await agent.get("/api/access").expect(200)).body.systems).toEqual([]);
  });
});
