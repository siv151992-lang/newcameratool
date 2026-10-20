import { parseArgs } from "node:util";
import { MockHikvisionCamera, type MockDisk } from "../testing/mockHikvision.js";

/**
 * Starts simulated Hikvision cameras for local demos and manual testing.
 *   npm run mock-camera -- --port 8081 --count 3
 * Register them in the app with host 127.0.0.1 (requires CAMERA_ALLOW_LOOPBACK=true, development only).
 */
const { values } = parseArgs({
  options: { port: { type: "string", default: "8081" }, count: { type: "string", default: "3" } },
});
const base = Number(values.port);
const count = Math.min(Number(values.count), 20);
const scenarios: { label: string; recording?: string; disks: MockDisk[] }[] = [
  { label: "healthy (46% used)", disks: [{ id: 1, name: "hdde", status: "ok", capacityMb: 121942, freeMb: 65580, property: "RW", formatType: "EXT4" }] },
  { label: "nearly full (95% used)", disks: [{ id: 1, name: "hdde", status: "ok", capacityMb: 121942, freeMb: 5632, property: "RW", formatType: "EXT4" }] },
  { label: "disk error, recording error", recording: "error", disks: [{ id: 1, name: "hdde", status: "error", capacityMb: 60906, freeMb: 0, property: "RW" }] },
  {
    label: "two disks, not recording",
    recording: "idle",
    disks: [
      { id: 1, name: "hdde", status: "ok", capacityMb: 121942, freeMb: 30000, property: "RW", formatType: "EXT4" },
      { id: 2, name: "hddf", status: "ok", capacityMb: 60906, freeMb: 50000, property: "RW", formatType: "EXT4" },
    ],
  },
];

for (let i = 0; i < count; i++) {
  const s = scenarios[i % scenarios.length]!;
  const cam = new MockHikvisionCamera("admin", "Sim-Passw0rd!", s.disks);
  cam.recording = s.recording ?? "recording";
  const port = await cam.start(base + i);
  console.log(`Simulated camera ${i + 1}: http://127.0.0.1:${port}  user=admin password=Sim-Passw0rd!  scenario=${s.label}`);
}
console.log("\nThese are SIMULATED devices for demos. Press Ctrl+C to stop.");
