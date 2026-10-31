// Mirrors the server's API shapes (server/src/services/*). Passwords never appear here.

export type ConnectionStatus = "online" | "offline" | "unknown";
export type StorageHealth = "healthy" | "warning" | "critical" | "unknown";
export type Severity = "info" | "warning" | "critical";
export type RecordingState = "recording" | "idle" | "error" | "unknown";

export type Role = "admin" | "operator" | "viewer";

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  /** Role in the current organization; null when the user is not in one. */
  role: Role | null;
  permissions: string[];
  isSystemAdmin: boolean;
  organizationId: string | null;
  organizationName: string | null;
}

/** An organization the signed-in user belongs to. */
export interface Membership {
  id: string;
  name: string;
  role: Role;
}

/** An open invitation to the signed-in user's address. */
export interface PendingInvitation {
  id: string;
  organizationName: string;
  role: Role;
  expiresAt: string;
}

/** The invitation page, before signing in. */
export interface InvitationPreview {
  organizationName: string;
  role: Role;
  email: string;
  invitedBy: string | null;
  expiresAt: string;
  status: "pending" | "expired" | "accepted" | "revoked";
  accountExists: boolean;
}

/** An invitation in Settings → Users. */
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: InvitationPreview["status"];
  createdAt: string;
  sentAt: string;
  sendCount: number;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  invitedBy: string | null;
  acceptedBy: string | null;
}

/** Answer to inviting (or re-sending): the new link is shown once, to copy if the email could not be sent. */
export interface InvitationSent {
  id: string;
  link: string;
  /** The full link on the saved dashboard address, when one is set. */
  url?: string;
  emailSent: boolean;
  emailError?: string;
  outcome: "created" | "resent";
}

export interface SignInOptions {
  needsSetup: boolean;
  signupEnabled: boolean;
  passwordResetEnabled: boolean;
  invitationExpiryHours: number;
  emailVerificationExpiryHours: number;
  passwordResetExpiryMinutes: number;
  /** Sign in with Google / Zoho, when set up. */
  providers: ("google" | "zoho")[];
}

export interface Organization {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  members: number;
  admins: number;
  cameras: number;
}

export interface Camera {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: "http" | "https";
  brand: string;
  brandName: string;
  model: string | null;
  location: string | null;
  monitoringEnabled: boolean;
  /** False for cameras that record elsewhere (e.g. an NVR) and have no SD card by design. */
  localStorage: boolean;
  warningThreshold: number | null;
  criticalThreshold: number | null;
  hasCaCertificate: boolean;
  username: string | null;
  credentialsUpdatedAt: string | null;
  /** "critical": a critical area, listed first, problems raised as critical. */
  priority: "critical" | "normal";
  /** Planned work: no new alerts or notifications until then; null when not in maintenance. */
  maintenance: { until: string; note: string | null } | null;
  /** "nvr": a network video recorder (its hard disks and channels are checked). */
  deviceType: "camera" | "nvr";
  /** Whether the picture is checked (black, covered, blurred, frozen, moved). */
  pictureChecks: boolean;
  /** Whether the camera's event stream is kept open (tampering, video loss, faults, failed logins as they happen). */
  cameraEvents: boolean;
  /** The brand's integration has an event stream at all. */
  cameraEventsSupported: boolean;
  /** NVRs: channel counts, and why channels could not be read (null for cameras). */
  channels: { total: number; noVideo: number; notRecording: number; error: string | null; checkedAt: string | null } | null;
  /** The camera password against the organization's camera password policy. */
  password: { status: CameraPasswordStatus; issues: CameraPasswordIssue[]; changedAt: string | null };
  createdAt: string;
  updatedAt: string;
  status: {
    connection: ConnectionStatus;
    storageHealth: StorageHealth;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
    totalBytes: number | null;
    usedBytes: number | null;
    freeBytes: number | null;
    usedPercentage: number | null;
    nextCheckAt: string | null;
    checkInProgress: boolean;
    openAlerts: number;
    recording: {
      state: RecordingState;
      detail: string | null;
      checkedAt: string | null;
      /** Days of recordings on the camera's storage, from its oldest recording; null when not known. */
      daysAvailable: number | null;
      /** Oldest recording, camera wall-clock time (YYYY-MM-DDTHH:MM:SS). */
      oldest: string | null;
      rangeCheckedAt: string | null;
      /** Why the days of recordings could not be read. */
      rangeError: string | null;
      /** The camera only answered a shorter search: at least daysAvailable. */
      daysAtLeast: boolean;
    };
    /** The camera's clock: seconds ahead (+) or behind (-) the server; null when not read (error says why). */
    clock: { offsetSeconds: number | null; checkedAt: string | null; error: string | null };
    /** The picture as last checked; state null when not checked (error says why). */
    picture: { state: "ok" | "black" | "blank" | "blurred" | "frozen" | "moved" | null; detail: string | null; error: string | null; checkedAt: string | null };
    /** The camera's event stream: connected, unsupported or failed (error says why); null when not open. */
    events: { state: "connected" | "unsupported" | "failed" | null; error: string | null; since: string | null; lastEventAt: string | null };
  };
  device: { model: string | null; serialNumber: string | null; firmwareVersion: string | null };
}

