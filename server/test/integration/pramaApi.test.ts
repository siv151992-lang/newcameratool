import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

// Like a PT-NC361P3-WNAM(D2) on firmware V5.7.19: Hikvision's API renamed /pramaAPI, /ISAPI is 404.
const app = createApp();
const cam = new MockHikvisionCamera("prama", "Prama-Pass-123");
cam.apiRoot = "/pramaAPI";
let port: number;

beforeAll(async () => {
  await prepareDb();
  port = await cam.start();
});
afterAll(() => cam.stop());
beforeEach(() => resetData());

describe("Prama firmware with /pramaAPI", () => {
  it("is read through /pramaAPI, as Hikvision through /ISAPI", async () => {
    const { username } = await createTestUser("admin");
    const agent = request.agent(app);
    const csrf = (await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200)).body.csrfToken as string;
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Prama CAM", host: "127.0.0.1", port, protocol: "http", brand: "Prama", username: "prama", password: "Prama-Pass-123" })
      .expect(201)).body.id as string;
    await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    const detail = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(detail.status.lastErrorMessage, detail.status.lastErrorMessage).toBeNull();
    expect(detail.status.totalBytes).toBeGreaterThan(0);
    expect(detail.status.recording.state).toBe("recording");
    expect(detail.device.model).toBe("SIMULATED-HIKVISION");
    const paths = cam.requests.map((r) => r.path);
    expect(paths).toContain("/pramaAPI/ContentMgmt/Storage");
    // /ISAPI is tried once, then the camera is known to use /pramaAPI.
    const before = paths.filter((p) => p.startsWith("/ISAPI/")).length;
    await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    expect(cam.requests.map((r) => r.path).filter((p) => p.startsWith("/ISAPI/")).length).toBe(before);

    const picture = await agent.get(`/api/cameras/${id}/snapshot`).expect(200);
    expect(picture.headers["content-type"]).toBe("image/jpeg");
  });
});
