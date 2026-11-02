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
/** A stream holding pictures (ANPR) may hold this much before a part is complete. */
const MAX_PENDING_WITH_PICTURES = 6 * 1024 * 1024;
const MAX_PICTURE = 2 * 1024 * 1024;

/** A number plate read by an ANPR camera, with the pictures it sent of it. */
export interface PlateRead {
  /** As the camera read it. */
  plate: string;
  /** approach: driving towards the camera; leave: away from it. */
  direction?: "approach" | "leave";
  confidence?: number;
  vehicleType?: string;
  vehicleColor?: string;
  /** UTC epoch ms, when the camera gives it. */
  at?: number;
  /** The vehicle's picture (detection) and the plate's (close-up), JPEG. */
  pictures: { kind: string; data: Buffer }[];
}

/** No plate: what cameras send when they saw a vehicle but could not read its plate. */
const NO_PLATE = /^(|unknown|noplate|no plate|none|-+|0+)$/i;

/** An ANPR EventNotificationAlert → its plate read (without pictures), or null. */
export function hikvisionPlate(xml: string): PlateRead | null {
  if (!/<eventType>\s*ANPR\s*<\/eventType>/i.test(xml)) return null;
  const anpr = /<ANPR>([\s\S]*?)<\/ANPR>/i.exec(xml)?.[1] ?? xml;
  const plate = (tag(anpr, "licensePlate") ?? "").trim();
  if (NO_PLATE.test(plate)) return null;
  const dir = (tag(anpr, "direction") ?? "").toLowerCase();
  const vehicle = /<vehicleInfo>([\s\S]*?)<\/vehicleInfo>/i.exec(anpr)?.[1] ?? "";
  const confidence = Number(tag(anpr, "confidenceLevel"));
  const at = Date.parse(tag(xml, "dateTime") ?? "");
  const type = tag(vehicle, "vehicleType") ?? tag(anpr, "vehicleType");
  const color = tag(vehicle, "color");
  return {
    plate,
    ...(dir === "forward" ? { direction: "approach" as const } : dir === "reverse" ? { direction: "leave" as const } : {}),
    ...(Number.isFinite(confidence) && confidence > 0 ? { confidence } : {}),
    ...(type && !/^unknown$/i.test(type) ? { vehicleType: type } : {}),
    ...(color && !/^unknown$/i.test(color) ? { vehicleColor: color } : {}),
    ...(Number.isFinite(at) ? { at } : {}),
    pictures: [],
  };
}

/**
 * Reads a Hikvision alert stream as it arrives (multipart parts: XML documents, and for ANPR the
 * pictures of the vehicle and plate) and hands over each event and each plate read. Parts are read
 * by their Content-Length where given; XML documents without one by their closing tag, so firmware
 * that frames them differently (or not at all) is read alike.
 */
export class HikvisionEventReader {
  private pending = "";
  private plate?: PlateRead;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly onEvent: (e: CameraEvent) => void,
    private readonly onPlate?: (p: PlateRead) => void,
    /** A plate's pictures come right after it: it is handed over this long after its last part. */
    private readonly pictureWaitMs = 1500,
  ) {}

  push(chunk: Buffer) {
    this.pending += chunk.toString("latin1");
    for (;;) {
      const xmlAt = this.pending.search(/<EventNotificationAlert[\s>]/);
      const header = /Content-Type:/i.exec(this.pending);
      if (header && (xmlAt < 0 || header.index < xmlAt)) {
        if (!this.headedPart(header.index)) return;
      } else if (xmlAt >= 0) {
        const end = this.pending.indexOf("</EventNotificationAlert>", xmlAt);
        if (end < 0) return this.wait(xmlAt);
        const xml = this.pending.slice(xmlAt, end + 25);
        this.pending = this.pending.slice(end + 25);
        this.document(xml);
      } else {
        // Keep only what could be the start of a header or tag.
        this.pending = this.pending.slice(-64);
        return;
      }
    }
  }

  /** Hands over a plate still waiting for pictures (the stream ended). */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const p = this.plate;
    this.plate = undefined;
    if (p) this.onPlate?.(p);
  }

  /** A part with headers at `at`: false when it is not complete yet. */
  private headedPart(at: number): boolean {
    const end = this.pending.indexOf("\r\n\r\n", at);
    if (end < 0) {
      this.wait(at);
      return false;
    }
    // The headers: from the boundary line before them (Content-Disposition may come first).
    const blockStart = Math.max(this.pending.lastIndexOf("\n--", at), 0);
    const headers = this.pending.slice(blockStart, end);
    const type = /Content-Type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim().toLowerCase() ?? "";
    const length = Number(/Content-Length:\s*(\d+)/i.exec(headers)?.[1] ?? NaN);
    const bodyStart = end + 4;
    let body: string;
    let next: number;
    if (Number.isFinite(length)) {
      if (this.pending.length < bodyStart + length) {
        this.wait(blockStart);
        return false;
      }
      body = this.pending.slice(bodyStart, bodyStart + length);
      next = bodyStart + length;
    } else if (/xml/.test(type)) {
      const close = this.pending.indexOf("</EventNotificationAlert>", bodyStart);
      if (close < 0) {
        this.wait(blockStart);
        return false;
      }
      body = this.pending.slice(bodyStart, close + 25);
      next = close + 25;
    } else {
      const boundary = this.pending.indexOf("\r\n--", bodyStart);
      if (boundary < 0) {
        this.wait(blockStart);
        return false;
      }
      body = this.pending.slice(bodyStart, boundary);
      next = boundary;
    }
    this.pending = this.pending.slice(next);
    if (type.startsWith("image/")) this.picture(headers, body);
    else if (/xml/.test(type) || body.includes("<EventNotificationAlert")) {
      const start = body.search(/<EventNotificationAlert[\s>]/);
      if (start >= 0) this.document(body.slice(start));
    }
    return true;
  }

  private wait(keepFrom: number) {
    this.pending = this.pending.slice(keepFrom);
    if (this.pending.length > (this.onPlate ? MAX_PENDING_WITH_PICTURES : MAX_PENDING)) this.pending = "";
  }

  private document(latin1: string) {
    const xml = Buffer.from(latin1, "latin1").toString("utf8");
    const plate = this.onPlate ? hikvisionPlate(xml) : null;
    if (plate) {
      this.flush();
      this.plate = plate;
      this.schedule();
      return;
    }
    if (/<eventType>\s*ANPR\s*<\/eventType>/i.test(xml)) {
      // A vehicle without a readable plate: its pictures are not kept.
      this.flush();
      return;
    }
    const e = hikvisionEvent(xml);
    if (e) this.onEvent(e);
  }

  private picture(headers: string, body: string) {
    if (!this.plate || this.plate.pictures.length >= 3 || body.length > MAX_PICTURE) return;
    const name = /(?:filename|name)="?([^";\r\n]+)/i.exec(headers)?.[1] ?? "picture.jpg";
    const kind = /plate/i.test(name) ? "plate" : /detect|vehicle|scene/i.test(name) ? "vehicle" : "picture";
    this.plate.pictures.push({ kind, data: Buffer.from(body, "latin1") });
    this.schedule();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.pictureWaitMs);
    this.timer.unref?.();
  }
}

