/** Normalised, vendor-neutral types shared by all camera brand adapters. */

export type DeviceHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type StorageHealth = "healthy" | "warning" | "critical" | "unknown";

export const ERROR_CODES = [
  "INVALID_HOST", "HOST_NOT_ALLOWED", "DNS_FAILED",          // configuration / SSRF guard
  "UNREACHABLE", "TIMEOUT", "TLS_ERROR",                      // network: counts towards offline
  "AUTH_FAILED", "AUTH_METHOD_INSECURE", "PERMISSION_DENIED", // reachable, credentials rejected
  "API_UNAVAILABLE", "API_ERROR", "INVALID_RESPONSE",         // reachable, storage API problem
  "CREDENTIALS_UNAVAILABLE", "UNSUPPORTED_BRAND",             // local problems
] as const;
export type CameraErrorCode = (typeof ERROR_CODES)[number];

/** Errors that mean "we could not talk to the device at all". */
export const NETWORK_ERROR_CODES: ReadonlySet<CameraErrorCode> = new Set([
  "UNREACHABLE", "TIMEOUT", "TLS_ERROR", "DNS_FAILED",
]);
export const AUTH_ERROR_CODES: ReadonlySet<CameraErrorCode> = new Set([
  "AUTH_FAILED", "AUTH_METHOD_INSECURE", "PERMISSION_DENIED",
]);

export const ERROR_DESCRIPTIONS: Record<CameraErrorCode, string> = {
  INVALID_HOST: "The camera address is not a valid IP address or hostname",
  HOST_NOT_ALLOWED: "The camera address is outside the allowed camera networks",
  DNS_FAILED: "The camera hostname could not be resolved",
  UNREACHABLE: "Camera unreachable (connection refused or no route)",
  TIMEOUT: "Camera did not respond in time",
  TLS_ERROR: "HTTPS connection failed (certificate or protocol problem)",
  AUTH_FAILED: "Authentication failed: username or password rejected",
  AUTH_METHOD_INSECURE: "Camera only offers Basic authentication over plain HTTP",
  PERMISSION_DENIED: "Camera user lacks permission for this API",
  API_UNAVAILABLE: "Storage API not available on this device",
  API_ERROR: "Camera API returned an error",
  INVALID_RESPONSE: "Camera returned a response that could not be understood",
  CREDENTIALS_UNAVAILABLE: "Stored credentials could not be decrypted",
  UNSUPPORTED_BRAND: "No working integration exists for this brand",
};

export class CameraApiError extends Error {
  constructor(
    public readonly code: CameraErrorCode,
    message: string,
    public readonly options: { transient?: boolean; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = "CameraApiError";
  }
  get transient() {
    return this.options.transient ?? false;
  }
}

export interface CameraConfig {
  host: string;
  port: number;
  protocol: "http" | "https";
  username: string;
  password: string;
  caCertificate?: string | null;
  timeoutMs: number;
}

export interface StorageDeviceStatus {
  id: string;
  name?: string;
  type?: string;
  healthStatus: DeviceHealth;
  rawStatus?: string;
  totalBytes?: number;
  freeBytes?: number;
  usedBytes?: number;
  usedPercentage?: number;
  writable?: boolean;
  property?: string;
  formatType?: string;
}

/** What an adapter returns: raw device readings. Threshold evaluation happens in the monitor. */
export interface StorageReading {
  devices: StorageDeviceStatus[];
  totalBytes?: number;
  freeBytes?: number;
  usedBytes?: number;
  usedPercentage?: number;
}

/** Whether the camera is recording right now, normalised across brands. */
export type RecordingState = "recording" | "idle" | "error" | "unknown";

export interface RecordingChannelStatus {
  id: string;
  state: RecordingState;
  /** Status as reported by the camera, e.g. "NotRecording" or "0". */
  rawStatus?: string;
  /** Recording mode or trigger if reported, e.g. "Schedule" or "Continuous". */
  mode?: string;
}

export interface RecordingReading {
  state: RecordingState;
  channels: RecordingChannelStatus[];
  /** Short human-readable summary of what the camera reported. */
  detail?: string;
}

export interface DeviceInfo {
  deviceName?: string;
  model?: string;
  serialNumber?: string;
  firmwareVersion?: string;
  macAddress?: string;
}

export type DiagnosticKey = "reachability" | "authentication" | "api" | "storage";
export interface DiagnosticStep {
  key: DiagnosticKey;
  label: string;
  status: "passed" | "failed" | "warning" | "skipped";
  message: string;
}

export interface ConnectionResult {
  ok: boolean;              // storage could be read
  reachable: boolean;
  steps: DiagnosticStep[];
  deviceInfo?: DeviceInfo;
  storage?: StorageReading;
  error?: { code: CameraErrorCode; message: string };
}

export interface BrandMeta {
  key: string;
  displayName: string;
  supportStatus: "supported" | "unverified" | "planned";
  authMethods: string[];
  defaultPorts: { http: number; https: number };
  capabilities: string[];
  storageEndpoint?: string;
  defaultTimeoutMs?: number;
  notes: string;
}

export interface CameraBrandAdapter {
  readonly meta: BrandMeta;
  testConnection(camera: CameraConfig): Promise<ConnectionResult>;
  getStorageStatus(camera: CameraConfig): Promise<StorageReading>;
  getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo>;
  /** Optional: brands without a recording-status API leave it out and report "unknown". */
  getRecordingStatus?(camera: CameraConfig): Promise<RecordingReading>;
}
