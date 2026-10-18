// Mirrors the server's API shapes (server/src/services/*). Passwords never appear here.

export type ConnectionStatus = "online" | "offline" | "unknown";
export type StorageHealth = "healthy" | "warning" | "critical" | "unknown";
export type Severity = "info" | "warning" | "critical";

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
