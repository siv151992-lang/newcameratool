import { describe, expect, it } from "vitest";
import type { CameraHttpClient, CameraRequest } from "../../src/integrations/http/cameraHttpClient.js";
import { MilestoneAdapter, matchRecordings } from "../../src/integrations/milestone/adapter.js";
import { parseOnvifChannels } from "../../src/integrations/onvif/parser.js";
import { createRegistry } from "../../src/integrations/registry.js";
import type { CameraConfig } from "../../src/integrations/types.js";

const envelope = (body: string) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body>${body}</s:Body></s:Envelope>`;

/** A Milestone Open Network Bridge's cameras: each a video source with a main (H.265) and a second (H.264) profile. */
const CAMERAS = [
  { source: "cam-gate", name: "Gate" },
  { source: "cam-lobby", name: "Lobby" },
  { source: "cam-dock", name: "Dock" },
];
const profiles = envelope(`<trt:GetProfilesResponse xmlns:trt="http://www.onvif.org/ver10/media/wsdl">${CAMERAS.map((c) => `
  <trt:Profiles token="${c.source}-main"><tt:Name>${c.name} main</tt:Name>
    <tt:VideoSourceConfiguration token="vsc-${c.source}"><tt:Name>${c.name}</tt:Name><tt:SourceToken>${c.source}</tt:SourceToken></tt:VideoSourceConfiguration>
    <tt:VideoEncoderConfiguration><tt:Encoding>H265</tt:Encoding></tt:VideoEncoderConfiguration></trt:Profiles>
  <trt:Profiles token="${c.source}-sub"><tt:Name>${c.name} sub</tt:Name>
    <tt:VideoSourceConfiguration token="vsc-${c.source}"><tt:Name>${c.name}</tt:Name><tt:SourceToken>${c.source}</tt:SourceToken></tt:VideoSourceConfiguration>
    <tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding></tt:VideoEncoderConfiguration></trt:Profiles>`).join("")}
</trt:GetProfilesResponse>`);
const recording = (token: string, source: string, from: string, until: string, status: string, byName = false) =>
  `<tt:RecordingInformation><tt:RecordingToken>${token}</tt:RecordingToken>
    <tt:Source>${byName ? "" : `<tt:SourceId>${source}</tt:SourceId>`}<tt:Name>${byName ? "Dock" : "XProtect"}</tt:Name></tt:Source>
    <tt:EarliestRecording>${from}</tt:EarliestRecording><tt:LatestRecording>${until}</tt:LatestRecording>
    <tt:RecordingStatus>${status}</tt:RecordingStatus></tt:RecordingInformation>`;
const now = new Date();
const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString().replace(/\.\d+Z$/, "Z");
const results = envelope(`<tse:GetRecordingSearchResultsResponse xmlns:tse="http://www.onvif.org/ver10/search/wsdl"><tse:ResultList><tt:SearchState>Completed</tt:SearchState>
  ${recording("rec-gate", "cam-gate", iso(30 * 86_400_000), iso(1000), "Recording")}
  ${recording("rec-lobby", "cam-lobby", iso(10 * 86_400_000), iso(3 * 86_400_000), "Stopped")}
  ${recording("rec-dock", "", iso(5 * 86_400_000), iso(2000), "Recording", true)}
</tse:ResultList></tse:GetRecordingSearchResultsResponse>`);

function bridge(identity = "<tds:Manufacturer>Milestone</tds:Manufacturer><tds:Model>Open Network Bridge</tds:Model>") {
  const calls: CameraRequest[] = [];
  const http = {
    request: async (_cfg: CameraConfig, req: CameraRequest) => {
      calls.push(req);
      const b = req.body ?? "";
      const reply = (x: string) => ({ status: 200, headers: { "content-type": "application/soap+xml" }, body: x });
      if (b.includes("GetServices")) return reply(envelope("<tds:GetServicesResponse xmlns:tds='x'/>"));
      if (b.includes("GetSystemDateAndTime")) return reply(envelope(`<tds:GetSystemDateAndTimeResponse xmlns:tds="x"><tds:SystemDateAndTime><tt:UTCDateTime><tt:Date><tt:Year>${now.getUTCFullYear()}</tt:Year><tt:Month>${now.getUTCMonth() + 1}</tt:Month><tt:Day>${now.getUTCDate()}</tt:Day></tt:Date><tt:Time><tt:Hour>${now.getUTCHours()}</tt:Hour><tt:Minute>${now.getUTCMinutes()}</tt:Minute><tt:Second>${now.getUTCSeconds()}</tt:Second></tt:Time></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`));
      if (b.includes("GetDeviceInformation")) return reply(envelope(`<tds:GetDeviceInformationResponse xmlns:tds="x">${identity}<tds:FirmwareVersion>2025R1</tds:FirmwareVersion><tds:SerialNumber>ONB-1</tds:SerialNumber></tds:GetDeviceInformationResponse>`));
      if (b.includes("GetProfiles")) return reply(profiles);
      if (b.includes("GetStreamUri")) {
        const token = /<trt:ProfileToken>([^<]+)</.exec(b)![1];
        return reply(envelope(`<trt:GetStreamUriResponse xmlns:trt="x"><trt:MediaUri><tt:Uri>rtsp://192.168.5.10:554/live/${token}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`));
      }
      if (b.includes("FindRecordings")) return reply(envelope(`<tse:FindRecordingsResponse xmlns:tse="x"><tse:SearchToken>s1</tse:SearchToken></tse:FindRecordingsResponse>`));
      if (b.includes("GetRecordingSearchResults")) return reply(results);
      if (b.includes("EndSearch")) return reply(envelope("<tse:EndSearchResponse xmlns:tse='x'/>"));
      return { status: 400, headers: {}, body: envelope("<s:Fault><s:Reason><s:Text>Not supported</s:Text></s:Reason></s:Fault>") };
    },
  } as unknown as CameraHttpClient;
  return { adapter: new MilestoneAdapter(http), calls };
}
const cfg: CameraConfig = { host: "192.168.5.10", port: 580, protocol: "http", username: "onvif-user", password: "secret", timeoutMs: 5000 };

