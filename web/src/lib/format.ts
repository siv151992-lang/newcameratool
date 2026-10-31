const CAPABILITY_LABELS: Record<string, string> = {
  "storage-status": "Storage",
  "recording-status": "Recording",
  "device-info": "Device info",
  "connection-test": "Connection test",
  "multiple-storage-devices": "Multiple disks",
  nas: "NAS",
};
export const capabilityLabel = (c: string) => CAPABILITY_LABELS[c] ?? c;

/** Days of recordings: "Under 1 day", "3.5 days", "42 days". */
export function formatDays(days: number | null | undefined): string {
  if (days === null || days === undefined) return "—";
  if (days < 1) return "Under 1 day";
  return days < 10 ? `${days.toFixed(1)} days` : `${Math.round(days)} days`;
}

/** A camera clock offset: "Correct (within 2 s)", "12 min 30 s ahead", "2 h 5 min behind". */
export function describeClockOffset(seconds: number): string {
  const a = Math.abs(seconds);
  if (a <= 2) return "Correct (within 2 s)";
  const d = Math.floor(a / 86_400);
  const h = Math.floor((a % 86_400) / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = a % 60;
  const amount = d >= 1 ? `${d} day${d === 1 ? "" : "s"}${h ? ` ${h} h` : ""}` : h >= 1 ? `${h} h${m ? ` ${m} min` : ""}` : m >= 1 ? `${m} min${s ? ` ${s} s` : ""}` : `${s} s`;
  return `${amount} ${seconds > 0 ? "ahead" : "behind"}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatPercent(p: number | null | undefined): string {
  return p === null || p === undefined ? "—" : `${p.toFixed(p >= 99.95 || p === Math.round(p) ? 0 : 1)}%`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "Never";
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return diff <= 0 ? "just now" : "in a few seconds";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

export function absoluteTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "";
}

const dateTime = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
/** "24 Oct 2026, 10:41" in the viewer's time zone. */
export function formatDateTime(iso: string | null | undefined): string {
  return iso ? dateTime.format(new Date(iso)) : "—";
}

export const ERROR_LABELS: Record<string, string> = {
  UNREACHABLE: "Unreachable",
  TIMEOUT: "Timed out",
  DNS_FAILED: "DNS lookup failed",
  TLS_ERROR: "HTTPS/certificate error",
  AUTH_FAILED: "Authentication failed",
  AUTH_METHOD_INSECURE: "Insecure auth refused",
  PERMISSION_DENIED: "Permission denied",
  API_UNAVAILABLE: "Storage API unavailable",
  API_ERROR: "API error",
  INVALID_RESPONSE: "Invalid response",
  HOST_NOT_ALLOWED: "Address not allowed",
  INVALID_HOST: "Invalid address",
  CREDENTIALS_UNAVAILABLE: "Credentials unavailable",
  UNSUPPORTED_BRAND: "Unsupported brand",
};

export const ALERT_TYPE_LABELS: Record<string, string> = {
  offline: "Camera offline",
  auth_failure: "Authentication failure",
  storage_unavailable: "Storage unavailable",
  storage_usage: "Storage usage",
  disk_unhealthy: "Disk unhealthy",
  disk_readonly: "Read-only storage",
  no_storage_device: "No storage device",
  not_recording: "Not recording",
  password_change_due: "Camera password change due",
  nvr_channel: "NVR channel problem",
  recording_retention: "Recordings shorter than required",
  clock_wrong: "Camera clock is wrong",
  picture_problem: "Picture problem (black, covered, blurred, frozen, moved)",
  tamper: "Camera tampered with (reported by the camera)",
  video_loss: "Video loss (reported by the camera)",
  device_fault: "Fault reported by the camera (disk, network, recording)",
  illegal_login: "Failed logins on the camera",
};

/** Category of the last error, so users can tell unreachable vs auth vs API vs disk problems apart. */
export function errorCategory(code: string | null | undefined): string | null {
  if (!code) return null;
  if (["UNREACHABLE", "TIMEOUT", "DNS_FAILED", "TLS_ERROR"].includes(code)) return "Network";
  if (["AUTH_FAILED", "AUTH_METHOD_INSECURE", "PERMISSION_DENIED"].includes(code)) return "Authentication";
  if (["API_UNAVAILABLE", "API_ERROR", "INVALID_RESPONSE"].includes(code)) return "Camera API";
  return "Configuration";
}
