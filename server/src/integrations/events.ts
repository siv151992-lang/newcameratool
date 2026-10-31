/**
 * Camera events: what a camera reports on its own, as it happens, over its event stream (Hikvision
 * ISAPI alertStream, Dahua eventManager). Only events about the camera's health are kept: tampering,
 * video loss, disk and network faults and failed logins. Motion, line crossing and other analytics
 * events are ignored (they are what cameras are for, not problems).
 */

export const CAMERA_EVENT_KINDS = ["tamper", "video_loss", "device_fault", "illegal_login"] as const;
export type CameraEventKind = (typeof CAMERA_EVENT_KINDS)[number];

export interface CameraEvent {
  kind: CameraEventKind;
  /** active: started (or still going on); inactive: ended. */
  state: "active" | "inactive";
  /** The camera's own name for it, e.g. "shelteralarm" or "VideoBlind". */
  type: string;
  /** What it means, in words. */
  detail: string;
  /** The channel (an NVR's camera, or a camera's video input) it is about, when given. */
  channel?: number;
  /**
   * How long an active event lasts unless repeated: cameras that repeat an ongoing event every few
   * seconds (Hikvision) say it ended by no longer repeating it. Absent: lasts until its "inactive".
   */
  repeatsWithinMs?: number;
}

/** Hikvision eventType (lower case) → what it means. */
const HIKVISION: Record<string, { kind: CameraEventKind; detail: string }> = {
  shelteralarm: { kind: "tamper", detail: "Video tampering: the camera's view is covered" },
  tamperdetection: { kind: "tamper", detail: "Video tampering: the camera's view is covered" },
  videotampering: { kind: "tamper", detail: "Video tampering: the camera's view is covered" },
  defocus: { kind: "tamper", detail: "The picture is out of focus" },
  scenechangedetection: { kind: "tamper", detail: "The scene changed: the camera may have been moved" },
  videoloss: { kind: "video_loss", detail: "Video loss: no video signal" },
  diskfull: { kind: "device_fault", detail: "The storage is full" },
  hdfull: { kind: "device_fault", detail: "The storage is full" },
  diskerror: { kind: "device_fault", detail: "Storage error: the disk or memory card failed" },
  hderror: { kind: "device_fault", detail: "Storage error: the disk or memory card failed" },
  storagedetection: { kind: "device_fault", detail: "The storage reports a health problem" },
  recordingfailure: { kind: "device_fault", detail: "Recording failed" },
  recordexception: { kind: "device_fault", detail: "Recording failed" },
  nicbroken: { kind: "device_fault", detail: "The network connection was lost" },
  ipconflict: { kind: "device_fault", detail: "IP address conflict: another device uses the camera's address" },
  illaccess: { kind: "illegal_login", detail: "Failed login: someone tried to sign in to the camera with a wrong user name or password" },
  illegalaccess: { kind: "illegal_login", detail: "Failed login: someone tried to sign in to the camera with a wrong user name or password" },
};

/** Hikvision repeats an ongoing alarm about every second; quiet for this long means it ended. */
export const HIKVISION_REPEAT_MS = 120_000;