describe("Milestone XProtect through the Open Network Bridge", () => {
  it("lists each XProtect camera once, as a channel (several profiles of one source)", async () => {
    expect(parseOnvifChannels(profiles)).toEqual([
      { channel: 1, name: "Gate", profileToken: "cam-gate-sub", sourceToken: "cam-gate" },
      { channel: 2, name: "Lobby", profileToken: "cam-lobby-sub", sourceToken: "cam-lobby" },
      { channel: 3, name: "Dock", profileToken: "cam-dock-sub", sourceToken: "cam-dock" },
    ]);
    const { adapter } = bridge();
    // Recording state per camera: from source id (Gate, Lobby) or by name (Dock).
    expect(await adapter.getChannels(cfg)).toEqual([
      { channel: 1, name: "Gate", recording: "recording" },
      { channel: 2, name: "Lobby", recording: "idle" },
      { channel: 3, name: "Dock", recording: "recording" },
    ]);
  });

  it("plays each camera's live video and its own recordings", async () => {
    const { adapter, calls } = bridge();
    expect(await adapter.liveRtspUrl(cfg, 2)).toBe("rtsp://192.168.5.10:554/live/cam-lobby-sub");
    expect(calls.find((c) => c.body?.includes("GetStreamUri"))!.body).toContain("<trt:ProfileToken>cam-lobby-sub</trt:ProfileToken>");
    const lobby = await adapter.listRecordings(cfg, undefined, undefined, 2);
    expect(lobby.segments.map((s) => s.ref)).toEqual(["rec-lobby"]);
    expect(lobby.segments[0]!.end - lobby.segments[0]!.start).toBeCloseTo(7 * 86_400_000, -4);
    expect((await adapter.listRecordings(cfg, undefined, undefined, 3)).segments.map((s) => s.ref)).toEqual(["rec-dock"]);
    // Only what overlaps the asked period (a day 20 days ago: Gate only recorded then).
    const day = now.getTime() - 20 * 86_400_000;
    expect((await adapter.listRecordings(cfg, day, day + 86_400_000, 2)).segments).toEqual([]);
    expect((await adapter.listRecordings(cfg, day, day + 86_400_000, 1)).segments.map((s) => s.ref)).toEqual(["rec-gate"]);
    await expect(adapter.liveRtspUrl(cfg, 9)).rejects.toThrow(/no camera 9/);
  });

  it("tests the bridge by its cameras, with no storage to read", async () => {
    const { adapter } = bridge();
    const r = await adapter.testConnection(cfg);
    expect(r.ok).toBe(true);
    expect(r.steps.find((s) => s.key === "api")!.message).toBe("3 cameras: Gate, Lobby, Dock");
    expect(r.steps.find((s) => s.key === "storage")!.status).toBe("skipped");
    expect(await adapter.getStorageStatus(cfg)).toEqual({ devices: [] });
    expect(adapter.meta).toMatchObject({ key: "milestone", recordsElsewhere: true, defaultPorts: { http: 580 } });
  });

  it("says so when the address is a camera, not the bridge", async () => {
    const { adapter } = bridge("<tds:Manufacturer>FLIR Systems</tds:Manufacturer><tds:Model>CM-3102-01-I</tds:Model>");
    const r = await adapter.testConnection(cfg);
    const api = r.steps.find((s) => s.key === "api")!;
    expect(api.status).toBe("warning");
    expect(api.message).toMatch(/^This is FLIR Systems CM-3102-01-I, a camera, not the Milestone Open Network Bridge/);
  });

  it("matches recordings by source, then name, then order", () => {
    const cams = parseOnvifChannels(profiles);
    const rec = (token: string, extra: object = {}) => ({ token, from: 0, until: 1, ...extra });
    // No source details at all, one recording per camera: by order.
    expect([...matchRecordings(cams, [rec("a"), rec("b"), rec("c")]).entries()].map(([ch, r]) => [ch, r[0]!.token])).toEqual([[1, "a"], [2, "b"], [3, "c"]]);
    // Unknown sources and a different count: left unmatched rather than guessed.
    expect(matchRecordings(cams, [rec("a"), rec("b")]).size).toBe(0);
    expect(matchRecordings(cams, [rec("x", { sourceId: "cam-gate-sub" })]).get(1)![0]!.token).toBe("x"); // the profile token
  });

  it("is a built-in brand, known by its usual names", () => {
    const registry = createRegistry();
    expect(["Milestone", "XProtect", "Milestone XProtect"].map((n) => registry.resolveKey(n))).toEqual(["milestone", "milestone", "milestone"]);
  });
});
