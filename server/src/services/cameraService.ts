import { z } from "zod";
import { pool, withTransaction, type Queryable } from "../db/pool.js";
import { registry } from "../integrations/registry.js";
import { CameraApiError, type CameraConfig } from "../integrations/types.js";
import { conflict, HttpError, notFound } from "../lib/errors.js";
import { getCipher } from "../security/cipher.js";
import { HostNotAllowedError, normalizeHost } from "../security/hostGuard.js";
import { type Actor, audit } from "./auditService.js";
import { getCameraPasswordPolicy, ISSUE_MESSAGES, PASSWORD_STATUS_SQL, passwordIssues } from "./cameraPasswordPolicy.js";

// ------------------------------------------------------------------ validation

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const threshold = z.coerce.number().min(1).max(100).optional().nullable();

const hostSchema = z
  .string()
  .trim()
  .min(1, "IP address or hostname is required")
  .max(253)
  .transform((v, ctx) => {
    try {
      return normalizeHost(v);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: err instanceof HostNotAllowedError ? err.message : "Invalid host" });
      return z.NEVER;
    }
  });

const brandSchema = z
  .string()
  .trim()
  .min(1, "Brand is required")
  .transform((v, ctx) => {
    const key = registry.resolveKey(v);
    if (!key) {
      ctx.addIssue({ code: "custom", message: `Unknown brand "${v}"` });
      return z.NEVER;
    }
    if (!registry.isSupported(key)) {
      let message = `${v} support is planned but not available yet`;
      try {
        registry.get(key);
      } catch (err) {
        if (err instanceof Error) message = err.message;
      }
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    }
    return key;
  });

const pemSchema = z
  .string()
  .trim()
  .max(20000)
  .refine((v) => v === "" || /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(v), {
    message: "Must be a PEM certificate (-----BEGIN CERTIFICATE-----)",
  })
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

const baseFields = {
  name: z.string().trim().min(1, "Camera name is required").max(120),
  host: hostSchema,
  port: z.coerce.number().int().min(1).max(65535).optional().nullable(),
  protocol: z.enum(["http", "https"]).default("http"),
  brand: brandSchema,
  model: optionalText(120),
  location: optionalText(120),
  // Which of these are required depends on the brand's integration (see credentialIssues).
  username: z.string().trim().max(64).default(""),
  password: z.string().max(256).default(""),
  monitoringEnabled: z.boolean().default(true),
  /** False for cameras that record elsewhere (NVR) and have no SD card by design. */
  localStorage: z.boolean().default(true),
  warningThreshold: threshold,
  criticalThreshold: threshold,
  caCertificate: pemSchema,
};

function thresholdsOk(v: { warningThreshold?: number | null; criticalThreshold?: number | null }) {
  return v.warningThreshold == null || v.criticalThreshold == null || v.warningThreshold < v.criticalThreshold;
}
const thresholdMessage = { message: "Warning threshold must be lower than the critical threshold", path: ["warningThreshold"] };

/** Username + password, a single secret (API key or token) or nothing, as the brand's integration requires. */
export function credentialsFor(brandKey: string): "user_password" | "secret" | "none" {
  return registry.credentialsOf(brandKey);
}

function credentialIssues(v: { brand?: string; username?: string; password?: string }, ctx: z.RefinementCtx, creating: boolean) {
  if (!v.brand) return;
  const mode = credentialsFor(v.brand);
  if (mode === "user_password" && creating && !v.username) ctx.addIssue({ code: "custom", path: ["username"], message: "Username is required" });
  if (mode === "user_password" && !creating && v.username === "") ctx.addIssue({ code: "custom", path: ["username"], message: "Username is required" });
  if (mode !== "none" && creating && !v.password) {
    ctx.addIssue({ code: "custom", path: ["password"], message: mode === "secret" ? "API key or token is required" : "Password is required" });
  }
}

export const cameraInputSchema = z
  .object(baseFields)
  .strict()
  .refine(thresholdsOk, thresholdMessage)
  .superRefine((v, ctx) => credentialIssues(v, ctx, true));
