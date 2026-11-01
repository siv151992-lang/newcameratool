import {
  type AccessEventCategory,
  type AccessReading,
  AUTH_ERROR_CODES,
  CameraApiError,
  type CameraBrandAdapter,
  type CameraConfig,
  type ConnectionResult,
  type DeviceInfo,
  type DiagnosticStep,
  NETWORK_ERROR_CODES,
} from "../types.js";

const LABELS = {
  reachability: "Network reachability",
  authentication: "Authentication",
  api: "Access control API",
  storage: "Readers and doors",
} as const;

const asError = (err: unknown) => (err instanceof CameraApiError ? err : new CameraApiError("API_ERROR", "Unexpected error while contacting the access system"));

/** Connection test for access systems: reachable, login, API, then its readers and doors. */
export async function runAccessDiagnostics(adapter: CameraBrandAdapter, camera: CameraConfig): Promise<ConnectionResult> {
  const steps: DiagnosticStep[] = [];
  const step = (key: DiagnosticStep["key"], status: DiagnosticStep["status"], message: string) => steps.push({ key, label: LABELS[key], status, message });
  let info: DeviceInfo;
  try {
    info = await adapter.getDeviceInfo(camera);
  } catch (err) {
    const e = asError(err);
    if (NETWORK_ERROR_CODES.has(e.code) || ["INVALID_HOST", "HOST_NOT_ALLOWED", "TLS_ERROR"].includes(e.code)) {
      step("reachability", "failed", e.message);
      step("authentication", "skipped", "Not attempted because the device could not be reached");
      step("api", "skipped", "Not attempted");
      step("storage", "skipped", "Not attempted");
      return { ok: false, reachable: false, steps, error: { code: e.code, message: e.message } };
    }
    step("reachability", "passed", `Connected to ${camera.host}:${camera.port} over ${camera.protocol.toUpperCase()}`);
    if (AUTH_ERROR_CODES.has(e.code)) {
      step("authentication", "failed", e.message);
      step("api", "skipped", "Not attempted because authentication failed");
    } else {
      step("authentication", "passed", "Credentials accepted");
      step("api", "failed", e.message);
    }
    step("storage", "skipped", "Not attempted");
    return { ok: false, reachable: true, steps, error: { code: e.code, message: e.message } };
  }
  step("reachability", "passed", `Connected to ${camera.host}:${camera.port} over ${camera.protocol.toUpperCase()}`);
  step("authentication", "passed", "Credentials accepted");
  const desc = [info.model, info.firmwareVersion && `version ${info.firmwareVersion}`].filter(Boolean).join(", ");
  step("api", "passed", desc ? `Responded (${desc})` : "Responded");
  let reading: AccessReading;
  try {
    reading = await adapter.getAccessStatus!(camera, Date.now() - 3600_000);
  } catch (err) {
    const e = asError(err);
    step("storage", "failed", e.message);
    return { ok: false, reachable: true, steps, deviceInfo: info, error: { code: e.code, message: e.message } };
  }
  step("storage", reading.points.length ? "passed" : "warning", describePoints(reading));
  return { ok: true, reachable: true, steps, deviceInfo: info, storage: { devices: [] } };
}

export function describePoints(r: AccessReading): string {
  const n = (kind: string) => r.points.filter((p) => p.kind === kind).length;
  const offline = r.points.filter((p) => p.online === false).length;
  const parts = [`${n("reader")} reader(s)`, `${n("door")} door(s)`, n("controller") ? `${n("controller")} controller(s)` : ""].filter(Boolean);
  if (!r.points.length) return "Responded, but lists no readers or doors (does this user see them?)";
  return `${parts.join(", ")}${offline ? `, ${offline} offline` : ""}; ${r.events.length} event(s) in the last hour${r.eventsError ? ` (events: ${r.eventsError})` : ""}`;
}

/** What an event is, from the system's own name or words for it. */
export function categorize(text: string): AccessEventCategory {
  const t = text.toLowerCase();
  if (/tamper|dismantl|anti.?dismantle/.test(t)) return "tamper";
  if (/forced|held|open too long|open timeout|opentoolong|abnormal/.test(t)) return "door";
  if (/denied|refus|fail|invalid|unknown (card|user|face|finger)|no right|not authori|expired|out of date|anti.?(sneak|passback)|duress|fake/.test(t)) return "denied";
  if (/granted|success|pass\b|passed|verified|accepted|legal|authori[sz]ed|allowed/.test(t)) return "granted";
  if (/offline|disconnect|not responding|comms|communication|network|failure|fault|power|battery|exception/.test(t)) return "fault";
  if (/door|lock|unlock|exit button|request to exit|rex/.test(t)) return "door";
  if (/alarm|intrusion|zone/.test(t)) return "alarm";
  return "other";
}

/** The path (and query) of an address the system gave, on this same system; other hosts are refused. */
export function samePath(camera: CameraConfig, href: string): string {
  const u = new URL(href, `${camera.protocol}://${camera.host}:${camera.port}`);
  const sameHost = u.hostname.replace(/^\[|\]$/g, "").toLowerCase() === camera.host.toLowerCase();
  if (!sameHost) throw new CameraApiError("INVALID_RESPONSE", "The access system pointed to another host; not followed");
  return u.pathname + u.search;
}

/** Refuses a login that would send a password or API key over plain HTTP. */
export function requireHttps(camera: CameraConfig, what: string) {
  if (camera.protocol !== "https") {
    throw new CameraApiError("AUTH_METHOD_INSECURE", `${what} would be sent in clear text over HTTP. Use HTTPS (the server's port for HTTPS).`);
  }
}

/** JSON from a response body, or INVALID_RESPONSE. */
export function json<T>(body: string, what: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new CameraApiError("INVALID_RESPONSE", `${what}: the reply is not JSON`);
  }
}