const tag = (xml: string, name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i").exec(xml)?.[1];

/** One EventNotificationAlert document → the event it reports, or null for events that are not about the camera's health. */
export function hikvisionEvent(xml: string): CameraEvent | null {
  const type = tag(xml, "eventType");
  if (!type) return null;
  const known = HIKVISION[type.toLowerCase()];
  if (!known) return null;
  const state = /^inactive$/i.test(tag(xml, "eventState") ?? "active") ? "inactive" : "active";
  const ch = Number(tag(xml, "channelID") ?? tag(xml, "dynChannelID") ?? tag(xml, "inputIOPortID"));
  return {
    kind: known.kind,
    state,
    type,
    detail: known.detail,
    ...(Number.isInteger(ch) && ch > 0 ? { channel: ch } : {}),
    ...(state === "active" ? { repeatsWithinMs: HIKVISION_REPEAT_MS } : {}),
  };
}

/** Dahua event code → what it means. */
const DAHUA: Record<string, { kind: CameraEventKind; detail: string }> = {
  videoblind: { kind: "tamper", detail: "Video tampering: the camera's view is covered" },
  scenechange: { kind: "tamper", detail: "The scene changed: the camera may have been moved" },
  videoabnormaldetection: { kind: "tamper", detail: "The picture is abnormal (covered, out of focus or changed)" },
  videoloss: { kind: "video_loss", detail: "Video loss: no video signal" },
  storagefailure: { kind: "device_fault", detail: "Storage error: the disk or memory card failed" },
  storagenotexist: { kind: "device_fault", detail: "No storage: the disk or memory card is missing" },
  storagelowspace: { kind: "device_fault", detail: "The storage is nearly full" },
  storageerror: { kind: "device_fault", detail: "Storage error: the disk or memory card failed" },
  recordfailed: { kind: "device_fault", detail: "Recording failed" },
  netabort: { kind: "device_fault", detail: "The network connection was lost" },
  ipconflict: { kind: "device_fault", detail: "IP address conflict: another device uses the camera's address" },
  loginfailure: { kind: "illegal_login", detail: "Failed login: someone tried to sign in to the camera with a wrong user name or password" },
};

/** One Dahua event line ("Code=VideoBlind;action=Start;index=0") → its event, or null. */
export function dahuaEvent(line: string): CameraEvent | null {
  const fields = Object.fromEntries(line.split(";").map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? [p.trim().toLowerCase(), ""] : [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()];
  }));
  const code = fields.code;
  if (!code) return null;
  const known = DAHUA[code.toLowerCase()];
  if (!known) return null;
  const action = (fields.action ?? "Start").toLowerCase();
  // Dahua numbers channels from 0.
  const index = Number(fields.index);
  return {
    kind: known.kind,
    state: action === "stop" ? "inactive" : "active",
    type: code,
    detail: known.detail,
    ...(Number.isInteger(index) && index >= 0 ? { channel: index + 1 } : {}),
    // A pulse is a moment (a failed login); Start lasts until its Stop.
    ...(action === "pulse" ? { repeatsWithinMs: 0 } : {}),
  };
}

const MAX_PENDING = 1024 * 1024;

/**
 * Reads a Hikvision alert stream as it arrives (multipart, with XML documents and sometimes
 * pictures) and hands over each event. The stream is read for the XML documents only, so parts
 * without a Content-Length and firmware that frames them differently are read alike.
 */
export class HikvisionEventReader {
  private pending = "";
  constructor(private readonly onEvent: (e: CameraEvent) => void) {}

  push(chunk: Buffer) {
    this.pending += chunk.toString("latin1");
    for (;;) {
      const start = this.pending.search(/<EventNotificationAlert[\s>]/);
      if (start < 0) {
        // Keep only what could be the start of a tag.
        this.pending = this.pending.slice(-32);
        return;
      }
      const end = this.pending.indexOf("</EventNotificationAlert>", start);
      if (end < 0) {
        this.pending = this.pending.slice(start);
        if (this.pending.length > MAX_PENDING) this.pending = "";
        return;
      }
      const xml = this.pending.slice(start, end + 25);
      this.pending = this.pending.slice(end + 25);
      const e = hikvisionEvent(Buffer.from(xml, "latin1").toString("utf8"));
      if (e) this.onEvent(e);
    }
  }
}

/** Reads a Dahua event stream (multipart text/plain parts of "Code=...;action=...;index=..." lines). */
export class DahuaEventReader {
  private pending = "";
  constructor(private readonly onEvent: (e: CameraEvent) => void) {}

  push(chunk: Buffer) {
    this.pending += chunk.toString("utf8");
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    if (this.pending.length > MAX_PENDING) this.pending = "";
    for (const line of lines) {
      if (!/^\s*Code=/i.test(line)) continue;
      const e = dahuaEvent(line.trim());
      if (e) this.onEvent(e);
    }
  }
}
