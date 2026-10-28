/**
 * Spots full pictures (key frames: H.264 IDR, H.265 IRAP) in a camera's RTP video, to tell how long a
 * player waits for its first picture and how often the camera sends one (its I-frame interval).
 */

export type VideoCodec = "h264" | "h265";

/** The video track of an SDP: its codec and control name (the address part SETUP is sent to). */
export function videoTrack(sdp: string): { codec: VideoCodec; control?: string } | undefined {
  const video = sdp.split(/\r?\n(?=m=)/).find((s) => s.startsWith("m=video"));
  if (!video) return undefined;
  const codec = /a=rtpmap:\d+\s+(H264|H265|HEVC)\//i.exec(video)?.[1]?.toUpperCase();
  if (!codec) return undefined;
  const control = /a=control:\s*(\S+)/i.exec(video)?.[1];
  return { codec: codec === "H264" ? "h264" : "h265", control };
}

/** The interleaved channel of a SETUP's Transport header (interleaved=0-1 → 0). */
export function interleavedChannel(transport: string | undefined): number | undefined {
  const m = /interleaved=(\d+)/i.exec(transport ?? "");
  return m ? Number(m[1]) : undefined;
}

/** The payload of an RTP packet (after its header, contributing sources and extension). */
function rtpPayload(rtp: Buffer): Buffer | undefined {
  if (rtp.length < 13 || rtp[0]! >> 6 !== 2) return undefined;
  let offset = 12 + 4 * (rtp[0]! & 0x0f);
  if (rtp[0]! & 0x10) {
    if (rtp.length < offset + 4) return undefined;
    offset += 4 + 4 * rtp.readUInt16BE(offset + 2);
  }
  return offset < rtp.length ? rtp.subarray(offset) : undefined;
}

/** Whether this RTP packet starts a key frame (the first part of it: one per picture). */
export function startsKeyframe(rtp: Buffer, codec: VideoCodec): boolean {
  const p = rtpPayload(rtp);
  if (!p) return false;
  if (codec === "h264") {
    const type = p[0]! & 0x1f;
    if (type === 5) return true; // a whole IDR slice
    if (type === 28 && p.length > 1) return (p[1]! & 0x80) !== 0 && (p[1]! & 0x1f) === 5; // FU-A, first part of an IDR slice
    if (type === 24) { // STAP-A: several units (SPS, PPS, IDR) in one packet
      for (let i = 1; i + 2 < p.length; ) {
        const size = p.readUInt16BE(i);
        if ((p[i + 2]! & 0x1f) === 5) return true;
        i += 2 + size;
      }
    }
    return false;
  }
  const type = (p[0]! >> 1) & 0x3f;
  if (type >= 16 && type <= 21) return true; // IRAP (IDR, CRA, BLA)
  if (type === 49 && p.length > 2) return (p[2]! & 0x80) !== 0 && (p[2]! & 0x3f) >= 16 && (p[2]! & 0x3f) <= 21; // FU, first part
  if (type === 48) { // aggregation packet
    for (let i = 2; i + 2 < p.length; ) {
      const size = p.readUInt16BE(i);
      const t = (p[i + 2]! >> 1) & 0x3f;
      if (t >= 16 && t <= 21) return true;
      i += 2 + size;
    }
  }
  return false;
}