export type CameraInput = z.infer<typeof cameraInputSchema>;

export const cameraUpdateSchema = z
  .object({
    ...baseFields,
    // On update the password is optional: omit it to keep the stored one.
    password: z.string().min(1).max(256).optional(),
    username: z.string().trim().max(64).optional(),
  })
  .partial()
  .strict()
  .refine(thresholdsOk, thresholdMessage)
  .superRefine((v, ctx) => credentialIssues(v, ctx, false));
export type CameraUpdate = z.infer<typeof cameraUpdateSchema>;

export function defaultPort(brandKey: string, protocol: "http" | "https") {
  const ports = registry.get(brandKey).meta.defaultPorts;
  return protocol === "https" ? ports.https : ports.http;
}

// ------------------------------------------------------------------ queries

const SELECT_CAMERA = `
  SELECT c.id, c.name, c.host, c.port, c.protocol, c.brand_key, b.display_name AS brand_name,
         c.model, c.location, c.monitoring_enabled, c.local_storage, c.warning_threshold, c.critical_threshold,
         (c.ca_certificate IS NOT NULL) AS has_ca_certificate,
         c.created_at, c.updated_at,
         cr.username, cr.updated_at AS credentials_updated_at, cr.password_changed_at, cr.password_issues,
         ${PASSWORD_STATUS_SQL} AS password_status,
         s.connection_status, s.storage_health, s.last_error_code, s.last_error_message,
         s.last_attempt_at, s.last_success_at, s.consecutive_failures, s.consecutive_auth_failures,
         s.total_bytes, s.used_bytes, s.free_bytes, s.used_percentage,
         s.recording_state, s.recording_detail, s.recording_checked_at,
         s.recording_days, s.recording_oldest, s.recording_range_at, s.recording_range_error, s.recording_days_at_least,
         s.device_model, s.device_serial, s.firmware_version, s.next_check_at,
         (s.check_lock_until IS NOT NULL AND s.check_lock_until > now()) AS check_in_progress,
         (SELECT count(*)::int FROM alerts a WHERE a.camera_id = c.id AND a.status <> 'resolved') AS open_alerts
  FROM cameras c
  JOIN camera_brands b ON b.key = c.brand_key
  LEFT JOIN camera_credentials cr ON cr.camera_id = c.id
  LEFT JOIN camera_status s ON s.camera_id = c.id`;

export interface CameraRow {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: "http" | "https";
  brand_key: string;
  brand_name: string;
  model: string | null;
  location: string | null;
  monitoring_enabled: boolean;
  warning_threshold: number | null;
  critical_threshold: number | null;
  has_ca_certificate: boolean;
  username: string | null;
  connection_status: string;
  storage_health: string;
  [key: string]: unknown;
}

