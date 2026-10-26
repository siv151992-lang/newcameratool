import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MockVendorCamera } from "../../src/testing/mockVendor.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

// No Hikvision API (every ISAPI path is 404), ONVIF only: like newer Prama models.
const app = createApp();
const cam = new MockVendorCamera("admin", "Prama-Pass-123", "panasonic");
let port: number;

beforeAll(async () => {
  await prepareDb();
  port = await cam.start();
});
afterAll(() => cam.stop());
beforeEach(() => resetData());

describe("Prama cameras without Hikvision firmware", () => {
  it("are read over ONVIF when the Hikvision API is missing", async () => {
    const { username } = await createTestUser("admin");
    const agent = request.agent(app);
    const csrf = (await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200)).body.csrfToken as string;
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Prama CAM", host: "127.0.0.1", port, protocol: "http", brand: "Prama", username: "admin", password: "Prama-Pass-123" })
      .expect(201)).body.id as string;
    await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    const detail = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(detail.status.lastErrorMessage).toBeNull();
    expect(detail.status.connection).toBe("online");
    expect(detail.status.totalBytes).toBeGreaterThan(0);
    expect(detail.devices[0]).toMatchObject({ name: "SD card", healthStatus: "healthy" });
    expect(detail.device.serialNumber).toBe("ONV0001");
    expect(cam.requests.some((r) => r.path.startsWith("/ISAPI/"))).toBe(true);
    expect(cam.requests.some((r) => r.path.startsWith("/onvif/"))).toBe(true);

    // Recordings are listed and played over ONVIF too.
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const day = (await agent.get(`/api/cameras/${id}/recordings?date=${today}`).expect(200)).body;
    expect(day.segments.length).toBeGreaterThan(0);
  });
});
