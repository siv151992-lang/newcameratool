import { describe, expect, it } from "vitest";
import { parseAxisRecording } from "../../src/integrations/axis/parser.js";
import { parseDahuaRecording } from "../../src/integrations/dahua/parser.js";
import { parseCameraTimeXml, parseRecordingSearchXml, parseRecordingStatusXml, recordingSearchXml, wallClockMs } from "../../src/integrations/hikvision/parser.js";
import { parseOnvifRecording } from "../../src/integrations/onvif/parser.js";
import { combineRecording, flagToRecordingState } from "../../src/integrations/recording.js";
import { CameraApiError } from "../../src/integrations/types.js";
import { parseUniviewRecording } from "../../src/integrations/uniview/parser.js";

const errorCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CameraApiError);
    return (e as CameraApiError).code;
  }
  throw new Error("expected the parser to throw");
};

describe("combineRecording", () => {
  it("is recording if any channel records, else error, else idle, else unknown", () => {
    const ch = (state: "recording" | "idle" | "error" | "unknown") => ({ id: state, state });
    expect(combineRecording([ch("idle"), ch("recording")]).state).toBe("recording");
    expect(combineRecording([ch("idle"), ch("error")]).state).toBe("error");
    expect(combineRecording([ch("idle"), ch("unknown")]).state).toBe("idle");
    expect(combineRecording([]).state).toBe("unknown");
    expect(combineRecording([ch("recording")], { state: "idle", rawStatus: "idle" }).state).toBe("idle");
    expect(combineRecording([ch("recording")], { state: "unknown" }).state).toBe("recording");
  });

  it("maps true/false and 0/1/2 flags", () => {
    expect(["True", "1", "2", true].map(flagToRecordingState)).toEqual(["recording", "recording", "recording", "recording"]);
    expect(["False", "0", false].map(flagToRecordingState)).toEqual(["idle", "idle", "idle"]);
    expect(["maybe", undefined].map(flagToRecordingState)).toEqual(["unknown", "unknown"]);
  });
});