/** API shape: camelCase, never contains the password or its ciphertext. */
export function toCameraView(r: CameraRow) {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    protocol: r.protocol,
    brand: r.brand_key,
    brandName: r.brand_name,
    model: r.model ?? (r.device_model as string | null) ?? null,
    location: r.location,
    monitoringEnabled: r.monitoring_enabled,
    localStorage: r.local_storage as boolean,
    warningThreshold: r.warning_threshold,
    criticalThreshold: r.critical_threshold,
    hasCaCertificate: r.has_ca_certificate,
    username: r.username,
    credentialsUpdatedAt: r.credentials_updated_at ?? null,
    /** The camera password against the organization's camera password policy. */
    password: {
      status: (r.password_status as "ok" | "weak" | "expired" | "unknown" | undefined) ?? "unknown",
      issues: (r.password_issues as string[] | null) ?? [],
      changedAt: r.password_changed_at ?? null,
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: {
      connection: r.connection_status ?? "unknown",
      storageHealth: r.storage_health ?? "unknown",
      lastErrorCode: r.last_error_code ?? null,
      lastErrorMessage: r.last_error_message ?? null,
      lastAttemptAt: r.last_attempt_at ?? null,
      lastSuccessAt: r.last_success_at ?? null,
      consecutiveFailures: r.consecutive_failures ?? 0,
      totalBytes: r.total_bytes ?? null,
      usedBytes: r.used_bytes ?? null,
      freeBytes: r.free_bytes ?? null,
      usedPercentage: r.used_percentage ?? null,
      nextCheckAt: r.next_check_at ?? null,
      checkInProgress: r.check_in_progress ?? false,
      openAlerts: r.open_alerts ?? 0,
      recording: {
        state: (r.recording_state as string | null) ?? "unknown",
        detail: r.recording_detail ?? null,
        checkedAt: r.recording_checked_at ?? null,
        /** Days of recordings on the camera's storage, from its oldest recording (null: not known). */
        daysAvailable: r.recording_days ?? null,
        oldest: r.recording_oldest ?? null,
        rangeCheckedAt: r.recording_range_at ?? null,
        /** Why the days could not be read; daysAtLeast: the value is a lower bound. */
        rangeError: r.recording_range_error ?? null,
        daysAtLeast: r.recording_days_at_least ?? false,
      },
    },
    device: {
      model: r.device_model ?? null,
      serialNumber: r.device_serial ?? null,
      firmwareVersion: r.firmware_version ?? null,
    },
  };
}
export type CameraView = ReturnType<typeof toCameraView>;

export const listQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  brand: z.string().trim().max(40).optional(),
  status: z.enum(["online", "offline", "unknown", "healthy", "warning", "critical", "disabled", "nostoragedevice", "nolocalstorage"]).optional(),
  location: z.string().trim().max(120).optional(),
  minUsage: z.coerce.number().min(0).max(100).optional(),
  maxUsage: z.coerce.number().min(0).max(100).optional(),
  recording: z.enum(["recording", "idle", "error", "unknown"]).optional(),
  password: z.enum(["ok", "weak", "expired"]).optional(),
  sort: z.enum(["name", "host", "brand", "location", "connection", "health", "recording", "usage", "lastSuccess", "recordingDays"]).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const SORT_COLUMNS: Record<ListQuery["sort"], string> = {
  name: "lower(c.name)",
  host: "c.host",
  brand: "c.brand_key",
  location: "lower(c.location)",
  connection: "s.connection_status",
  health: "CASE s.storage_health WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'healthy' THEN 1 ELSE 0 END",
  recording: "CASE s.recording_state WHEN 'error' THEN 3 WHEN 'idle' THEN 2 WHEN 'recording' THEN 1 ELSE 0 END",
  usage: "s.used_percentage",
  lastSuccess: "s.last_success_at",
  recordingDays: "s.recording_days",
};

