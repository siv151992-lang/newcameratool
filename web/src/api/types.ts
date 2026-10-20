// Mirrors the server's API shapes (server/src/services/*). Passwords never appear here.

export type ConnectionStatus = "online" | "offline" | "unknown";
export type StorageHealth = "healthy" | "warning" | "critical" | "unknown";
export type Severity = "info" | "warning" | "critical";
export type RecordingState = "recording" | "idle" | "error" | "unknown";

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "operator" | "viewer";
  permissions: string[];
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
  warningThreshold: number | null;
  criticalThreshold: number | null;
  hasCaCertificate: boolean;
  username: string | null;
  credentialsUpdatedAt: string | null;
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
    recording: { state: RecordingState; detail: string | null; checkedAt: string | null };
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

export interface CameraDetail extends Camera {
  devices: StorageDevice[];
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
  alerts: { active: number; acknowledged: number; critical: number };
}

export interface DiagnosticStep {
  key: "reachability" | "authentication" | "api" | "storage";
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
  deviceInfoRefreshHours: number;
  historyRetentionDays: number;
  auditRetentionDays: number;
}

export interface NotificationChannel {
  id: string;
  type: "email";
  name: string;
  enabled: boolean;
  config: { recipients?: string[] };
  minSeverity: Severity;
  cooldownMinutes: number;
  notifyOnRecovery: boolean;
}

export interface ManagedUser {
  id: string;
  username: string;
  displayName: string | null;
  role: User["role"];
  isActive: boolean;
  lastLoginAt: string | null;
  locked: boolean;
  createdAt: string;
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
  cameras: CameraInsight[];
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
