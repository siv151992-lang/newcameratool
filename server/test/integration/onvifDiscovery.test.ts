import dgram from "node:dgram";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { parseXAddrs } from "../../src/integrations/onvif/discovery.js";
import { MockVendorCamera } from "../../src/testing/mockVendor.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

// The camera's web port answers 404 to everything; its ONVIF service is on another port, which it
// announces when probed (WS-Discovery on UDP 3702), with an address that is not the one we use.
const app = createApp();
const web = http.createServer((_req, res) => {
  res.statusCode = 404;
  res.end("Not Found");
});
const onvif = new MockVendorCamera("admin", "Prama-Pass-123", "panasonic");
const discovery = dgram.createSocket("udp4");
let webPort: number;
let onvifPort: number;
let probes = 0;

beforeAll(async () => {
  await prepareDb();
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  webPort = (web.address() as AddressInfo).port;
  onvifPort = await onvif.start();
  discovery.on("message", (msg, from) => {
    if (!msg.toString().includes("Probe")) return;
    probes += 1;
    const reply = `<?xml version="1.0"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><e:Body><d:ProbeMatches><d:ProbeMatch><d:XAddrs>http://192.168.50.9:${onvifPort}/onvif/device_service http://[fe80::1]/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>`;
    discovery.send(reply, from.port, from.address);
  });
  await new Promise<void>((r) => discovery.bind(3702, "127.0.0.1", r));
});
afterAll(async () => {
  web.close();
  discovery.close();
  await onvif.stop();
});
beforeEach(() => resetData());

describe("finding a camera's ONVIF service", () => {
  it("reads the device service address from a WS-Discovery reply", () => {
    expect(parseXAddrs("<d:XAddrs>https://10.0.0.5:8443/onvif/device_service http://10.0.0.5/x</d:XAddrs>")).toEqual({ protocol: "https", port: 8443, path: "/onvif/device_service" });
    expect(parseXAddrs("<XAddrs>http://10.0.0.5/onvif/device_service</XAddrs>")).toEqual({ protocol: "http", port: 80, path: "/onvif/device_service" });
    expect(parseXAddrs("<x/>")).toBeUndefined();
  });

  it("asks the camera where ONVIF is when it is not at the camera's address, and uses it (own host only)", async () => {
    const { username } = await createTestUser("admin");
    const agent = request.agent(app);
    const csrf = (await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200)).body.csrfToken as string;
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Prama CAM", host: "127.0.0.1", port: webPort, protocol: "http", brand: "Prama", username: "admin", password: "Prama-Pass-123" })
      .expect(201)).body.id as string;
    await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    const detail = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(probes).toBeGreaterThan(0);
    expect(detail.status.lastErrorMessage, detail.status.lastErrorMessage).toBeNull();
    expect(detail.status.totalBytes).toBeGreaterThan(0);
    expect(detail.device.serialNumber).toBe("ONV0001");
    // Reached at the camera's own address (127.0.0.1), on the port it announced.
    expect(onvif.requests.some((r) => r.path === "/onvif/device_service")).toBe(true);
  });
});