/** Dahua (and CP Plus) traffic events that carry a plate read. */
const DAHUA_PLATE_CODES = /^(TrafficJunction|TrafficGate|TrafficSnap|TrafficManualSnap|TrafficParkingSpace\w*|ANPR|VehicleRecognition)$/i;

/** A Dahua traffic event's data → its plate read, or null. */
export function dahuaPlate(code: string, data: Record<string, unknown>): PlateRead | null {
  if (!DAHUA_PLATE_CODES.test(code)) return null;
  const car = (data.TrafficCar ?? {}) as Record<string, unknown>;
  const object = (data.Object ?? {}) as Record<string, unknown>;
  const plate = String(car.PlateNumber ?? object.Text ?? "").trim();
  if (NO_PLATE.test(plate)) return null;
  const driving = Array.isArray(data.DrivingDirection) ? String(data.DrivingDirection[0] ?? "") : String(car.Direction ?? data.Direction ?? "");
  const vehicle = (data.Vehicle ?? {}) as Record<string, unknown>;
  const color = car.VehicleColor ?? (vehicle.Color as string | undefined);
  const type = car.VehicleType ?? vehicle.Category;
  const confidence = Number(object.Confidence ?? car.Confidence);
  return {
    plate,
    ...(/approach|come|in\b|forward/i.test(driving) ? { direction: "approach" as const } : /leave|away|out\b|reverse|back/i.test(driving) ? { direction: "leave" as const } : {}),
    ...(Number.isFinite(confidence) && confidence > 0 ? { confidence } : {}),
    ...(typeof type === "string" && type ? { vehicleType: type } : {}),
    ...(typeof color === "string" && color ? { vehicleColor: color } : {}),
    pictures: [],
  };
}

/**
 * Reads a Dahua event stream (multipart text/plain parts of "Code=...;action=...;index=..." lines;
 * traffic events add ";data={ ... }" over several lines) and hands over events and plate reads.
 */
export class DahuaEventReader {
  private pending = "";
  /** An event whose data block has not ended yet. */
  private open?: { head: string; data: string[]; depth: number };

  constructor(private readonly onEvent: (e: CameraEvent) => void, private readonly onPlate?: (p: PlateRead) => void) {}

  push(chunk: Buffer) {
    this.pending += chunk.toString("utf8");
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    if (this.pending.length > MAX_PENDING) this.pending = "";
    for (const raw of lines) {
      if (this.open) {
        this.open.data.push(raw);
        this.open.depth += depth(raw);
        if (this.open.depth <= 0) this.finish();
        else if (this.open.data.length > 2000) this.open = undefined;
        continue;
      }
      const line = raw.trim();
      if (!/^Code=/i.test(line)) continue;
      const dataAt = line.indexOf(";data=");
      if (dataAt >= 0) {
        const first = line.slice(dataAt + 6);
        this.open = { head: line.slice(0, dataAt), data: [first], depth: depth(first) };
        if (this.open.depth <= 0) this.finish();
        continue;
      }
      const e = dahuaEvent(line);
      if (e) this.onEvent(e);
    }
  }

  private finish() {
    const { head, data } = this.open!;
    this.open = undefined;
    const e = dahuaEvent(head);
    if (e) this.onEvent(e);
    const code = /Code=([^;]+)/i.exec(head)?.[1] ?? "";
    if (!this.onPlate || !DAHUA_PLATE_CODES.test(code)) return;
    try {
      const plate = dahuaPlate(code, JSON.parse(data.join("\n")) as Record<string, unknown>);
      if (plate) this.onPlate(plate);
    } catch {
      // A data block that is not JSON: no plate.
    }
  }
}

/** How many braces a line opens (minus those it closes), outside strings. */
function depth(line: string): number {
  let d = 0, inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && inString) i++;
    else if (c === '"') inString = !inString;
    else if (!inString && c === "{") d++;
    else if (!inString && c === "}") d--;
  }
  return d;
}
