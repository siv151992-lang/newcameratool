import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { createCamera } from "../../src/services/cameraService.js";
import { uptimeCsv, uptimeReport } from "../../src/services/uptimeService.js";
import { createTestUser, prepareDb, resetData, testOrgId } from "../helpers.js";

const H = 3600_000;
let actor: { id: string; username: string };

async function camera(name: string, location: string, createdHoursAgo: number, status: "online" | "offline" | "unknown") {
  const id = await createCamera(
    testOrgId,
    { name, host: `10.0.0.${Math.floor(Math.random() * 200) + 2}`, port: 80, protocol: "http", brand: "hikvision", model: null, location, username: "a", password: "b",
      monitoringEnabled: true, warningThreshold: null, criticalThreshold: null, caCertificate: null },
    actor,
  );
  await pool.query("UPDATE cameras SET created_at = now() - make_interval(secs => $2) WHERE id = $1", [id, createdHoursAgo * 3600]);
  await pool.query("UPDATE camera_status SET connection_status = $2 WHERE camera_id = $1", [id, status]);
  return id;
}
const change = (id: string, hoursAgo: number, from: string, to: string) =>
  pool.query("INSERT INTO connection_events (camera_id, occurred_at, from_status, to_status) VALUES ($1, now() - make_interval(secs => $2), $3, $4)", [id, hoursAgo * 3600, from, to]);

beforeAll(prepareDb);
beforeEach(async () => {
  await resetData();
  actor = await createTestUser("admin");
});

describe("uptime", () => {
  it("is the share of the observed time online, from the status changes", async () => {
    // Online since before the day; offline for an hour 12 hours ago.
    const a = await camera("Gate", "Site A", 48, "online");
    await change(a, 30, "unknown", "online");
    await change(a, 12, "online", "offline");
    await change(a, 11, "offline", "online");
    // Added 6 hours ago, online all along (no change since).
    const b = await camera("Lobby", "Site A", 6, "online");
    // Never checked: not observed.
    await camera("Store", "Site B", 48, "unknown");

    const r = await uptimeReport(testOrgId, 1);
    const gate = r.cameras.find((c) => c.name === "Gate")!;
    expect(gate.uptime).toBeCloseTo(95.833, 2); // 23 of 24 hours
    expect(gate.outages).toBe(1);
    expect(gate.longestOutageSeconds).toBeCloseTo(3600, -1);
    expect(r.cameras.find((c) => c.name === "Lobby")).toMatchObject({ uptime: 100, outages: 0 });
    expect(r.cameras.find((c) => c.name === "Lobby")!.observedSeconds).toBeCloseTo(6 * 3600, -1);
    expect(r.cameras.find((c) => c.name === "Store")).toMatchObject({ uptime: null, observedSeconds: 0 });
    // Lowest first, unobserved last.
    expect(r.cameras.map((c) => c.name)).toEqual(["Gate", "Lobby", "Store"]);
    // Site A: 29 of 30 observed hours online.
    expect(r.locations.find((l) => l.location === "Site A")!.uptime).toBeCloseTo(96.667, 2);
    expect(r.overall).toMatchObject({ cameras: 3, below99: 1, outages: 1 });
    expect(r.overall.uptime).toBeCloseTo(96.667, 2);
    expect(r.overall.downtimeSeconds).toBeCloseTo(3600, -1);
    expect(b).toBeTruthy();

    // A camera offline since before the period and still offline: 0%, its whole observed time down.
    const c = await camera("Dock", "Site B", 72, "offline");
    await change(c, 50, "online", "offline");
    const r2 = await uptimeReport(testOrgId, 1);
    expect(r2.cameras[0]).toMatchObject({ name: "Dock", uptime: 0, outages: 0 });

    const csv = uptimeCsv(r2);
    expect(csv.split("\r\n")[0]).toBe("﻿Camera,Location,Uptime %,Online (hours),Observed (hours),Downtime (minutes),Outages,Longest outage (minutes)");
    expect(csv).toContain("Gate,Site A,95.833,23.00,24.00,60,1,60");
  });
});