/** WHERE clause (over cameras c LEFT JOIN camera_status s) for the camera list filters, within one organization. */
export function listFilter(orgId: string, q: Omit<ListQuery, "page" | "pageSize" | "sort" | "order">) {
  const params: unknown[] = [orgId];
  const where = ["c.organization_id = $1", "c.deleted_at IS NULL"];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (q.search) {
    const like = p(`%${q.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    where.push(`(c.name ILIKE ${like} OR c.host ILIKE ${like} OR c.location ILIKE ${like} OR c.model ILIKE ${like})`);
  }
  if (q.brand) where.push(`c.brand_key = ${p(q.brand)}`);
  if (q.location) where.push(`c.location = ${p(q.location)}`);
  if (q.status === "disabled") where.push("c.monitoring_enabled = false");
  else if (q.status === "nolocalstorage") where.push("NOT c.local_storage");
  else if (q.status === "nostoragedevice") {
    // Read successfully but reported no SD card / storage device.
    where.push(`c.local_storage AND s.last_success_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage_devices d WHERE d.camera_id = c.id)`);
  }
  else if (q.status && ["online", "offline", "unknown"].includes(q.status)) {
    where.push(`c.monitoring_enabled AND s.connection_status = ${p(q.status)}`);
  } else if (q.status) where.push(`c.monitoring_enabled AND s.storage_health = ${p(q.status)}`);
  if (q.minUsage !== undefined) where.push(`s.used_percentage >= ${p(q.minUsage)}`);
  if (q.maxUsage !== undefined) where.push(`s.used_percentage <= ${p(q.maxUsage)}`);
  if (q.recording) where.push(`c.monitoring_enabled AND s.recording_state = ${p(q.recording)}`);
  if (q.password) where.push(`(SELECT ${PASSWORD_STATUS_SQL} FROM camera_credentials cr WHERE cr.camera_id = c.id) = ${p(q.password)}`);

  return { clause: where.join(" AND "), params, p };
}

export async function listCameras(orgId: string, q: ListQuery) {
  const { clause, params, p } = listFilter(orgId, q);
  const base = `FROM cameras c LEFT JOIN camera_status s ON s.camera_id = c.id WHERE ${clause}`;
  const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n ${base}`, params)).rows[0]!.n;
  const order = `${SORT_COLUMNS[q.sort]} ${q.order === "desc" ? "DESC" : "ASC"} NULLS LAST, c.id`;
  const limit = p(q.pageSize);
  const offset = p((q.page - 1) * q.pageSize);
  const { rows } = await pool.query<CameraRow>(
    `${SELECT_CAMERA} WHERE ${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { items: rows.map(toCameraView), total, page: q.page, pageSize: q.pageSize };
}

/** IDs of every camera matching the list filters ("Select all N matching"), in list order. */
export async function listCameraIds(orgId: string, q: ListQuery): Promise<{ ids: string[]; total: number }> {
  const { clause, params } = listFilter(orgId, q);
  const order = `${SORT_COLUMNS[q.sort]} ${q.order === "desc" ? "DESC" : "ASC"} NULLS LAST, c.id`;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT c.id FROM cameras c LEFT JOIN camera_status s ON s.camera_id = c.id WHERE ${clause} ORDER BY ${order}`,
    params,
  );
  return { ids: rows.map((r) => r.id), total: rows.length };
}

export async function listLocations(orgId: string): Promise<string[]> {
  const { rows } = await pool.query<{ location: string }>(
    "SELECT DISTINCT location FROM cameras WHERE organization_id = $1 AND deleted_at IS NULL AND location IS NOT NULL ORDER BY location",
    [orgId],
  );
  return rows.map((r) => r.location);
}

/**
 * One camera. `orgId` limits it to that organization (a camera of another organization is "not found");
 * null is for the monitoring worker, which works across organizations.
 */
export async function getCameraRow(id: string, orgId: string | null, db: Queryable = pool): Promise<CameraRow> {
  if (!z.string().uuid().safeParse(id).success) throw notFound("Camera");
  const { rows } = await db.query<CameraRow>(
    `${SELECT_CAMERA} WHERE c.id = $1 AND c.deleted_at IS NULL AND ($2::uuid IS NULL OR c.organization_id = $2)`,
    [id, orgId],
  );
  if (!rows[0]) throw notFound("Camera");
  return rows[0];
}

export async function getCamera(id: string, orgId: string | null) {
  const row = await getCameraRow(id, orgId);
  const devices = await pool.query(
    `SELECT vendor_id AS id, name, type, health_status AS "healthStatus", raw_status AS "rawStatus",
            total_bytes AS "totalBytes", free_bytes AS "freeBytes", used_bytes AS "usedBytes",
            used_percentage AS "usedPercentage", writable, property, format_type AS "formatType", updated_at AS "updatedAt"
     FROM storage_devices WHERE camera_id = $1 ORDER BY vendor_id`,
    [id],
  );
  return { ...toCameraView(row), devices: devices.rows };
}