export interface StorageDevice {
  id: string;
  name: string | null;
  type: string | null;
  healthStatus: "healthy" | "degraded" | "unhealthy" | "unknown";
  rawStatus: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  usedPercentage: number | null;
  writable: boolean | null;
  property: string | null;
  formatType: string | null;
  updatedAt: string;
}

export interface NvrChannel {
  channel: number;
  name: string | null;
  /** False: the NVR has no video from this camera. */
  online: boolean | null;
  recording: RecordingState | null;
  updatedAt: string;
}

export interface CameraDetail extends Camera {
  devices: StorageDevice[];
  /** NVRs: each channel (empty for cameras). */
  channelList: NvrChannel[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Summary {
  totalCameras: number;
  monitoredCameras: number;
  online: number;
  offline: number;
  unknown: number;
  disabled: number;
  storageWarning: number;
  storageCritical: number;
  recording: number;
  notRecording: number;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  camerasWithStorageData: number;
  /** Offline cameras whose last storage reading is left out of the capacity totals. */
  offlineWithStorageData: number;
  withoutLocalStorage: number;
  criticalArea: { total: number; offline: number; withProblems: number };
  /** Pictures that cannot be used, of the pictures checked (reachable cameras). */
  picture: { problems: number; checked: number };
  sdCard: { total: number; ok: number; error: number; camerasWithout: number; offlineNotCounted: number };
  nvr: { total: number; offline: number; disks: number; diskError: number; channels: number; channelsNoVideo: number; channelsNotRecording: number };
  alerts: { active: number; acknowledged: number; critical: number };
}

export interface DiagnosticStep {
  key: "config" | "reachability" | "authentication" | "api" | "storage";
  label: string;
  status: "passed" | "failed" | "warning" | "skipped";
  message: string;
}

export interface ConnectionResult {
  ok: boolean;
  reachable: boolean;
  steps: DiagnosticStep[];
  deviceInfo?: { model?: string; serialNumber?: string; firmwareVersion?: string; deviceName?: string };
  storage?: { totalBytes?: number; usedBytes?: number; freeBytes?: number; usedPercentage?: number; devices: unknown[] };
  error?: { code: string; message: string };
}

export interface HistoryCheck {
  checkedAt: string;
  trigger: "scheduled" | "manual";
  outcome: string;
  durationMs: number;
  attempts: number;
  storageHealth: StorageHealth | null;
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  usedPercentage: number | null;
  errorMessage: string | null;
  recordingState: RecordingState | null;
}

export interface CameraHistory {
  checks: HistoryCheck[];
  connectionEvents: { occurredAt: string; fromStatus: string; toStatus: string; reason: string | null }[];
}

export interface Alert {
  id: number;
  cameraId: string;
  cameraName: string;
  cameraHost: string;
  cameraPriority: "critical" | "normal";
  cameraRemoved: boolean;
  type: string;
  severity: Severity;
  status: "active" | "acknowledged" | "resolved";
  title: string;
  description: string;
  firstDetectedAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

export interface AlertDetail extends Alert {
  events: { eventType: string; severity: string | null; message: string | null; actor: string | null; createdAt: string }[];
}

export interface Brand {
  key: string;
  displayName: string;
  supportStatus: "supported" | "unverified" | "planned";
  authMethods: string[];
  defaultPorts: { http: number; https: number };
  capabilities: string[];
  storageEndpoint?: string;
  notes: string;
  cameraCount: number;
  version?: string;
  integrationType?: "builtin" | "configurable" | "alias";
  /** Which credentials cameras of this brand need: username + password, one API key/token, or none. */
  credentials?: "user_password" | "secret" | "none";
  defaultProtocol?: "http" | "https";
}

/** Settings → Email & sign-in (system administrator). The SMTP password is never returned. */
export interface EmailSettings {
  smtpHost: string | null;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPasswordSet: boolean;
  smtpFrom: string;
  publicUrl: string | null;
  allowSignup: boolean;
  invitationExpiryHours: number;
  emailVerificationExpiryHours: number;
  passwordResetExpiryMinutes: number;
  /** Values still taken from the server's environment variables (nothing saved here yet). */
  fromEnvironment: string[];
}

export interface NetworkSettings {
  allowedNetworks: string[];
  isDefault: boolean;
  camerasOutside: { id: string; name: string; host: string }[];
}

export interface MonitoringSettings {
  pollIntervalSeconds: number;
  concurrency: number;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  offlineFailureThreshold: number;
  authFailureThreshold: number;
  storageUnavailableMinutes: number;
  warningThresholdPercent: number;
  criticalThresholdPercent: number;
  fullThresholdPercent: number;
  recoveryHysteresisPercent: number;
  storageUsageAlertsEnabled: boolean;
  recordingAlertsEnabled: boolean;
  minRecordingDays: number;
  clockDriftAlertMinutes: number;
  pictureCheckMinutes: number;
  deviceInfoRefreshHours: number;
  historyRetentionDays: number;
  historyIntervalMinutes: number;
  auditRetentionDays: number;
}

export type WebhookFormat = "teams" | "slack" | "google_chat" | "generic";

export interface NotificationChannel {
  id: string;
  type: "email" | "webhook";
  name: string;
  enabled: boolean;
  /** Webhooks: the service and the address's host (the address itself is never returned). */
  config: { recipients?: string[]; format?: WebhookFormat; host?: string };
  /** A webhook address is stored (encrypted). */
  hasSecret?: boolean;
  minSeverity: Severity;
  cooldownMinutes: number;
  notifyOnRecovery: boolean;
}

/** A member of the current organization (Settings → Users). */
export interface ManagedUser {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  locked: boolean;
  joinedAt: string;
  /** Also a member of another organization: only the system administrator changes their account. */
  otherOrganizations: boolean;
}

export interface AuditEntry {
  id: number;
  actor_username: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  created_at: string;
  /** Camera entries only: the camera's name (null for other entries or bulk actions). */
  camera_name: string | null;
  camera_host: string | null;
  camera_removed: boolean;
}

export interface ImportRow {
  row: number;
  name?: string;
  ip?: string;
  brand?: string;
  model?: string;
  username?: string;
  password?: string;
  location?: string;
  port?: string;
  protocol?: string;
}

export interface ImportValidation {
  row: number;
  status: "valid" | "invalid" | "duplicate";
  errors: { field: string; message: string }[];
  camera?: { name: string; host: string; port: number; protocol: string; brand: string; model: string | null; location: string | null; username: string; usesSharedCredentials: boolean };
}

export interface ImportRowResult {
  row: number;
  status: "imported" | "skipped" | "failed";
  message: string;
  cameraId?: string;
  test?: { ok: boolean; code?: string; message: string };
}

// ------------------------------------------------------------------ AI Mode (server/src/ai/*)

export interface AiStatus {
  enabled: boolean;
  assistant: { available: boolean; model: string; reason?: string };
}

export type FindingSeverity = "info" | "warning" | "critical";

export interface Forecast {
  status: "insufficient_data" | "growing" | "stable" | "decreasing" | "full_overwriting";
  confidence: "high" | "medium" | "low" | null;
  notes: string[];
  current: { usedPercentage: number; usedBytes: number | null; totalBytes: number | null; freeBytes: number | null; measuredAt: number } | null;
  growthPercentPerDay: number | null;
  growthBytesPerDay: number | null;
  recentPercentPerDay: number | null;
  rSquared: number | null;
  daysToWarning: number | null;
  daysToCritical: number | null;
  warningAt: string | null;
  criticalAt: string | null;
  projections: { horizonDays: number; usedPercentage: number }[];
  period: { from: number; to: number; points: number; days: number } | null;
}

export interface Anomaly {
  type: string;
  severity: FindingSeverity;
  title: string;
  explanation: string;
  evidence: Record<string, unknown>;
}

export interface RecommendedAction {
  priority: "critical" | "high" | "medium" | "low";
  cameraId: string;
  cameraName: string;
  action: string;
  reason: string;
}

export interface CameraInsight {
  camera: {
    id: string;
    name: string;
    host: string;
    location: string | null;
    brand: string;
    monitoringEnabled: boolean;
    connection: ConnectionStatus;
    storageHealth: StorageHealth;
    recordingState: RecordingState;
    usedPercentage: number | null;
    totalBytes: number | null;
    usedBytes: number | null;
    freeBytes: number | null;
    lastSuccessAt: number | null;
    warningThreshold: number;
    criticalThreshold: number;
  };
  forecast: Forecast;
  anomalies: Anomaly[];
  health: { score: number; grade: "good" | "fair" | "poor" | "unknown"; factors: { label: string; impact: number }[] };
  actions: RecommendedAction[];
  link: string;
}

export interface FleetInsights {
  generatedAt: string;
  historyDays: number;
  /** Cameras needing attention plus those closest to critical; the summary covers all of them. */
  cameras: CameraInsight[];
  camerasShown: number;
  camerasTotal: number;
  actions: RecommendedAction[];
  summary: {
    cameras: number;
    monitored: number;
    offline: number;
    notRecording: number;
    storageCritical: number;
    storageWarning: number;
    criticalWithin7Days: number;
    anomalies: number;
    averageHealth: number | null;
  };
}

export interface CameraForecastView extends CameraInsight {
  actual: { t: string; usedPercentage: number }[];
  projected: { t: string; usedPercentage: number }[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantAnswer {
  answer: string;
  toolCalls: { name: string; input: unknown; isError: boolean }[];
  stopReason: string | null;
}

export interface MonitoringReport {
  title: string;
  period: "24h" | "7d";
  generatedAt: string;
  markdown: string;
  aiSummary?: string;
}

// ------------------------------------------------------------------ brand integrations

export type IntegrationStatus = "draft" | "tested" | "enabled" | "disabled";
export type CredentialMode = "user_password" | "secret" | "none";

export interface IntegrationSummary {
  key: string;
  displayName: string;
  manufacturer: string | null;
  description: string | null;
  integrationType: "builtin" | "configurable" | "alias";
  /** "Works like" brands: the built-in adapter they use. */
  basedOn: { key: string; displayName: string } | null;
  integrationVersion: string;
  status: IntegrationStatus;
  supportStatus: "supported" | "unverified" | "planned";
  cameraCount: number;
  authMethods: string[];
  capabilities: string[];
  credentials: CredentialMode;
  defaultProtocol: "http" | "https";
  defaultPorts: { http: number; https: number };
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastSuccessAt: string | null;
  activeVersion: number | null;
  latestVersion: number | null;
  latestVersionStatus: "untested" | "passed" | "failed" | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationVersion {
  id: string;
  version: number;
  testStatus: "untested" | "passed" | "failed";
  testedAt: string | null;
  changeNote: string | null;
  createdAt: string;
  createdBy: string | null;
  isActive: boolean;
}

export interface IntegrationDetail extends IntegrationSummary {
  supportedModels: string[];
  compatibilityNotes: string | null;
  storageEndpoint: string | null;
  notes: string | null;
  activeConfig: IntegrationConfig | null;
  latestConfig: IntegrationConfig | null;
  latestVersionId: string | null;
  versions: IntegrationVersion[];
}

export type AuthType = "none" | "basic" | "digest" | "api_key" | "bearer";
export type ByteUnit = "B" | "KB" | "MB" | "GB" | "TB" | "KiB" | "MiB" | "GiB" | "TiB";
export interface NameValue {
  name: string;
  value: string;
}

/** Declarative configuration of a configurable API integration (validated on the server). */
export interface IntegrationConfig {
  request: { method: "GET" | "POST"; path: string; query: NameValue[]; headers: NameValue[]; body?: string | null; contentType?: string | null; timeoutMs: number };
  auth: { type: AuthType; apiKeyIn?: "header" | "query"; apiKeyName?: string };
  pagination: { type: "none" } | { type: "page"; pageParam: string; firstPage: 0 | 1; pageSizeParam?: string; pageSize?: number; maxPages: number };
  response: {
    format: "json" | "xml";
    devicesPath: string;
    fields: {
      id?: string;
      name?: string;
      total: { path: string; unit: ByteUnit };
      free?: { path: string; unit: ByteUnit };
      used?: { path: string; unit: ByteUnit };
      health?: string;
      readWrite?: string;
    };
    healthValues: { healthy: string[]; degraded: string[]; unhealthy: string[]; absent: string[] };
    readWriteValues: { readWrite: string[]; readOnly: string[] };
  };
  deviceInfo: { path: string; query: NameValue[]; format: "json" | "xml"; fields: { deviceName?: string; model?: string; serialNumber?: string; firmwareVersion?: string } } | null;
  maxConcurrency: number;
}

export interface IntegrationDetails {
  displayName: string;
  manufacturer: string | null;
  description: string | null;
  supportedModels: string[];
  defaultProtocol: "http" | "https";
  defaultHttpPort: number;
  defaultHttpsPort: number;
  integrationVersion: string;
  compatibilityNotes: string | null;
}

export interface MappingFieldValue {
  field: string;
  path: string;
  raw?: string;
  value?: string | number | boolean;
  error?: string;
}

export interface MappingResult {
  devices: { index: number; fields: MappingFieldValue[]; device?: StorageDevice; skipped?: string }[];
  reading: { devices: StorageDevice[]; totalBytes?: number; freeBytes?: number; usedBytes?: number; usedPercentage?: number };
  errors: string[];
  warnings: string[];
  missing: string[];
}

export interface PreviewResult {
  ok: boolean;
  stage: "config" | "format" | "mapping";
  issues?: { field: string; message: string }[];
  message?: string;
  mapping?: MappingResult;
}

export type TestOutcome =
  | "OK" | "CONFIG_INVALID" | "DESTINATION_NOT_ALLOWED" | "NETWORK_FAILURE" | "AUTH_FAILURE" | "HTTP_FAILURE"
  | "INVALID_FORMAT" | "MAPPING_FAILURE" | "NO_STORAGE_DATA";

export interface IntegrationTestResult {
  ok: boolean;
  outcome: TestOutcome;
  outcomeLabel: string;
  message: string;
  steps: DiagnosticStep[];
  deviceInfo?: ConnectionResult["deviceInfo"];
  storage?: MappingResult["reading"];
  mapping?: MappingResult;
  sample?: string;
  durationMs: number;
  versionId: string | null;
  version: number | null;
}

export interface IntegrationTestRecord {
  id: string;
  version: number | null;
  targetHost: string;
  targetPort: number;
  ok: boolean;
  outcome: TestOutcome;
  message: string;
  steps: DiagnosticStep[];
  durationMs: number;
  createdAt: string;
  createdBy: string | null;
}

export interface IntegrationCamera {
  id: string;
  name: string;
  host: string;
  port: number;
  location: string | null;
  monitoringEnabled: boolean;
  connectionStatus: ConnectionStatus;
  storageHealth: StorageHealth;
  lastSuccessAt: string | null;
}

export type CameraPasswordStatus = "ok" | "weak" | "expired" | "unknown";
export type CameraPasswordIssue = "too_short" | "few_char_types" | "common" | "contains_username" | "repetitive";

/** Settings → Camera passwords: the standard for the cameras' own passwords. */
export interface CameraPasswordPolicy {
  minLength: number;
  minCharTypes: number;
  blockCommon: boolean;
  maxAgeDays: number;
  enforcement: "warn" | "block";
  changeAlerts: boolean;
  reminderDays: number;
}
export interface CameraPasswordPolicyView {
  policy: CameraPasswordPolicy;
  counts: { ok: number; weak: number; expired: number };
}

export interface CameraEventRow {
  id: string;
  occurredAt: string;
  kind: "tamper" | "video_loss" | "device_fault" | "illegal_login";
  eventType: string;
  state: "active" | "inactive";
  channel: number | null;
  detail: string;
}

export interface FirmwareModel {
  brand: string;
  brandName: string;
  model: string | null;
  cameras: number;
  unknown: number;
  outdated: number;
  newest: string | null;
  versions: { version: string; cameras: number }[];
}
export interface FirmwareInventory {
  summary: { cameras: number; unknown: number; outdated: number; models: number; versions: number };
  models: FirmwareModel[];
}
export interface FirmwareCamera {
  id: string;
  name: string;
  host: string;
  location: string | null;
  deviceType: "camera" | "nvr";
  firmwareVersion: string | null;
  serialNumber: string | null;
  readAt: string | null;
  connectionStatus: string | null;
  outdated: boolean;
}
