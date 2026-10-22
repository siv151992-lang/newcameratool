import { z } from "zod";
import { pool, type Queryable } from "../db/pool.js";

export const monitoringSettingsSchema = z
  .object({
    pollIntervalSeconds: z.number().int().min(60).max(86400),
    concurrency: z.number().int().min(1).max(1000),
    requestTimeoutMs: z.number().int().min(1000).max(60000),
    maxRetries: z.number().int().min(0).max(5),
    retryBaseDelayMs: z.number().int().min(100).max(30000),
    offlineFailureThreshold: z.number().int().min(1).max(20),
    authFailureThreshold: z.number().int().min(1).max(20),
    storageUnavailableMinutes: z.number().int().min(1).max(10080),
    warningThresholdPercent: z.number().min(1).max(100),
    criticalThresholdPercent: z.number().min(1).max(100),
    fullThresholdPercent: z.number().min(1).max(100),
    recoveryHysteresisPercent: z.number().min(0).max(20),
    storageUsageAlertsEnabled: z.boolean(),
    recordingAlertsEnabled: z.boolean(),
    deviceInfoRefreshHours: z.number().int().min(1).max(720),
    historyRetentionDays: z.number().int().min(1).max(3650),
    /** Routine successful checks are kept in history at most this often per camera; 0 keeps every check. */
    historyIntervalMinutes: z.number().int().min(0).max(1440),
    auditRetentionDays: z.number().int().min(30).max(3650),
  })
  .strict();

export type MonitoringSettings = z.infer<typeof monitoringSettingsSchema>;

export const DEFAULT_MONITORING_SETTINGS: MonitoringSettings = {
  pollIntervalSeconds: 300,
  concurrency: 10,
  requestTimeoutMs: 10000,
  maxRetries: 2,
  retryBaseDelayMs: 1000,
  offlineFailureThreshold: 3,
  authFailureThreshold: 2,
  storageUnavailableMinutes: 30,
  warningThresholdPercent: 80,
  criticalThresholdPercent: 90,
  fullThresholdPercent: 100,
  recoveryHysteresisPercent: 2,
  storageUsageAlertsEnabled: true,
  recordingAlertsEnabled: true,
  deviceInfoRefreshHours: 24,
  historyRetentionDays: 90,
  historyIntervalMinutes: 15,
  auditRetentionDays: 365,
};

function checkOrdering(s: MonitoringSettings) {
  if (!(s.warningThresholdPercent < s.criticalThresholdPercent && s.criticalThresholdPercent <= s.fullThresholdPercent)) {
    throw new z.ZodError([
      { code: "custom", path: ["warningThresholdPercent"], message: "Thresholds must satisfy warning < critical ≤ full" },
    ]);
  }
}

export async function getMonitoringSettings(db: Queryable = pool): Promise<MonitoringSettings> {
  const { rows } = await db.query<{ value: Partial<MonitoringSettings> }>(
    "SELECT value FROM app_settings WHERE key = 'monitoring'",
  );
  const merged = { ...DEFAULT_MONITORING_SETTINGS, ...(rows[0]?.value ?? {}) };
  // Ignore unknown/invalid stored keys rather than failing monitoring.
  const parsed = monitoringSettingsSchema.safeParse(
    Object.fromEntries(Object.keys(DEFAULT_MONITORING_SETTINGS).map((k) => [k, merged[k as keyof MonitoringSettings]])),
  );
  return parsed.success ? parsed.data : DEFAULT_MONITORING_SETTINGS;
}

export async function updateMonitoringSettings(
  patch: Partial<MonitoringSettings>,
  userId: string | null,
  db: Queryable = pool,
): Promise<MonitoringSettings> {
  const current = await getMonitoringSettings(db);
  const next = monitoringSettingsSchema.parse({ ...current, ...patch });
  checkOrdering(next);
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ('monitoring', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(next), userId],
  );
  return next;
}
