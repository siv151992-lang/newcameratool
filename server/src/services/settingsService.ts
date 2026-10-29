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
    /** Days of recordings each camera must hold (on its SD card or disk); 0 turns the alert off. */
    minRecordingDays: z.number().int().min(0).max(3650),
    /** Alert when a camera's clock is off by more than this many minutes; 0 turns the alert off. */
    clockDriftAlertMinutes: z.number().int().min(0).max(1440),
    /** How often each camera's picture is checked (black, covered, blurred, frozen, moved); 0 turns it off. */
    pictureCheckMinutes: z.number().int().min(0).max(1440),
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
  minRecordingDays: 0,
  clockDriftAlertMinutes: 5,
  pictureCheckMinutes: 30,
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

/**
 * Settings each organization chooses for its own cameras. The rest (worker capacity, timeouts,
 * retention) apply to the whole server and only the system administrator changes them.
 */
export const ORGANIZATION_SETTING_KEYS = [
  "pollIntervalSeconds", "offlineFailureThreshold", "authFailureThreshold", "storageUnavailableMinutes",
  "warningThresholdPercent", "criticalThresholdPercent", "fullThresholdPercent", "recoveryHysteresisPercent",
  "storageUsageAlertsEnabled", "recordingAlertsEnabled", "minRecordingDays", "clockDriftAlertMinutes", "pictureCheckMinutes",
] as const satisfies readonly (keyof MonitoringSettings)[];
const isOrgKey = (k: string) => (ORGANIZATION_SETTING_KEYS as readonly string[]).includes(k);

/** Server-wide values merged with `orgId`'s own (defaults where nothing is stored). */
export async function getMonitoringSettings(orgId: string | null = null, db: Queryable = pool): Promise<MonitoringSettings> {
  const { rows } = await db.query<{ global: Partial<MonitoringSettings> | null; org: Partial<MonitoringSettings> | null }>(
    `SELECT (SELECT value FROM app_settings WHERE key = 'monitoring') AS global,
            (SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'monitoring') AS org`,
    [orgId],
  );
  const own = Object.fromEntries(Object.entries(rows[0]?.org ?? {}).filter(([k]) => isOrgKey(k)));
  const merged = { ...DEFAULT_MONITORING_SETTINGS, ...(rows[0]?.global ?? {}), ...own };
  // Ignore unknown/invalid stored keys rather than failing monitoring.
  const parsed = monitoringSettingsSchema.safeParse(
    Object.fromEntries(Object.keys(DEFAULT_MONITORING_SETTINGS).map((k) => [k, merged[k as keyof MonitoringSettings]])),
  );
  return parsed.success ? parsed.data : DEFAULT_MONITORING_SETTINGS;
}

/** The server-wide keys a patch would change (only the system administrator may). */
export const serverWideKeys = (patch: Partial<MonitoringSettings>) => Object.keys(patch).filter((k) => !isOrgKey(k));

/** Saves organization keys for `orgId` and server-wide keys for everyone. */
export async function updateMonitoringSettings(
  orgId: string,
  patch: Partial<MonitoringSettings>,
  userId: string | null,
  db: Queryable = pool,
): Promise<MonitoringSettings> {
  const current = await getMonitoringSettings(orgId, db);
  const next = monitoringSettingsSchema.parse({ ...current, ...patch });
  checkOrdering(next);
  const pick = (org: boolean) => Object.fromEntries(Object.entries(next).filter(([k]) => isOrgKey(k) === org));
  await db.query(
    `INSERT INTO organization_settings (organization_id, key, value, updated_by) VALUES ($1, 'monitoring', $2, $3)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, JSON.stringify(pick(true)), userId],
  );
  if (serverWideKeys(patch).length) {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ('monitoring', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(pick(false)), userId],
    );
  }
  return next;
}