export async function getSummary(orgId: string) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE c.monitoring_enabled)::int AS monitored,
            count(*) FILTER (WHERE c.monitoring_enabled AND s.connection_status = 'online')::int AS online,
            count(*) FILTER (WHERE c.monitoring_enabled AND s.connection_status = 'offline')::int AS offline,
            count(*) FILTER (WHERE c.monitoring_enabled AND s.connection_status = 'unknown')::int AS unknown,
            count(*) FILTER (WHERE NOT c.monitoring_enabled)::int AS disabled,
            count(*) FILTER (WHERE c.monitoring_enabled AND s.storage_health = 'warning')::int AS warning,
            count(*) FILTER (WHERE c.monitoring_enabled AND s.storage_health = 'critical')::int AS critical,
            count(*) FILTER (WHERE c.monitoring_enabled AND s.recording_state = 'recording')::int AS recording,
            count(*) FILTER (WHERE c.monitoring_enabled AND s.recording_state IN ('idle', 'error'))::int AS not_recording,
            count(*) FILTER (WHERE c.monitoring_enabled AND NOT c.local_storage)::int AS without_local_storage,
            -- Capacity counts only cameras that are reachable: an offline camera's last reading is stale.
            coalesce(sum(s.total_bytes) FILTER (WHERE c.monitoring_enabled AND s.connection_status <> 'offline'), 0)::bigint AS total_bytes,
            coalesce(sum(s.used_bytes) FILTER (WHERE c.monitoring_enabled AND s.connection_status <> 'offline'), 0)::bigint AS used_bytes,
            coalesce(sum(s.free_bytes) FILTER (WHERE c.monitoring_enabled AND s.connection_status <> 'offline'), 0)::bigint AS free_bytes,
            count(s.total_bytes) FILTER (WHERE c.monitoring_enabled AND s.connection_status <> 'offline')::int AS cameras_with_storage_data,
            count(s.total_bytes) FILTER (WHERE c.monitoring_enabled AND s.connection_status = 'offline')::int AS offline_with_storage_data
     FROM cameras c LEFT JOIN camera_status s ON s.camera_id = c.id
     WHERE c.organization_id = $1 AND c.deleted_at IS NULL`,
    [orgId],
  );
  const r = rows[0];
  const alerts = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
            count(*) FILTER (WHERE status <> 'resolved' AND severity = 'critical')::int AS critical
     FROM alerts a JOIN cameras c ON c.id = a.camera_id WHERE c.organization_id = $1 AND c.deleted_at IS NULL`,
    [orgId],
  );
  return {
    totalCameras: r.total,
    monitoredCameras: r.monitored,
    online: r.online,
    offline: r.offline,
    unknown: r.unknown,
    disabled: r.disabled,
    storageWarning: r.warning,
    storageCritical: r.critical,
    recording: r.recording,
    notRecording: r.not_recording,
    totalBytes: r.total_bytes,
    usedBytes: r.used_bytes,
    freeBytes: r.free_bytes,
    camerasWithStorageData: r.cameras_with_storage_data,
    offlineWithStorageData: r.offline_with_storage_data,
    withoutLocalStorage: r.without_local_storage,
    alerts: alerts.rows[0],
  };
}

// ------------------------------------------------------------------ mutations

function translateUniqueViolation(err: unknown): never {
  if ((err as { code?: string }).code === "23505") {
    throw conflict("A camera with this brand, host and port is already registered", { code: "DUPLICATE_CAMERA" });
  }
  throw err;
}

export async function createCamera(
  orgId: string, input: Omit<CameraInput, "localStorage"> & { localStorage?: boolean }, actor: Actor, ip?: string | null, db?: Queryable,
) {
  const port = input.port ?? defaultPort(input.brand, input.protocol);
  const cipher = getCipher();
  const run = async (client: Queryable) => {
    const { rows } = await client
      .query<{ id: string }>(
        `INSERT INTO cameras (name, host, port, protocol, brand_key, model, location, monitoring_enabled,
                              warning_threshold, critical_threshold, ca_certificate, created_by, local_storage, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          input.name, input.host, port, input.protocol, input.brand, input.model, input.location,
          input.monitoringEnabled, input.warningThreshold ?? null, input.criticalThreshold ?? null,
          input.caCertificate, actor.id, input.localStorage ?? true, orgId,
        ],
      )
      .catch(translateUniqueViolation);
    const id = rows[0]!.id;
    const issues = await checkCameraPassword(orgId, input.brand, input.username, input.password, client);
    await client.query(
      `INSERT INTO camera_credentials (camera_id, username, password_encrypted, key_version, updated_by, password_issues)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.username, cipher.encrypt(input.password), cipher.keyVersion, actor.id, issues],
    );
    await client.query("INSERT INTO camera_status (camera_id, next_check_at) VALUES ($1, now())", [id]);
    await audit(
      {
        actor, ip, action: "camera.created", entityType: "camera", entityId: id,
        details: { name: input.name, host: input.host, port, brand: input.brand, protocol: input.protocol },
      },
      client,
    );
    return id;
  };
  const id = db ? await run(db) : await withTransaction(run);
  return id;
}

