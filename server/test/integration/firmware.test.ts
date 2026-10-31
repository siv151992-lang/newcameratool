import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
async function signIn() {
  const { username } = await createTestUser("admin", undefined, undefined, { systemAdmin: true });
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

beforeAll(prepareDb);
beforeEach(resetData);

describe("firmware inventory", () => {
  it("groups cameras by model and finds the ones on older firmware than the newest here", async () => {
    const { agent, csrf } = await signIn();
    const add = async (name: string, host: string, model: string | null, firmware: string | null) => {
      const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
        .send({ name, host, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam-Pass-123" }).expect(201)).body.id;
      await pool.query("UPDATE camera_status SET device_model = $2, firmware_version = $3, device_info_at = now() WHERE camera_id = $1", [id, model, firmware]);
      return id;
    };
    await add("Gate", "10.0.0.1", "DS-2CD2143G2-I", "V5.7.3 build 220112");
    const old = await add("Lobby", "10.0.0.2", "DS-2CD2143G2-I", "V5.5.82 build 190220");
    await add("Yard", "10.0.0.3", "DS-2CD2143G2-I", "V5.7.3 build 220112");
    await add("Store", "10.0.0.4", "DS-2CD1023G0E-I", "V5.6.5 build 200316");
    await add("New", "10.0.0.5", null, null);

    const inv = (await agent.get("/api/cameras/firmware").expect(200)).body;
    expect(inv.summary).toEqual({ cameras: 5, unknown: 1, outdated: 1, models: 2, versions: 3 });
    expect(inv.models[0]).toMatchObject({
      model: "DS-2CD2143G2-I", cameras: 3, outdated: 1, newest: "V5.7.3 build 220112",
      versions: [{ version: "V5.7.3 build 220112", cameras: 2 }, { version: "V5.5.82 build 190220", cameras: 1 }],
    });
    const cams = (await agent.get("/api/cameras/firmware/cameras").query({ brand: "hikvision", model: "DS-2CD2143G2-I" }).expect(200)).body;
    expect(cams[0]).toMatchObject({ id: old, name: "Lobby", outdated: true });
    expect(cams.filter((c: { outdated: boolean }) => c.outdated)).toHaveLength(1);
    const unknown = (await agent.get("/api/cameras/firmware/cameras").query({ brand: "hikvision", model: "" }).expect(200)).body;
    expect(unknown).toMatchObject([{ name: "New", firmwareVersion: null, outdated: false }]);

    const csv = (await agent.get("/api/cameras/firmware.csv").expect(200)).text;
    expect(csv).toContain("Lobby,10.0.0.2,,Hikvision,DS-2CD2143G2-I,,V5.5.82 build 190220,V5.7.3 build 220112,Yes");
    expect(csv).toContain("Not read yet");
  });
});
