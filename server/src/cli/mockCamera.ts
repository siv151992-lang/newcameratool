import { parseArgs } from "node:util";
import { MockHikvisionCamera, type MockDisk } from "../testing/mockHikvision.js";
import { MockVendorCamera } from "../testing/mockVendor.js";

/**
 * Starts simulated Hikvision cameras for local demos and manual testing.
 *   npm run mock-camera -- --port 8081 --count 3
 *   npm run mock-camera -- --port 8081 --count 3 --vendor   (also a camera of an unknown "Acme Vision" brand,
 *                                                            for trying configurable API integrations)
 *   ... --panasonic                                          (also a simulated Panasonic / i-PRO camera)
 *   ... --uniview                                            (also a simulated Uniview LAPI camera)
 *   ... --hanwha                                             (also a simulated Hanwha Vision SUNAPI camera)
 *   ... --search-recording                                   (Hikvision cameras without Recording/status, like
 *                                                            many real IP cameras: recording is found by search)
 * Register them in the app with host 127.0.0.1 (requires CAMERA_ALLOW_LOOPBACK=true, development only).
 */
const { values } = parseArgs({
  options: { port: { type: "string", default: "8081" }, count: { type: "string", default: "3" }, vendor: { type: "boolean", default: false }, hanwha: { type: "boolean", default: false }, panasonic: { type: "boolean", default: false }, uniview: { type: "boolean", default: false }, "search-recording": { type: "boolean", default: false } },
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
  cam.recordedDays = [30, 45, 3.5, 45][i % 4]!;
  // Camera 2 only answers searches of up to 31 days; camera 4 refuses all but short ones.
  cam.searchMaxDays = [Infinity, 31, Infinity, 1][i % 4]!;
  cam.recordingStatusApi = !values["search-recording"];
  if (i === 0 && values["search-recording"]) {
    // Like a DS-2CD2563G2-IS: clock on UTC+05:30, search replies in UTC.
    cam.utcOffsetMinutes = 330;
    cam.searchRepliesUtc = true;
  }
  const port = await cam.start(base + i);
  console.log(`Simulated camera ${i + 1}: http://127.0.0.1:${port}  user=admin password=Sim-Passw0rd!  scenario=${s.label}`);
}
if (values.vendor) {
  const acme = new MockVendorCamera();
  const port = await acme.start(base + count);
  console.log(
    `Simulated Acme Vision camera: http://127.0.0.1:${port}  user=admin password=Acme-Passw0rd!  (Digest)\n` +
      "  JSON storage: GET /api/v1/storage (?page=1)   XML storage: GET /cgi-bin/storage.xml   device info: GET /api/v1/system",
  );
}
if (values.hanwha) {
  const cam = new MockVendorCamera("admin", "Hanwha-Passw0rd!", "hanwha");
  const port = await cam.start(base + count + 1);
  console.log(`Simulated Hanwha Vision camera: http://127.0.0.1:${port}  user=admin password=Hanwha-Passw0rd!  (SUNAPI, Digest)`);
}
if (values.panasonic) {
  const cam = new MockVendorCamera("admin", "Ipro-Passw0rd!", "panasonic");
  const port = await cam.start(base + count + 2);
  console.log(`Simulated Panasonic / i-PRO camera: http://127.0.0.1:${port}  user=admin password=Ipro-Passw0rd!  (Digest)`);
}
if (values.uniview) {
  const cam = new MockVendorCamera("admin", "Unv-Passw0rd!", "uniview");
  cam.disks = [{ slot: "sd", label: "SD", sizeMiB: 243712, freeMiB: 37298, state: "Normal" }];
  const port = await cam.start(base + count + 3);
  console.log(`Simulated Uniview camera: http://127.0.0.1:${port}  user=admin password=Unv-Passw0rd!  (LAPI, Digest)`);
}
console.log("\nThese are SIMULATED devices for demos. Press Ctrl+C to stop.");