/**
 * How a camera password falls short of the organization's camera password policy. With "block",
 * a new password that falls short is refused. API keys and tokens of other integrations are not checked.
 */
async function checkCameraPassword(orgId: string, brand: string, username: string | null, password: string, db: Queryable, isNew = true): Promise<string[]> {
  if (credentialsFor(brand) !== "user_password") return [];
  const policy = await getCameraPasswordPolicy(orgId, db);
  const issues = passwordIssues(password, username, policy);
  if (issues.length && isNew && policy.enforcement === "block") {
    const message = `This password does not meet the camera password policy: it is ${issues.map((i) => ISSUE_MESSAGES[i](policy)).join(", ")}. Change it on the camera first.`;
    throw new HttpError(400, "VALIDATION_ERROR", `password: ${message}`, [{ field: "password", message }]);
  }
  return issues;
}

export async function updateCamera(orgId: string, id: string, patch: CameraUpdate, actor: Actor, ip?: string | null) {
  return withTransaction(async (client) => {
    const current = await getCameraRow(id, orgId, client);
    const brand = patch.brand ?? current.brand_key;
    if (brand !== current.brand_key && credentialsFor(brand) !== credentialsFor(current.brand_key)) {
      // The stored credentials were for a different kind of login: ask for the new ones.
      const mode = credentialsFor(brand);
      const missing: { field: string; message: string }[] = [];
      if (mode === "user_password" && !patch.username) missing.push({ field: "username", message: "Enter the username for the new brand" });
      if (mode !== "none" && !patch.password) {
        missing.push({ field: "password", message: mode === "secret" ? "Enter the API key or token for the new brand" : "Enter the password for the new brand" });
      }
      if (missing.length) throw new HttpError(400, "VALIDATION_ERROR", `${missing[0]!.field}: ${missing[0]!.message}`, missing);
    }
    const protocol = patch.protocol ?? current.protocol;
    let port = patch.port === undefined ? current.port : patch.port;
    // Switching protocol without choosing a port moves to that protocol's default port.
    if (port == null || (patch.protocol && patch.port === undefined && patch.protocol !== current.protocol)) {
      port = defaultPort(brand, protocol);
    }
    const warning = patch.warningThreshold === undefined ? current.warning_threshold : patch.warningThreshold;
    const critical = patch.criticalThreshold === undefined ? current.critical_threshold : patch.criticalThreshold;
    if (warning != null && critical != null && warning >= critical) {
      throw new HttpError(400, "VALIDATION_ERROR", "Warning threshold must be lower than the critical threshold");
    }
    const endpointChanged =
      brand !== current.brand_key || (patch.host ?? current.host) !== current.host || port !== current.port || protocol !== current.protocol;

    await client
      .query(
        `UPDATE cameras SET name = $2, host = $3, port = $4, protocol = $5, brand_key = $6, model = $7, location = $8,
                monitoring_enabled = $9, warning_threshold = $10, critical_threshold = $11,
                ca_certificate = $12, local_storage = $13, updated_at = now()
         WHERE id = $1`,
        [
          id,
          patch.name ?? current.name,
          patch.host ?? current.host,
          port,
          protocol,
          brand,
          patch.model === undefined ? current.model : patch.model,
          patch.location === undefined ? current.location : patch.location,
          patch.monitoringEnabled ?? current.monitoring_enabled,
          warning,
          critical,
          patch.caCertificate === undefined
            ? (await client.query("SELECT ca_certificate FROM cameras WHERE id = $1", [id])).rows[0].ca_certificate
            : patch.caCertificate,
          patch.localStorage ?? current.local_storage,
        ],
      )
      .catch(translateUniqueViolation);

    const credentialsChanged = patch.password !== undefined || (patch.username !== undefined && patch.username !== current.username);
    if (credentialsChanged) {
      const cipher = getCipher();
      const username = patch.username ?? current.username;
      const stored = (await client.query<{ password_encrypted: string }>("SELECT password_encrypted FROM camera_credentials WHERE camera_id = $1", [id])).rows[0];
      let old: string | null = null;
      try {
        old = stored ? cipher.decrypt(stored.password_encrypted) : null;
      } catch {
        old = null;
      }
      const password = patch.password ?? old;
      const issues = password === null ? [] : await checkCameraPassword(orgId, brand, username, password, client, patch.password !== undefined);
      if (patch.password !== undefined) {
        // Saving the same password again does not restart its age.
        await client.query(
          `UPDATE camera_credentials SET username = $2, password_encrypted = $3, key_version = $4, updated_at = now(), updated_by = $5,
                  password_issues = $6, password_changed_at = CASE WHEN $7 THEN password_changed_at ELSE now() END
           WHERE camera_id = $1`,
          [id, username, cipher.encrypt(patch.password), cipher.keyVersion, actor.id, issues, patch.password === old],
        );
      } else {
        await client.query(
          "UPDATE camera_credentials SET username = $2, updated_at = now(), updated_by = $3, password_issues = $4 WHERE camera_id = $1",
          [id, patch.username, actor.id, issues],
        );
      }
      await audit({ actor, ip, action: "camera.credentials_changed", entityType: "camera", entityId: id }, client);
    }
    if (endpointChanged || credentialsChanged) {
      // Check again soon with the new configuration; failure counters start over.
      await client.query(
        "UPDATE camera_status SET next_check_at = now(), consecutive_failures = 0, consecutive_auth_failures = 0 WHERE camera_id = $1",
        [id],
      );
    }
    const changed = Object.keys(patch).filter((k) => k !== "password" && k !== "username");
    if (changed.length) {
      await audit(
        {
          actor, ip, action: "camera.updated", entityType: "camera", entityId: id,
          details: { fields: changed },
        },
        client,
      );
    }
  });
}

