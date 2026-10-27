import { describe, expect, it } from "vitest";
import { AxisAdapter } from "../../src/integrations/axis/adapter.js";
import { parseAxisRecordings } from "../../src/integrations/axis/parser.js";
import { DahuaAdapter } from "../../src/integrations/dahua/adapter.js";
import { parseDahuaFiles } from "../../src/integrations/dahua/parser.js";
import { HanwhaAdapter } from "../../src/integrations/hanwha/adapter.js";
import { parseSunapiTimeline, parseSunapiUtcOffset } from "../../src/integrations/hanwha/parser.js";
import { HikvisionAdapter } from "../../src/integrations/hikvision/adapter.js";
import type { CameraHttpClient } from "../../src/integrations/http/cameraHttpClient.js";
import { mergeSegments } from "../../src/integrations/types.js";
import { UniviewAdapter } from "../../src/integrations/uniview/adapter.js";

const t = (s: string) => Date.parse(`${s}Z`);
const http = {} as CameraHttpClient;

describe("recordings for playback", () => {
  it("reads Dahua / CP Plus file searches", () => {
    const body = "found=2\r\nitems[0].Channel=0\r\nitems[0].StartTime=2026-10-24 08:00:00\r\nitems[0].EndTime=2026-10-24 09:00:00\r\nitems[1].StartTime=2026-10-24 09:00:00\r\nitems[1].EndTime=2026-10-24 09:30:00\r\n";
    const { found, segments } = parseDahuaFiles(body);
    expect(found).toBe(2);
    expect(mergeSegments(segments)).toEqual([{ start: t("2026-10-24T08:00:00"), end: t("2026-10-24T09:30:00") }]);
  });

  it("reads the Hanwha timeline and the camera's UTC offset", () => {
    expect(parseSunapiUtcOffset("LocalTime=2026-10-24 14:00:00\r\nUTCTime=2026-10-24 08:30:00\r\n")).toBe(330 * 60_000);
    expect(parseSunapiTimeline("Results.0.StartTime=2026-10-24T02:30:00Z\r\nResults.0.EndTime=2026-10-24T03:30:00Z\r\nResults.0.Type=Normal\r\n"))
      .toEqual([{ start: t("2026-10-24T02:30:00"), end: t("2026-10-24T03:30:00") }]);
  });

  it("reads Axis recordings in local time, with their ids", () => {
    const xml = `<root><recordings><recording recordingid="20261024_080000_ABC" starttime="2026-10-24T02:30:00.000Z" starttimelocal="2026-10-24T08:00:00.000+05:30" stoptime="2026-10-24T03:30:00.000Z" stoptimelocal="2026-10-24T09:00:00.000+05:30" /></recordings></root>`;
    expect(parseAxisRecordings(xml, Date.now())).toEqual({
      segments: [{ start: t("2026-10-24T08:00:00"), end: t("2026-10-24T09:00:00"), ref: "20261024_080000_ABC" }],
      offsetMs: 330 * 60_000,
    });
  });

  it("builds each brand's playback address", () => {
    const start = t("2026-10-24T08:15:30");
    expect(new HikvisionAdapter(http).playbackRtspPath(start)).toBe("/Streaming/tracks/101?starttime=20261024T081530Z&endtime=20261024T201530Z");
    expect(new DahuaAdapter(http).playbackRtspPath(start)).toBe("/cam/playback?channel=1&subtype=0&starttime=2026_10_24_08_15_30&endtime=2026_10_24_20_15_30");
    expect(new HanwhaAdapter(http).playbackRtspPath(start)).toBe("/recording/20261024081530-20261024201530/play.smp");
    expect(new UniviewAdapter(http).playbackRtspPath(start)).toBe(`/c1/b${start / 1000}/e${start / 1000 + 43200}/replay/`);
    expect(new AxisAdapter(http).playbackRtspPath(start, { start, end: start + 1, ref: "rec 1" })).toBe("/axis-media/media.amp?recordingid=rec%201");
  });
});
