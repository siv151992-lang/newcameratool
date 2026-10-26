import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

// Like a real camera's: self-signed, and naming "IPC" rather than the address it is reached at.
const cert = readFileSync(new URL("../fixtures/camera-self-signed.pem", import.meta.url), "utf8");
const key = readFileSync(new URL("../fixtures/camera-self-signed.key", import.meta.url), "utf8");
const app = createApp();
const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
let port: number;

beforeAll(async () => {
  await prepareDb();
  port = await cam.start(0, "127.0.0.1", { cert, key });
});
afterAll(() => cam.stop());
beforeEach(() => resetData());

describe("HTTPS cameras with their own certificate", () => {
  it("is online but untrusted until its certificate is fetched and trusted", async () => {
    const { username } = await createTestUser("admin");
    const agent = request.agent(app);
    const csrf = (await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200)).body.csrfToken as string;
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Prama", host: "127.0.0.1", port, protocol: "https", brand: "Prama", username: "admin", password: "Cam-Pass-123" })
      .expect(201)).body.id as string;

    for (let i = 0; i < 4; i++) await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    let detail = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    // Reachable: an untrusted certificate is not "offline".
    expect(detail.status.connection).toBe("online");
    expect(detail.status.lastErrorCode).toBe("TLS_ERROR");
    expect(detail.status.lastErrorMessage).toMatch(/Get the camera's certificate/);

    const fetched = (await agent.post("/api/cameras/tls-certificate").set("X-CSRF-Token", csrf).send({ host: "127.0.0.1", port }).expect(200)).body;
    expect(fetched.fingerprint256).toBe(new X509Certificate(cert).fingerprint256);
    expect(fetched).toMatchObject({ selfSigned: true, subject: expect.stringContaining("CN=IPC") });

    await agent.patch(`/api/cameras/${id}`).set("X-CSRF-Token", csrf).send({ caCertificate: fetched.pem }).expect(200);
    await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    detail = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(detail.status.lastErrorCode).toBeNull();
    expect(detail.status.totalBytes).toBeGreaterThan(0);

    await agent.post("/api/cameras/tls-certificate").set("X-CSRF-Token", csrf).send({ host: "8.8.8.8", port: 443 }).expect(400);
  });
});