export async function setMonitoring(orgId: string, id: string, enabled: boolean, actor: Actor, ip?: string | null) {
  await getCameraRow(id, orgId);
  await pool.query("UPDATE cameras SET monitoring_enabled = $2, updated_at = now() WHERE id = $1", [id, enabled]);
  if (enabled) await pool.query("UPDATE camera_status SET next_check_at = now() WHERE camera_id = $1", [id]);
  await audit({ actor, ip, action: enabled ? "camera.monitoring_enabled" : "camera.monitoring_disabled", entityType: "camera", entityId: id });
}

/**
 * Removes cameras from monitoring. Rows are soft-deleted so history, alerts and audit
 * records are preserved; stored credentials are destroyed because they are no longer needed.
 * Nothing is sent to the physical camera.
 */
export async function removeCameras(orgId: string, ids: string[], actor: Actor, ip?: string | null) {
  const valid = ids.filter((id) => z.string().uuid().safeParse(id).success);
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; name: string; host: string }>(
      `UPDATE cameras SET deleted_at = now(), monitoring_enabled = false, updated_at = now()
       WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND deleted_at IS NULL RETURNING id, name, host`,
      [valid, orgId],
    );
    const removed = rows.map((r) => r.id);
    if (removed.length) {
      await client.query("DELETE FROM camera_credentials WHERE camera_id = ANY($1::uuid[])", [removed]);
      await client.query("DELETE FROM storage_devices WHERE camera_id = ANY($1::uuid[])", [removed]);
      const closed = await client.query<{ id: number }>(
        `UPDATE alerts SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution_note = 'Camera removed from monitoring'
         WHERE camera_id = ANY($1::uuid[]) AND status <> 'resolved' RETURNING id`,
        [removed, actor.id],
      );
      for (const a of closed.rows) {
        await client.query(
          "INSERT INTO alert_events (alert_id, event_type, message, actor_user_id) VALUES ($1, 'resolved', 'Camera removed from monitoring', $2)",
          [a.id, actor.id],
        );
      }
      for (const r of rows) {
        await audit({ actor, ip, action: "camera.removed", entityType: "camera", entityId: r.id, details: { name: r.name, host: r.host } }, client);
      }
    }
    return { removed, notFound: ids.filter((id) => !removed.includes(id)) };
  });
}

