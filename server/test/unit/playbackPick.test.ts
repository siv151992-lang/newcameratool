import { describe, expect, it } from "vitest";
import { DahuaAdapter } from "../../src/integrations/dahua/adapter.js";
import { HikvisionAdapter } from "../../src/integrations/hikvision/adapter.js";
import type { CameraHttpClient } from "../../src/integrations/http/cameraHttpClient.js";
import { pickPlaybackPath } from "../../src/services/liveVideoService.js";

const answers = (map: Record<string, number>) => async (path: string) => map[path] ?? 404;

describe("choosing a playback address", () => {
  it("plays the first address the camera serves", async () => {
    expect(await pickPlaybackPath(["/main", "/sub"], answers({ "/main": 200 }))).toEqual({ path: "/main", checked: true, variant: 0 });
    // Main stream refused (e.g. H.265 only, or another firmware's path): the sub stream.
    expect(await pickPlaybackPath(["/main", "/sub", "/other"], answers({ "/main": 454, "/sub": 200 }))).toEqual({ path: "/sub", checked: true, variant: 1 });
  });

  it("tries the address that worked last time first", async () => {
    const asked: string[] = [];
    const probe = async (p: string) => (asked.push(p), p === "/sub" ? 200 : 404);
    expect(await pickPlaybackPath(["/main", "/sub"], probe, 1)).toMatchObject({ path: "/sub" });
    expect(asked).toEqual(["/sub"]);
  });

  it("uses the first address unchecked when the camera's RTSP port does not answer from here", async () => {
    expect(await pickPlaybackPath(["/main", "/sub"], answers({ "/main": 0 }))).toEqual({ path: "/main", checked: false, variant: 0 });
  });

  it("reports every refusal, and stops at a refused login", async () => {
    expect(await pickPlaybackPath(["/main", "/sub"], answers({}))).toEqual({ refused: [{ path: "/main", status: 404 }, { path: "/sub", status: 404 }] });
    expect(await pickPlaybackPath(["/main", "/sub"], answers({ "/main": 401, "/sub": 200 }))).toEqual({ refused: [{ path: "/main", status: 401 }] });
  });

  it("offers the sub stream's recordings for Hikvision and Dahua", () => {
    const http = {} as CameraHttpClient;
    const t = Date.UTC(2026, 9, 26, 8, 0, 0);
    expect(new HikvisionAdapter(http).playbackRtspFallbacks(t, undefined, 2)).toEqual([
      "/Streaming/tracks/202?starttime=20261026T080000Z&endtime=20261026T200000Z",
      "/ISAPI/Streaming/tracks/201?starttime=20261026T080000Z&endtime=20261026T200000Z",
    ]);
    expect(new DahuaAdapter(http).playbackRtspFallbacks(t)[0]).toContain("/cam/playback?channel=1&subtype=1&starttime=2026_10_26_08_00_00");
  });
});
