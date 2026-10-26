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
    public readonly options: {
      transient?: boolean;
      httpStatus?: number;
      /** For INVALID_RESPONSE from configurable integrations: unparseable body, mapping failure or no storage data. */
      kind?: "format" | "mapping" | "no_storage";
    } = {},
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

/** One channel (camera) of an NVR. */
export interface NvrChannel {
  /** Channel number, from 1. */
  channel: number;
  name?: string;
  /** Whether the NVR has video from the camera on this channel (false: video loss / disconnected). */
  online?: boolean;
  recording?: RecordingState;
}

export interface RecordingReading {
  state: RecordingState;
  channels: RecordingChannelStatus[];
  /** Short human-readable summary of what the camera reported. */
  detail?: string;
}

export interface RecordingRange {
  /** Oldest recording, camera wall-clock time (YYYY-MM-DDTHH:MM:SS). */
  oldest: string;
  /** Days of recordings available: from the oldest recording to the camera's time now. */
  days: number;
  /** The camera only answered a shorter search, which found recordings from its very start: at least `days`. */
  atLeast?: boolean;
}

export interface RecordedSegment {
  start: number;
  end: number;
  ref?: string;
}
export interface RecordingList {
  segments: RecordedSegment[];
  nowMs: number;
  shiftMs: number;
  /** Playback starts at the beginning of the chosen recording, not at any time inside it. */
  playsFromRecordingStart?: boolean;
}

/** Merges touching or overlapping segments (2 s tolerance) and sorts them. */
export function mergeSegments(segments: RecordedSegment[]): RecordedSegment[] {
  const merged: RecordedSegment[] = [];
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && !s.ref && !last.ref && s.start <= last.end + 2000) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
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
  /** Integration version, e.g. "1.0.0" for a built-in adapter or "3" for a configuration version. */
  version?: string;
  /** For configurable integrations: the configuration version number in use. */
  configVersion?: number;
  /** "builtin": a trusted adapter in this code base (Mode B). "configurable": defined in the UI (Mode A). */
  integrationType?: "builtin" | "configurable";
  /** Which camera credentials the integration uses. Built-in adapters use username + password. */
  credentials?: "user_password" | "secret" | "none";
  /** Protocol a new camera of this brand starts with. */
  defaultProtocol?: "http" | "https";
  /** Compatibility notes: models and firmware known to work. */
  compatibility?: string;
}

export interface CameraBrandAdapter {
  readonly meta: BrandMeta;
  testConnection(camera: CameraConfig): Promise<ConnectionResult>;
  getStorageStatus(camera: CameraConfig): Promise<StorageReading>;
  getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo>;
  /** Optional: brands without a recording-status API leave it out and report "unknown". */
  getRecordingStatus?(camera: CameraConfig): Promise<RecordingReading>;
  /** How far back the recordings on the camera's own storage go; null when it holds none. */
  getRecordingRange?(camera: CameraConfig): Promise<RecordingRange | null>;
  /**
   * Optional: recorded segments on the camera's own storage between two camera local times,
   * merged and sorted, with the camera's local time now. Playback times are local time minus
   * `shiftMs` (e.g. UTC for cameras that play back in UTC). `ref` identifies a recording for
   * brands that play a recording by its id rather than from a time.
   */
  listRecordings?(camera: CameraConfig, fromMs: number, toMs: number, channel?: number): Promise<RecordingList>;
  /**
   * Optional: the RTSP path that plays the recordings from `startMs` (local time minus shiftMs).
   * Brands that play by recording id get the segment containing it, and play from its start.
   */
  playbackRtspPath?(startMs: number, segment?: RecordedSegment, channel?: number): string;
  /**
   * Optional: the replay address (without credentials) of the recording holding `segment`, asked from
   * the camera (ONVIF Profile G GetReplayUri). It plays through the replay relay, which adds the
   * start time; used by brands without playbackRtspPath.
   */
  replayRtspUrl?(camera: CameraConfig, segment?: RecordedSegment): Promise<string>;
  /** Optional: the full RTSP address (without credentials) of the live stream, asked from the camera (ONVIF). */
  liveRtspUrl?(camera: CameraConfig): Promise<string>;
  /** Optional: the RTSP path of a stream browsers can play (H.264, usually the second stream), for live video. */
  readonly rtspPath?: string;
  /** Optional, for NVRs: each channel's camera name, whether it has video and whether it is recording. */
  getChannels?(camera: CameraConfig): Promise<NvrChannel[]>;
  /** Optional: other RTSP paths to try for live video when rtspPath does not answer (other streams, models or firmware). */
  readonly rtspFallbacks?: readonly string[];
  /** Optional: the current picture, for the live view. */
  getSnapshot?(camera: CameraConfig, channel?: number): Promise<{ contentType: "image/jpeg" | "image/png"; data: Buffer }>;
  /** Optional, for NVRs: the RTSP paths of a channel's live video, to try in order (sub stream first). */
  channelRtspPaths?(channel: number): string[];
}
