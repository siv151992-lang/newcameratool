import jpeg from "jpeg-js";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { registry } from "../../src/integrations/registry.js";
import { runCheck } from "../../src/monitoring/checkService.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { MOCK_PICTURE } from "../../src/testing/mockPicture.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
let port: number;
const deps = { registry, notifier: { dispatch: async () => undefined }, sleep: async () => undefined };
const flat = (v: number) => {
  const px = Buffer.alloc(640 * 360 * 4, v);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return Buffer.from(jpeg.encode({ data: px, width: 640, height: 360 }, 85).data);
};
/** The same scene with a little sensor noise: a live camera never sends the same bytes twice. */
const live = (seed: number) => {
  const img = jpeg.decode(MOCK_PICTURE, { useTArray: true, formatAsRGBA: true });
  for (let i = 0; i < img.data.length; i += 4) img.data[i] = Math.max(0, Math.min(255, img.data[i]! + ((i * seed) % 5) - 2));
  return Buffer.from(jpeg.encode({ data: Buffer.from(img.data), width: img.width, height: img.height }, 85).data);
};

async function signIn() {
  const { username } = await createTestUser("admin", undefined, undefined, { systemAdmin: true });
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}
const status = async (id: string) => (await pool.query("SELECT picture_state, picture_detail, picture_error, picture_suspect_count FROM camera_status WHERE camera_id = $1", [id])).rows[0];
const alerts = async (id: string) => (await pool.query("SELECT title, status FROM alerts WHERE camera_id = $1 AND type = 'picture_problem' ORDER BY id", [id])).rows;

beforeAll(async () => {
  await prepareDb();
  cam.recordingStatusApi = false;
  port = await cam.start();
});
afterAll(() => cam.stop());
beforeEach(async () => {
  await resetData();
  cam.picture = MOCK_PICTURE;
});

describe("picture health", () => {
  it("raises an alert for a covered camera seen twice in a row, closes it when the picture is back, and counts it on the dashboard", async () => {
    const { agent, csrf } = await signIn();
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Gate", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam-Pass-123" }).expect(201)).body.id as string;
    for (let i = 1; i <= 4; i++) {
      cam.picture = live(i);
      await runCheck(id, "manual", deps);
    }
    expect(await status(id)).toMatchObject({ picture_state: "ok", picture_error: null });
    // The small (sub stream) picture is the one checked.
    expect(cam.requests.some((r) => r.path === "/ISAPI/Streaming/channels/102/picture")).toBe(true);

    // Covered: once is only a suspicion, twice is a problem.
    cam.picture = flat(20);
    await runCheck(id, "manual", deps);
    expect(await status(id)).toMatchObject({ picture_state: "ok", picture_suspect_count: 1 });
    expect(await alerts(id)).toEqual([]);
    await runCheck(id, "manual", deps);
    expect((await status(id)).picture_state).toBe("blank");
    expect(await alerts(id)).toEqual([{ title: "Picture is blank or covered", status: "active" }]);
    const summary = (await agent.get("/api/cameras/summary").expect(200)).body;
    expect(summary.picture).toEqual({ problems: 1, checked: 1 });
    expect((await agent.get("/api/cameras?status=pictureproblem").expect(200)).body.total).toBe(1);
    const detail = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(detail.status.picture).toMatchObject({ state: "blank", detail: expect.stringMatching(/covered/) });

    // Uncovered: closes by itself.
    cam.picture = live(9);
    await runCheck(id, "manual", deps);
    expect((await status(id)).picture_state).toBe("ok");
    expect(await alerts(id)).toEqual([{ title: "Picture is blank or covered", status: "resolved" }]);
  });

  it("can be turned off per camera (a scene dark by nature), which closes its alert; and the view can be set as the reference", async () => {
    const { agent, csrf } = await signIn();
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Yard", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam-Pass-123" }).expect(201)).body.id as string;
    cam.picture = flat(2);
    await runCheck(id, "manual", deps);
    await runCheck(id, "manual", deps);
    expect(await alerts(id)).toEqual([{ title: "Picture is black", status: "active" }]);

    await agent.post(`/api/cameras/${id}/picture/reset-reference`).set("X-CSRF-Token", csrf).expect(204);
    expect(await alerts(id)).toEqual([{ title: "Picture is black", status: "resolved" }]);
    await agent.patch(`/api/cameras/${id}`).set("X-CSRF-Token", csrf).send({ pictureChecks: false }).expect(200);
    expect((await agent.get(`/api/cameras/${id}`).expect(200)).body.pictureChecks).toBe(false);
    await runCheck(id, "manual", deps);
    await runCheck(id, "manual", deps);
    expect((await alerts(id)).filter((a) => a.status !== "resolved")).toEqual([]);
  });

  it("finds a frozen picture: the very same bytes at consecutive checks", async () => {
    const { agent, csrf } = await signIn();
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Lift", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam-Pass-123" }).expect(201)).body.id as string;
    await runCheck(id, "manual", deps);
    await runCheck(id, "manual", deps);
    expect((await status(id)).picture_state).toBe("ok"); // a live picture, never the same bytes
    cam.frozen = true;
    for (let i = 0; i < 3; i++) await runCheck(id, "manual", deps);
    cam.frozen = false;
    expect((await status(id)).picture_state).toBe("frozen");
    expect(await alerts(id)).toEqual([{ title: "Picture is frozen", status: "active" }]);
  });

  it("leaves the state unknown, with the reason, when the camera gives no picture", async () => {
    const { agent, csrf } = await signIn();
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Dock", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam-Pass-123" }).expect(201)).body.id as string;
    cam.picture = Buffer.from("not a picture");
    await runCheck(id, "manual", deps);
    expect(await status(id)).toMatchObject({ picture_state: null, picture_error: expect.stringMatching(/^Picture not checked/) });
    expect(await alerts(id)).toEqual([]);
  });
});
