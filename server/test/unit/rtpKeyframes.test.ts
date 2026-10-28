import { describe, expect, it } from "vitest";
import { interleavedChannel, startsKeyframe, videoTrack } from "../../src/services/rtpKeyframes.js";

/** An RTP packet (version 2, no extras) carrying this payload. */
const rtp = (...payload: number[]) => Buffer.from([0x80, 96, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, ...payload]);

describe("key frames in RTP video", () => {
  it("H.264: an IDR slice, the first part of a fragmented one, and one inside an aggregate", () => {
    expect(startsKeyframe(rtp(0x65, 0x88), "h264")).toBe(true); // NAL 5 (IDR)
    expect(startsKeyframe(rtp(0x41, 0x9a), "h264")).toBe(false); // NAL 1 (P slice)
    expect(startsKeyframe(rtp(0x7c, 0x85, 0x88), "h264")).toBe(true); // FU-A, start bit, IDR
    expect(startsKeyframe(rtp(0x7c, 0x05, 0x88), "h264")).toBe(false); // FU-A, a later part of it
    expect(startsKeyframe(rtp(0x7c, 0x81, 0x9a), "h264")).toBe(false); // FU-A start of a P slice
    // STAP-A: SPS (2 bytes), PPS (2 bytes), IDR (2 bytes)
    expect(startsKeyframe(rtp(0x18, 0, 2, 0x67, 0x42, 0, 2, 0x68, 0xce, 0, 2, 0x65, 0x88), "h264")).toBe(true);
    expect(startsKeyframe(rtp(0x18, 0, 2, 0x67, 0x42, 0, 2, 0x68, 0xce), "h264")).toBe(false);
  });

  it("H.265: an IRAP picture and the first part of a fragmented one", () => {
    expect(startsKeyframe(rtp(19 << 1, 1, 0xaf), "h265")).toBe(true); // IDR_W_RADL
    expect(startsKeyframe(rtp(1 << 1, 1, 0xaf), "h265")).toBe(false); // TRAIL_R
    expect(startsKeyframe(rtp(49 << 1, 1, 0x80 | 19, 0xaf), "h265")).toBe(true); // FU start, IDR
    expect(startsKeyframe(rtp(49 << 1, 1, 19, 0xaf), "h265")).toBe(false); // FU, later part
  });

  it("ignores what is not an RTP packet", () => {
    expect(startsKeyframe(Buffer.from([0x65, 0x88]), "h264")).toBe(false);
  });

  it("reads the video track and its channel", () => {
    const sdp = "v=0\r\ns=Playback\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=1\r\nm=audio 0 RTP/AVP 8\r\na=rtpmap:8 PCMA/8000\r\na=control:trackID=2\r\n";
    expect(videoTrack(sdp)).toEqual({ codec: "h264", control: "trackID=1" });
    expect(videoTrack("v=0\r\nm=video 0 RTP/AVP 98\r\na=rtpmap:98 H265/90000\r\n")).toEqual({ codec: "h265", control: undefined });
    expect(videoTrack("v=0\r\nm=audio 0 RTP/AVP 8\r\n")).toBeUndefined();
    expect(interleavedChannel("RTP/AVP/TCP;unicast;interleaved=2-3")).toBe(2);
    expect(interleavedChannel(undefined)).toBeUndefined();
  });
});