describe("Hikvision recording status", () => {
  const xml = (status: string, track = status) => `<?xml version="1.0" encoding="UTF-8"?>
<RecordingStatus xmlns="http://hikvision.com" version="2.0">
  <status>${status}</status>
  <TrackStatusList>
    <TrackStatus><id>101</id><videoRecordStatus>${track}</videoRecordStatus><audioRecordStatus>${track}</audioRecordStatus></TrackStatus>
  </TrackStatusList>
</RecordingStatus>`;

  it("parses the reference payload", () => {
    const r = parseRecordingStatusXml(xml("recording"));
    expect(r.state).toBe("recording");
    expect(r.channels).toEqual([{ id: "track-101", state: "recording", rawStatus: "recording" }]);
    expect(r.detail).toBe("status: recording; track-101: recording");
  });

  it("maps idle and error, and falls back to tracks when <status> is missing", () => {
    expect(parseRecordingStatusXml(xml("idle")).state).toBe("idle");
    expect(parseRecordingStatusXml(xml("error")).state).toBe("error");
    const noTop = `<RecordingStatus><TrackStatusList><TrackStatus><id>101</id><videoRecordStatus>idle</videoRecordStatus></TrackStatus>
      <TrackStatus><id>201</id><videoRecordStatus>recording</videoRecordStatus></TrackStatus></TrackStatusList></RecordingStatus>`;
    expect(parseRecordingStatusXml(noTop).state).toBe("recording");
  });

  it("raises ISAPI errors", () => {
    const notSupported = `<ResponseStatus><statusCode>4</statusCode><statusString>Invalid Operation</statusString><subStatusCode>notSupport</subStatusCode></ResponseStatus>`;
    expect(errorCode(() => parseRecordingStatusXml(notSupported))).toBe("API_UNAVAILABLE");
  });

  describe("search fallback for cameras without a status endpoint", () => {
    const now = wallClockMs("2026-10-21T17:25:00")!;
    const result = (status: string, ends: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<searchID>X</searchID><responseStatus>${status === "NO MATCHES" ? "false" : "true"}</responseStatus>
<responseStatusStrg>${status}</responseStatusStrg><numOfMatches>${ends.length}</numOfMatches>
<matchList>${ends.map((e) => `<searchMatchItem><sourceID>{X}</sourceID><trackID>101</trackID>
<timeSpan><startTime>2026-10-21T17:00:00Z</startTime><endTime>${e}</endTime></timeSpan>
<metadataMatches><metadataDescriptor>recordType.meta.hikvision.com/timing</metadataDescriptor></metadataMatches></searchMatchItem>`).join("")}</matchList>
</CMSearchResult>`;

    it("reads the camera's wall-clock time regardless of its UTC offset", () => {
      const xml = `<Time><timeMode>NTP</timeMode><localTime>2026-10-21T17:25:00+05:30</localTime><timeZone>CST-5:30:00</timeZone></Time>`;
      expect(parseCameraTimeXml(xml)).toBe(now);
    });

    it("builds a search over the window in ISAPI form", () => {
      const body = recordingSearchXml("ID", "101", now - 600_000, now);
      expect(body).toContain("<trackID>101</trackID>");
      expect(body).toContain("<startTime>2026-10-21T17:15:00Z</startTime><endTime>2026-10-21T17:25:00Z</endTime>");
    });

    it("is recording when a segment ends near the camera's clock", () => {
      const r = parseRecordingSearchXml(result("OK", ["2026-10-21T17:10:00Z", "2026-10-21T17:24:40Z"]), "101", now, 180_000);
      expect(r.state).toBe("recording");
      expect(r.channels[0]).toMatchObject({ id: "track-101", mode: "timing", rawStatus: "recorded until 2026-10-21T17:24:40Z" });
    });

    it("is idle when the last segment is old or nothing was recorded", () => {
      expect(parseRecordingSearchXml(result("OK", ["2026-10-21T17:15:00Z"]), "101", now, 180_000)).toMatchObject({
        state: "idle",
        detail: "track-101: last recording ended 2026-10-21T17:15:00Z (timing)",
      });
      expect(parseRecordingSearchXml(result("NO MATCHES", []), "101", now, 180_000).state).toBe("idle");
    });

    it("raises failed searches", () => {
      expect(errorCode(() => parseRecordingSearchXml(result("FAILED", []).replace(">true<", ">false<"), "101", now, 1))).toBe("API_ERROR");
    });
  });
});

describe("Axis recording status", () => {
  it("parses the reference payload", () => {
    const r = parseAxisRecording("Storage.S0.DriveStatus=Normal\nStorage.S0.RecordingStatus=Recording\nStorage.S0.RecordingState=active\n");
    expect(r).toMatchObject({ state: "recording", channels: [{ id: "S0", state: "recording", rawStatus: "Recording" }] });
  });

  it("maps NotRecording and inactive/suspended states", () => {
    expect(parseAxisRecording("root.Storage.S0.RecordingStatus=NotRecording\n").state).toBe("idle");
    expect(parseAxisRecording("Storage.S0.RecordingState=suspended\n").state).toBe("idle");
    expect(parseAxisRecording("Storage.S0.RecordingState=inactive\nStorage.S1.RecordingState=active\n").state).toBe("recording");
  });

  it("is unknown when the camera reports no recording fields", () => {
    expect(parseAxisRecording("Storage.S0.DriveStatus=Normal\nStorage.S0.TotalSize=1000\n")).toMatchObject({ state: "unknown", channels: [] });
  });
});

describe("Uniview recording status", () => {
  it("parses the reference payload (fields directly under Response)", () => {
    const r = parseUniviewRecording(JSON.stringify({ Response: { RecordingStatus: "True", StreamType: "MainStream", TriggerType: "Continuous" } }));
    expect(r.state).toBe("recording");
    expect(r.channels[0]).toEqual({ id: "channel-1", state: "recording", rawStatus: "True", mode: "Continuous, MainStream" });
  });

  it("accepts Response.Data, numeric flags and per-channel lists", () => {
    const wrapped = (data: unknown) => JSON.stringify({ Response: { StatusCode: 0, Data: data } });
    expect(parseUniviewRecording(wrapped({ RecordingStatus: "False" })).state).toBe("idle");
    expect(parseUniviewRecording(wrapped({ RecordingStatus: 2 })).state).toBe("recording");
    const list = parseUniviewRecording(wrapped({ Channels: [{ ID: 1, RecordingStatus: 0 }, { ID: 2, RecordingStatus: 1 }] }));
    expect(list.channels.map((c) => [c.id, c.state])).toEqual([["channel-1", "idle"], ["channel-2", "recording"]]);
    expect(list.state).toBe("recording");
  });

  it("classifies errors and missing fields", () => {
    expect(errorCode(() => parseUniviewRecording(JSON.stringify({ Response: { StatusCode: 4, StatusString: "Not Support" } })))).toBe("API_UNAVAILABLE");
    expect(errorCode(() => parseUniviewRecording(JSON.stringify({ Response: { StatusCode: 0, Data: { Other: 1 } } })))).toBe("INVALID_RESPONSE");
  });
});

describe("Dahua recording status", () => {
  it("parses the reference payload, ignoring documentation comments", () => {
    const r = parseDahuaRecording(
      "status.Channels[0].RecordStatus=1    # 0 = Stopped, 1 = Recording, 2 = Alarm\r\nstatus.Channels[0].Mode=Manual       # Manual, Auto, Schedule\r\n",
    );
    expect(r).toMatchObject({ state: "recording", channels: [{ id: "channel-1", state: "recording", rawStatus: "1", mode: "Manual" }] });
  });

  it("maps stopped and alarm recording across channels", () => {
    expect(parseDahuaRecording("status.Channels[0].RecordStatus=0\nstatus.Channels[0].Mode=Schedule\n").state).toBe("idle");
    const alarm = parseDahuaRecording(String.raw`status.Channels[0].RecordStatus=0\r\nstatus.Channels[1].RecordStatus=2\r\n`);
    expect(alarm.state).toBe("recording");
    expect(alarm.channels[1]).toMatchObject({ id: "channel-2", rawStatus: "2 (alarm)" });
  });

  it("classifies errors", () => {
    expect(errorCode(() => parseDahuaRecording("Error\r\nBad Request!\r\n"))).toBe("API_UNAVAILABLE");
    expect(errorCode(() => parseDahuaRecording("something=else\n"))).toBe("INVALID_RESPONSE");
  });
});

describe("ONVIF recording jobs", () => {
  const envelope = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:trc="http://www.onvif.org/ver10/recording/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
  <soap:Body><trc:GetRecordingJobsResponse>${inner}</trc:GetRecordingJobsResponse></soap:Body>
</soap:Envelope>`;
  const job = (token: string, status: string) =>
    `<trc:JobItem><trc:JobToken>${token}</trc:JobToken><trc:RecordingToken>RecordingToken_01</trc:RecordingToken>` +
    `<!-- The current live operational execution state --><trc:RecordingStatus>${status}</trc:RecordingStatus></trc:JobItem>`;

  it("parses the reference payload", () => {
    const r = parseOnvifRecording(envelope(job("JobToken_01", "Recording")));
    expect(r).toMatchObject({ state: "recording", channels: [{ id: "JobToken_01", state: "recording", rawStatus: "Recording", mode: "recording RecordingToken_01" }] });
  });

  it("maps Stopped/Initiated, the schema's JobConfiguration Mode, and no jobs", () => {
    expect(parseOnvifRecording(envelope(job("a", "Stopped") + job("b", "Initiated"))).state).toBe("idle");
    const schema = `<trc:JobItem><trc:JobToken>j1</trc:JobToken><trc:JobConfiguration><tt:RecordingToken>r1</tt:RecordingToken><tt:Mode>Active</tt:Mode></trc:JobConfiguration></trc:JobItem>`;
    expect(parseOnvifRecording(envelope(schema)).state).toBe("recording");
    expect(parseOnvifRecording(envelope(""))).toMatchObject({ state: "idle", channels: [] });
  });

  it("classifies SOAP faults", () => {
    const fault = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Code><s:Value>s:Receiver</s:Value>
      <s:Subcode><s:Value>ter:ActionNotSupported</s:Value></s:Subcode></s:Code></s:Fault></s:Body></s:Envelope>`;
    expect(errorCode(() => parseOnvifRecording(fault))).toBe("API_UNAVAILABLE");
  });
});