/** Builds the adapter config, decrypting the stored password. Used only server-side. */
export async function getCameraConfig(id: string, timeoutMs: number, db: Queryable = pool): Promise<CameraConfig> {
  const { rows } = await db.query(
    `SELECT c.host, c.port, c.protocol, c.ca_certificate, cr.username, cr.password_encrypted
     FROM cameras c LEFT JOIN camera_credentials cr ON cr.camera_id = c.id
     WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [id],
  );
  const r = rows[0];
  if (!r) throw notFound("Camera");
  if (!r.password_encrypted) throw new CameraApiError("CREDENTIALS_UNAVAILABLE", "No credentials are stored for this camera");
  let password: string;
  try {
    password = getCipher().decrypt(r.password_encrypted);
  } catch {
    throw new CameraApiError(
      "CREDENTIALS_UNAVAILABLE",
      "Stored credentials could not be decrypted. Check the encryption key configuration or re-enter the password.",
    );
  }
  return {
    host: r.host, port: r.port, protocol: r.protocol, caCertificate: r.ca_certificate,
    username: r.username, password, timeoutMs,
  };
}

export async function getHistory(orgId: string, id: string, opts: { hours: number; limit: number }) {
  await getCameraRow(id, orgId);
  const checks = await pool.query(
    `SELECT checked_at AS "checkedAt", trigger, outcome, duration_ms AS "durationMs", attempts,
            storage_health AS "storageHealth", total_bytes AS "totalBytes", used_bytes AS "usedBytes",
            free_bytes AS "freeBytes", used_percentage AS "usedPercentage", error_message AS "errorMessage",
            recording_state AS "recordingState"
     FROM storage_checks WHERE camera_id = $1 AND checked_at >= now() - make_interval(hours => $2)
     ORDER BY checked_at DESC LIMIT $3`,
    [id, opts.hours, opts.limit],
  );
  const events = await pool.query(
    `SELECT occurred_at AS "occurredAt", from_status AS "fromStatus", to_status AS "toStatus", reason
     FROM connection_events WHERE camera_id = $1 ORDER BY occurred_at DESC LIMIT 100`,
    [id],
  );
  return { checks: checks.rows, connectionEvents: events.rows };
}

/** Marks cameras as recording elsewhere (no SD card / local storage) or back to using local storage. */
export async function setLocalStorage(orgId: string, ids: string[], localStorage: boolean, actor: Actor, ip?: string | null) {
  return withTransaction(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE cameras SET local_storage = $2, updated_at = now()
       WHERE id = ANY($1::uuid[]) AND organization_id = $3 AND deleted_at IS NULL AND local_storage <> $2 RETURNING id`,
      [ids, localStorage, orgId],
    );
    // Check them again soon so their status and alerts reflect the change.
    await db.query("UPDATE camera_status SET next_check_at = now() WHERE camera_id = ANY($1::uuid[])", [rows.map((r) => r.id)]);
    for (const r of rows) {
      await audit({ actor, ip, action: localStorage ? "camera.local_storage_on" : "camera.local_storage_off", entityType: "camera", entityId: r.id }, db);
    }
    return { updated: rows.length };
  });
}
