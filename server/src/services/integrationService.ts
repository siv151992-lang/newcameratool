import { z } from "zod";
import { pool, withTransaction, type Queryable } from "../db/pool.js";
import { toCameraError, type ConfigurableAdapter } from "../integrations/configurable/adapter.js";
import { credentialModeFor, integrationConfigSchema, type IntegrationConfig } from "../integrations/configurable/config.js";
import { mapStorage, parseBody, MappingError, type MappingResult } from "../integrations/configurable/mapping.js";
import { registry } from "../integrations/registry.js";
import {
  AUTH_ERROR_CODES,
  CameraApiError,
  NETWORK_ERROR_CODES,
  type CameraConfig,
  type DeviceInfo,
  type DiagnosticStep,
  type StorageReading,
} from "../integrations/types.js";
import { conflict, HttpError, notFound } from "../lib/errors.js";
import { formatZodError } from "../lib/validate.js";
import { redactSecrets } from "../security/redact.js";
import { audit, type Actor } from "./auditService.js";
import { getCameraConfig } from "./cameraService.js";
import { getMonitoringSettings } from "./settingsService.js";

/**
 * Lifecycle of brand integrations: built-in adapters (Mode B) and configurable API integrations
 * (Mode A). A configurable integration's configuration is versioned; a version can only be
 * enabled for monitoring after a backend test against a real camera passed. Editing an enabled
 * integration creates a new draft version while the tested one keeps running.
 */

// ------------------------------------------------------------------ input schemas

const text = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export const integrationDetailsSchema = z
  .object({
    displayName: z.string().trim().min(2, "Brand name is required").max(60),
    manufacturer: text(80),
    description: text(500),
    supportedModels: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
    defaultProtocol: z.enum(["http", "https"]).default("http"),
    defaultHttpPort: z.number().int().min(1).max(65535).default(80),
    defaultHttpsPort: z.number().int().min(1).max(65535).default(443),
    integrationVersion: z.string().trim().regex(/^\d{1,3}(\.\d{1,3}){0,2}$/, "Use a version such as 1.0 or 1.2.0").default("1.0.0"),
    compatibilityNotes: text(1000),
  })
  .strict();

export const createIntegrationSchema = z.object({ details: integrationDetailsSchema, config: z.unknown(), changeNote: text(200) }).strict();
export const updateIntegrationSchema = z
  .object({ details: integrationDetailsSchema.partial().optional(), config: z.unknown().optional(), changeNote: text(200) })
  .strict();

const targetSchema = z.union([
  z.object({ cameraId: z.string().uuid() }).strict(),
  z
    .object({
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      protocol: z.enum(["http", "https"]),
      username: z.string().max(64).default(""),
      password: z.string().max(256).default(""),
      caCertificate: z.string().max(20000).optional().nullable(),
    })
    .strict(),
]);
export const testIntegrationSchema = z.object({ versionId: z.string().uuid().optional(), target: targetSchema }).strict();
export const previewSchema = z.object({ config: z.unknown(), sample: z.string().min(1, "Paste a sample response").max(262_144) }).strict();

// ------------------------------------------------------------------ helpers

export interface ConfigIssue {
  field: string;
  message: string;
}

export function validateConfig(input: unknown): { valid: true; config: IntegrationConfig; credentialMode: string } | { valid: false; issues: ConfigIssue[] } {
  const r = integrationConfigSchema.safeParse(input);
  if (!r.success) return { valid: false, issues: formatZodError(r.error) };
  return { valid: true, config: r.data, credentialMode: credentialModeFor(r.data.auth.type) };
}

function requireValidConfig(input: unknown): IntegrationConfig {
  const v = validateConfig(input);
  if (!v.valid) throw new HttpError(400, "VALIDATION_ERROR", `Configuration is invalid: ${v.issues[0]!.field}: ${v.issues[0]!.message}`, v.issues);
  return v.config;
}

/** JSON with object keys sorted, so equal configurations compare equal whatever their key order. */
export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(sort(v));
}

const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "brand";

async function uniqueKey(name: string, db: Queryable): Promise<string> {
  const base = slug(name);
  for (let i = 1; i < 100; i++) {
    const key = i === 1 ? base : `${base}-${i}`;
    if (registry.isBuiltin(key)) continue;
    const { rowCount } = await db.query("SELECT 1 FROM camera_brands WHERE key = $1", [key]);
    if (!rowCount) return key;
  }
  throw conflict("Could not generate a unique key for this brand");
}

async function assertNameFree(name: string, exceptKey: string | null, db: Queryable) {
  const norm = name.toLowerCase().replace(/[\s_-]+/g, "");
  const existing = registry.resolveKey(name);
  const { rows } = await db.query<{ key: string }>(
    "SELECT key FROM camera_brands WHERE deleted_at IS NULL AND regexp_replace(lower(display_name), '[\\s_-]+', '', 'g') = $1",
    [norm],
  );
  const clash = rows.find((r) => r.key !== exceptKey) ?? (existing && existing !== exceptKey && registry.isBuiltin(existing) ? { key: existing } : undefined);
  if (clash) throw conflict(`A brand named "${name}" is already registered (${clash.key}). Edit that integration instead of adding a duplicate.`);
}

async function brandRow(key: string, db: Queryable = pool) {
  const { rows } = await db.query("SELECT * FROM camera_brands WHERE key = $1 AND deleted_at IS NULL", [key]);
  if (!rows[0]) throw notFound("Brand integration");
  return rows[0];
}

const SENSITIVE = /(pass(word|wd)?|secret|token|api[-_]?key|auth|cookie|session|credential|private[-_]?key|signature)/i;

/** Redacts values of sensitive-looking keys in a sample reply and caps its size. */
export function redactSample(body: string, format: "json" | "xml", secrets: string[]): string {
  let out = body;
  try {
    if (format === "json") {
      const walk = (v: unknown): unknown =>
        Array.isArray(v) ? v.map(walk) : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? "[REDACTED]" : walk(x)]))
          : v;
      out = JSON.stringify(walk(JSON.parse(body)), null, 2);
    } else {
      out = body
        .replace(/<((?:\w+:)?(\w+))(\s[^>]*)?>([^<]*)<\/\1>/g, (m, tag: string, local: string, attrs = "", inner: string) =>
          SENSITIVE.test(local) && inner.trim() ? `<${tag}${attrs}>[REDACTED]</${tag}>` : m)
        .replace(/(\s([\w:-]+)\s*=\s*)(["'])([^"']*)\3/g, (m, pre: string, name: string, q: string) => (SENSITIVE.test(name) ? `${pre}${q}[REDACTED]${q}` : m));
    }
  } catch {
    // Not parseable: still redact secrets below.
  }
  out = redactSecrets(out, secrets);
  return out.length > 20_000 ? `${out.slice(0, 20_000)}\n… (truncated)` : out;
}

/** Every form a camera secret can take in a reply: as is, URL-encoded, JSON-escaped, Basic-encoded. */
function secretVariants(camera: CameraConfig): string[] {
  if (!camera.password) return [];
  return [
    camera.password,
    encodeURIComponent(camera.password),
    JSON.stringify(camera.password).slice(1, -1),
    Buffer.from(`${camera.username}:${camera.password}`, "utf8").toString("base64"),
  ];
}

/**
 * Removes secrets from everything a test returns or stores: the camera secret in any form, and
 * values the mapping read from sensitive-looking paths (e.g. a "Device name" mapped to apiToken),
 * wherever they reappear (mapping, normalised storage, device info, messages).
 */
function sanitizeResult<T>(value: T, secrets: string[]): T {
  const mapping = (value as { mapping?: MappingResult }).mapping;
  const sensitiveValues = (mapping?.devices ?? []).flatMap((d) => d.fields.filter((f) => SENSITIVE.test(f.path) && f.raw).map((f) => f.raw!));
  const escaped = [...secrets, ...sensitiveValues].map((v) => JSON.stringify(v).slice(1, -1));
  return JSON.parse(redactSecrets(JSON.stringify(value), [...escaped, ...secrets, ...sensitiveValues])) as T;
}

// ------------------------------------------------------------------ queries

export interface IntegrationSummary {
  key: string;
  displayName: string;
  manufacturer: string | null;
  description: string | null;
  integrationType: "builtin" | "configurable";
  integrationVersion: string;
  status: "draft" | "tested" | "enabled" | "disabled";
  supportStatus: string;
  cameraCount: number;
  authMethods: string[];
  capabilities: string[];
  credentials: string;
  defaultProtocol: "http" | "https";
  defaultPorts: { http: number; https: number };
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastSuccessAt: string | null;
  activeVersion: number | null;
  latestVersion: number | null;
  latestVersionStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

// Database rows of SUMMARY_SQL; columns are read by name below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function summarize(r: Record<string, any>): IntegrationSummary {
  const builtin = r.integration_type === "builtin" ? registry.builtinMeta(r.key) : undefined;
  const cfg = r.active_config ?? r.latest_config;
  const parsed = cfg ? integrationConfigSchema.safeParse(cfg) : null;
  const config = parsed?.success ? parsed.data : null;
  const capabilities = builtin?.capabilities ?? (config ? ["storage-status", "connection-test", "multiple-storage-devices", ...(config.deviceInfo ? ["device-info"] : [])] : []);
  return {
    key: r.key,
    displayName: r.display_name,
    manufacturer: r.manufacturer,
    description: r.description ?? builtin?.notes ?? null,
    integrationType: r.integration_type,
    integrationVersion: r.integration_version,
    status: r.status,
    supportStatus: r.support_status,
    cameraCount: r.camera_count ?? 0,
    authMethods: builtin?.authMethods ?? (config ? [config.auth.type === "api_key" ? `api key (${config.auth.apiKeyIn})` : config.auth.type] : []),
    capabilities,
    credentials: builtin ? "user_password" : config ? credentialModeFor(config.auth.type) : "user_password",
    defaultProtocol: r.default_protocol,
    defaultPorts: { http: r.default_http_port ?? 80, https: r.default_https_port ?? 443 },
    lastTestAt: r.last_test_at,
    lastTestOk: r.last_test_ok,
    lastSuccessAt: r.last_success_at,
    activeVersion: r.active_version ?? null,
    latestVersion: r.latest_version ?? null,
    latestVersionStatus: r.latest_test_status ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SUMMARY_SQL = `
  SELECT b.*, av.version AS active_version, av.config AS active_config,
         lv.version AS latest_version, lv.config AS latest_config, lv.test_status AS latest_test_status,
         (SELECT count(*)::int FROM cameras c WHERE c.brand_key = b.key AND c.deleted_at IS NULL) AS camera_count
  FROM camera_brands b
  LEFT JOIN brand_integration_versions av ON av.id = b.active_version_id
  LEFT JOIN LATERAL (SELECT * FROM brand_integration_versions v WHERE v.brand_key = b.key ORDER BY version DESC LIMIT 1) lv ON true
  WHERE b.deleted_at IS NULL AND b.support_status <> 'planned'`;

export async function listIntegrations(): Promise<IntegrationSummary[]> {
  const { rows } = await pool.query(`${SUMMARY_SQL} ORDER BY b.integration_type, lower(b.display_name)`);
  return rows.map(summarize);
}

export async function getIntegration(key: string) {
  const { rows } = await pool.query(`${SUMMARY_SQL} AND b.key = $1`, [key]);
  if (!rows[0]) throw notFound("Brand integration");
  const r = rows[0];
  const versions = await pool.query(
    `SELECT v.id, v.version, v.test_status AS "testStatus", v.tested_at AS "testedAt", v.change_note AS "changeNote",
            v.created_at AS "createdAt", u.username AS "createdBy", (v.id = $2) AS "isActive"
     FROM brand_integration_versions v LEFT JOIN users u ON u.id = v.created_by
     WHERE v.brand_key = $1 ORDER BY v.version DESC`,
    [key, r.active_version_id],
  );
  const builtin = registry.builtinMeta(key);
  return {
    ...summarize(r),
    supportedModels: r.supported_models as string[],
    compatibilityNotes: r.compatibility_notes ?? builtin?.compatibility ?? null,
    storageEndpoint: builtin?.storageEndpoint ?? null,
    notes: builtin?.notes ?? null,
    activeConfig: r.active_config ?? null,
    latestConfig: r.latest_config ?? null,
    latestVersionId: versions.rows[0]?.id ?? null,
    versions: versions.rows,
  };
}

export async function listIntegrationCameras(key: string, page: number, pageSize: number) {
  await brandRow(key);
  const total = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM cameras WHERE brand_key = $1 AND deleted_at IS NULL", [key])).rows[0]!.n;
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.host, c.port, c.location, c.monitoring_enabled AS "monitoringEnabled",
            s.connection_status AS "connectionStatus", s.storage_health AS "storageHealth", s.last_success_at AS "lastSuccessAt"
     FROM cameras c JOIN camera_status s ON s.camera_id = c.id
     WHERE c.brand_key = $1 AND c.deleted_at IS NULL ORDER BY lower(c.name) LIMIT $2 OFFSET $3`,
    [key, pageSize, (page - 1) * pageSize],
  );
  return { items: rows, total, page, pageSize };
}

export async function listIntegrationTests(key: string, page: number, pageSize: number) {
  await brandRow(key);
  const total = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM brand_integration_tests WHERE brand_key = $1", [key])).rows[0]!.n;
  const { rows } = await pool.query(
    `SELECT t.id, v.version, t.target_host AS "targetHost", t.target_port AS "targetPort", t.ok, t.outcome, t.message,
            t.steps, t.duration_ms AS "durationMs", t.created_at AS "createdAt", u.username AS "createdBy"
     FROM brand_integration_tests t
     LEFT JOIN brand_integration_versions v ON v.id = t.version_id
     LEFT JOIN users u ON u.id = t.created_by
     WHERE t.brand_key = $1 ORDER BY t.created_at DESC LIMIT $2 OFFSET $3`,
    [key, pageSize, (page - 1) * pageSize],
  );
  return { items: rows, total, page, pageSize };
}

// ------------------------------------------------------------------ create / edit

export async function createIntegration(input: z.infer<typeof createIntegrationSchema>, actor: Actor, ip?: string) {
  const config = requireValidConfig(input.config);
  const d = input.details;
  const key = await withTransaction(async (db) => {
    await assertNameFree(d.displayName, null, db);
    const key = await uniqueKey(d.displayName, db);
    await db.query(
      `INSERT INTO camera_brands (key, display_name, support_status, auth_methods, default_http_port, default_https_port, capabilities, notes,
                                  integration_type, status, manufacturer, description, supported_models, default_protocol,
                                  integration_version, compatibility_notes, created_by, updated_by)
       VALUES ($1,$2,'unverified',$3,$4,$5,$6,$7,'configurable','draft',$8,$9,$10,$11,$12,$13,$14,$14)`,
      [
        key, d.displayName, [config.auth.type], d.defaultHttpPort, d.defaultHttpsPort, ["storage-status"], d.description,
        d.manufacturer, d.description, d.supportedModels, d.defaultProtocol, d.integrationVersion, d.compatibilityNotes, actor.id,
      ],
    );
    await db.query(
      "INSERT INTO brand_integration_versions (brand_key, version, config, change_note, created_by) VALUES ($1, 1, $2, $3, $4)",
      [key, JSON.stringify(config), input.changeNote ?? "Initial configuration", actor.id],
    );
    await audit({ actor, ip, action: "integration.created", entityType: "integration", entityId: key, details: { displayName: d.displayName, version: 1 } }, db);
    return key;
  });
  await registry.refresh();
  return getIntegration(key);
}

export async function updateIntegration(key: string, input: z.infer<typeof updateIntegrationSchema>, actor: Actor, ip?: string) {
  const row = await brandRow(key);
  const builtin = row.integration_type === "builtin";
  const d = input.details ?? {};
  if (builtin && (input.config !== undefined || Object.keys(d).some((k) => !["description", "compatibilityNotes", "supportedModels"].includes(k)))) {
    throw new HttpError(400, "BUILTIN_INTEGRATION", "Built-in adapters are maintained in code. Only the description, supported models and compatibility notes can be edited.");
  }
  const config = input.config !== undefined ? requireValidConfig(input.config) : undefined;
  await withTransaction(async (db) => {
    // Serialises concurrent saves of one integration (version numbers are allocated below).
    await db.query("SELECT 1 FROM camera_brands WHERE key = $1 FOR UPDATE", [key]);
    if (d.displayName && d.displayName !== row.display_name) await assertNameFree(d.displayName, key, db);
    const map: Record<string, string> = {
      displayName: "display_name", manufacturer: "manufacturer", description: "description", supportedModels: "supported_models",
      defaultProtocol: "default_protocol", defaultHttpPort: "default_http_port", defaultHttpsPort: "default_https_port",
      integrationVersion: "integration_version", compatibilityNotes: "compatibility_notes",
    };
    const sets: string[] = [];
    const params: unknown[] = [key];
    for (const [k, v] of Object.entries(d)) if (map[k]) sets.push(`${map[k]} = $${params.push(v)}`);
    if (d.description !== undefined && !builtin) sets.push(`notes = $${params.push(d.description)}`);

    let newVersion: number | undefined;
    if (config) {
      const latest = (await db.query("SELECT version, config FROM brand_integration_versions WHERE brand_key = $1 ORDER BY version DESC LIMIT 1", [key])).rows[0];
      // jsonb does not keep key order, so compare canonical forms.
      if (!latest || canonical(latest.config) !== canonical(config)) {
        newVersion = (latest?.version ?? 0) + 1;
        await db.query(
          "INSERT INTO brand_integration_versions (brand_key, version, config, change_note, created_by) VALUES ($1,$2,$3,$4,$5)",
          [key, newVersion, JSON.stringify(config), input.changeNote, actor.id],
        );
        // A changed configuration must be tested again; an enabled integration keeps running its tested version.
        if (row.status === "tested") sets.push("status = 'draft'");
        sets.push(`auth_methods = $${params.push([config.auth.type])}`);
      }
    }
    sets.push(`updated_by = $${params.push(actor.id)}`, "updated_at = now()");
    await db.query(`UPDATE camera_brands SET ${sets.join(", ")} WHERE key = $1`, params);
    await audit(
      { actor, ip, action: "integration.updated", entityType: "integration", entityId: key, details: { fields: Object.keys(d), newVersion: newVersion ?? null } },
      db,
    );
  });
  await registry.refresh();
  return getIntegration(key);
}

// ------------------------------------------------------------------ preview and test

export function previewMapping(input: z.infer<typeof previewSchema>) {
  const response = integrationConfigSchema.shape.response.safeParse((input.config as { response?: unknown } | null)?.response);
  if (!response.success) return { ok: false, stage: "config" as const, issues: formatZodError(response.error).map((i) => ({ ...i, field: `response.${i.field}` })) };
  try {
    const parsed = parseBody(input.sample, response.data.format);
    const mapping = mapStorage(parsed, response.data);
    const ok = mapping.errors.length === 0 && mapping.missing.length === 0;
    return { ok, stage: "mapping" as const, mapping };
  } catch (err) {
    if (err instanceof MappingError) return { ok: false, stage: "format" as const, message: err.message };
    throw err;
  }
}

export type TestOutcome =
  | "OK" | "CONFIG_INVALID" | "DESTINATION_NOT_ALLOWED" | "NETWORK_FAILURE" | "AUTH_FAILURE" | "HTTP_FAILURE"
  | "INVALID_FORMAT" | "MAPPING_FAILURE" | "NO_STORAGE_DATA";

export const OUTCOME_LABELS: Record<TestOutcome, string> = {
  OK: "Storage retrieved successfully",
  CONFIG_INVALID: "Configuration is invalid",
  DESTINATION_NOT_ALLOWED: "Camera address is not allowed",
  NETWORK_FAILURE: "Network or connection failure",
  AUTH_FAILURE: "Authentication failure",
  HTTP_FAILURE: "HTTP / API failure",
  INVALID_FORMAT: "Invalid XML or JSON",
  MAPPING_FAILURE: "Response mapping failure",
  NO_STORAGE_DATA: "No storage data",
};

function classify(e: CameraApiError): TestOutcome {
  if (e.code === "HOST_NOT_ALLOWED" || e.code === "INVALID_HOST") return "DESTINATION_NOT_ALLOWED";
  if (NETWORK_ERROR_CODES.has(e.code)) return "NETWORK_FAILURE";
  if (AUTH_ERROR_CODES.has(e.code)) return "AUTH_FAILURE";
  if (e.code === "INVALID_RESPONSE") return e.options.kind === "mapping" ? "MAPPING_FAILURE" : e.options.kind === "no_storage" ? "NO_STORAGE_DATA" : "INVALID_FORMAT";
  if (e.code === "CREDENTIALS_UNAVAILABLE") return "AUTH_FAILURE";
  return "HTTP_FAILURE";
}

export interface IntegrationTestResult {
  ok: boolean;
  outcome: TestOutcome;
  outcomeLabel: string;
  message: string;
  steps: DiagnosticStep[];
  deviceInfo?: DeviceInfo;
  storage?: StorageReading;
  mapping?: MappingResult;
  sample?: string;
  durationMs: number;
  versionId: string | null;
  version: number | null;
}

async function resolveTarget(target: z.infer<typeof targetSchema>, key: string): Promise<{ camera: CameraConfig; cameraId: string | null }> {
  const settings = await getMonitoringSettings();
  if ("cameraId" in target) {
    const own = await pool.query("SELECT 1 FROM cameras WHERE id = $1 AND brand_key = $2 AND deleted_at IS NULL", [target.cameraId, key]);
    if (!own.rowCount) throw new HttpError(400, "VALIDATION_ERROR", "Choose a camera registered with this brand, or enter a test camera");
    return { camera: await getCameraConfig(target.cameraId, settings.requestTimeoutMs), cameraId: target.cameraId };
  }
  return {
    camera: { host: target.host, port: target.port, protocol: target.protocol, username: target.username, password: target.password, caCertificate: target.caCertificate ?? null, timeoutMs: settings.requestTimeoutMs },
    cameraId: null,
  };
}

const STEP_LABELS = { config: "Configuration", reachability: "Network reachability", authentication: "Authentication", api: "Device API", storage: "Storage query" } as const;

/** Tests a configurable version against a camera, step by step, without throwing for camera faults. */
async function runConfigurableTest(adapter: ConfigurableAdapter, camera: CameraConfig) {
  const steps: (DiagnosticStep | { key: "config"; label: string; status: DiagnosticStep["status"]; message: string })[] = [];
  const step = (key: keyof typeof STEP_LABELS, status: DiagnosticStep["status"], message: string) => steps.push({ key: key as DiagnosticStep["key"], label: STEP_LABELS[key], status, message });
  step("config", "passed", `${adapter.config.request.method} ${adapter.config.request.path} · ${adapter.config.auth.type} authentication · ${adapter.config.response.format.toUpperCase()} mapping`);
  let deviceInfo: DeviceInfo | undefined;
  if (adapter.config.deviceInfo) {
    try {
      deviceInfo = await adapter.getDeviceInfo(camera);
    } catch {
      // Optional; the storage request below decides the outcome.
    }
  }
  try {
    const probe = await adapter.probeStorage(camera);
    step("reachability", "passed", `Connected to ${camera.host}:${camera.port} over ${camera.protocol.toUpperCase()}`);
    step("authentication", "passed", adapter.config.auth.type === "none" ? "No authentication required" : "Credentials accepted");
    step("api", "passed", `HTTP ${probe.status}, ${probe.pages} page(s), valid ${adapter.config.response.format.toUpperCase()}`);
    const m = probe.mapping;
    const devices = m.devices.filter((d) => d.device).length;
    let outcome: TestOutcome = "OK";
    let message: string;
    if (m.errors.length) {
      outcome = "MAPPING_FAILURE";
      message = m.errors[0]!;
    } else if (m.missing.length) {
      outcome = devices === 0 && m.devices.length === 0 ? "NO_STORAGE_DATA" : "MAPPING_FAILURE";
      message = outcome === "NO_STORAGE_DATA" ? m.missing[0]! : `Required field missing: ${m.missing.join(", ")}`;
    } else if (devices === 0) {
      outcome = "NO_STORAGE_DATA";
      message = "The camera reports no installed storage device";
    } else {
      message = `${devices} storage device(s) mapped`;
    }
    step("storage", outcome === "OK" ? "passed" : "failed", outcome === "OK" ? `${message}; ${m.warnings.length ? m.warnings.join("; ") : "all required fields present"}` : message);
    return { outcome, message, steps, deviceInfo, mapping: m, storage: outcome === "OK" ? m.reading : undefined, body: probe.body };
  } catch (err) {
    const e = toCameraError(err);
    const outcome = classify(e);
    if (outcome === "DESTINATION_NOT_ALLOWED" || outcome === "NETWORK_FAILURE") step("reachability", "failed", e.message);
    else {
      step("reachability", "passed", `Connected to ${camera.host}:${camera.port} over ${camera.protocol.toUpperCase()}`);
      if (outcome === "AUTH_FAILURE") step("authentication", "failed", e.message);
      else {
        step("authentication", "passed", "Credentials accepted");
        step(outcome === "HTTP_FAILURE" ? "api" : "storage", "failed", e.message);
      }
    }
    return { outcome, message: e.message, steps, deviceInfo };
  }
}

export async function testIntegration(key: string, input: z.infer<typeof testIntegrationSchema>, actor: Actor, ip?: string): Promise<IntegrationTestResult> {
  const row = await brandRow(key);
  const started = Date.now();
  const { camera, cameraId } = await resolveTarget(input.target, key);
  const secrets = secretVariants(camera);
  let result: Omit<IntegrationTestResult, "durationMs" | "versionId" | "version" | "outcomeLabel">;
  let version: { id: string; version: number } | null = null;

  if (row.integration_type === "builtin") {
    const adapter = registry.builtinAdapter(key);
    if (!adapter) throw notFound("Built-in adapter");
    const r = await adapter.testConnection(camera);
    const outcome: TestOutcome = r.ok ? (r.storage && r.storage.devices.length > 0 ? "OK" : "NO_STORAGE_DATA") : classify(new CameraApiError(r.error!.code, r.error!.message));
    result = { ok: outcome === "OK", outcome, message: r.error?.message ?? (outcome === "OK" ? "Storage retrieved" : "The camera reports no storage device"), steps: r.steps, deviceInfo: r.deviceInfo, storage: r.storage };
  } else {
    const v = input.versionId
      ? (await pool.query("SELECT id, version, config FROM brand_integration_versions WHERE id = $1 AND brand_key = $2", [input.versionId, key])).rows[0]
      : (await pool.query("SELECT id, version, config FROM brand_integration_versions WHERE brand_key = $1 ORDER BY version DESC LIMIT 1", [key])).rows[0];
    if (!v) throw notFound("Configuration version");
    version = { id: v.id, version: v.version };
    const parsed = integrationConfigSchema.safeParse(v.config);
    if (!parsed.success) {
      const issues = formatZodError(parsed.error);
      result = { ok: false, outcome: "CONFIG_INVALID", message: `${issues[0]!.field}: ${issues[0]!.message}`, steps: [{ key: "api", label: "Configuration", status: "failed", message: issues[0]!.message }] };
    } else {
      const adapter = registry.createConfigurable(
        { key, displayName: row.display_name, version: row.integration_version, versionNumber: v.version, defaultPorts: { http: row.default_http_port, https: row.default_https_port } },
        parsed.data,
      );
      const r = await runConfigurableTest(adapter, camera);
      result = {
        ok: r.outcome === "OK",
        outcome: r.outcome,
        message: r.message,
        steps: r.steps as DiagnosticStep[],
        deviceInfo: r.deviceInfo,
        storage: r.storage,
        mapping: r.mapping,
        sample: r.body !== undefined ? redactSample(r.body, parsed.data.response.format, secrets) : undefined,
      };
    }
  }

  // Sanitise everything before it is returned or stored.
  result = sanitizeResult(result, secrets);
  const durationMs = Date.now() - started;

  await withTransaction(async (db) => {
    await db.query(
      `INSERT INTO brand_integration_tests (brand_key, version_id, target_host, target_port, camera_id, ok, outcome, message, steps, storage, duration_ms, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [key, version?.id ?? null, camera.host, camera.port, cameraId, result.ok, result.outcome, result.message, JSON.stringify(result.steps),
       result.storage ? JSON.stringify({ totalBytes: result.storage.totalBytes, freeBytes: result.storage.freeBytes, devices: result.storage.devices.length }) : null,
       durationMs, actor.id],
    );
    await db.query(
      `UPDATE camera_brands SET last_test_at = now(), last_test_ok = $2, last_success_at = CASE WHEN $2 THEN now() ELSE last_success_at END WHERE key = $1`,
      [key, result.ok],
    );
    if (version) {
      // A passed version stays passed: a later failure is usually the test camera, not the configuration.
      await db.query(
        `UPDATE brand_integration_versions SET test_status = CASE WHEN $2 THEN 'passed' WHEN test_status = 'passed' THEN 'passed' ELSE 'failed' END,
                tested_at = now() WHERE id = $1`,
        [version.id, result.ok],
      );
      if (result.ok && row.status === "draft") {
        const latest = (await db.query("SELECT id FROM brand_integration_versions WHERE brand_key = $1 ORDER BY version DESC LIMIT 1", [key])).rows[0];
        if (latest?.id === version.id) await db.query("UPDATE camera_brands SET status = 'tested', support_status = 'unverified' WHERE key = $1", [key]);
      }
    }
    await audit({ actor, ip, action: "integration.tested", entityType: "integration", entityId: key, details: { version: version?.version ?? null, ok: result.ok, outcome: result.outcome, host: camera.host } }, db);
  });

  return { ...result, outcomeLabel: OUTCOME_LABELS[result.outcome], durationMs, versionId: version?.id ?? null, version: version?.version ?? null };
}

// ------------------------------------------------------------------ lifecycle

async function impact(key: string, db: Queryable = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS cameras, count(*) FILTER (WHERE monitoring_enabled)::int AS monitored
     FROM cameras WHERE brand_key = $1 AND deleted_at IS NULL`,
    [key],
  );
  return rows[0] as { cameras: number; monitored: number };
}

export async function enableIntegration(key: string, versionId: string | undefined, actor: Actor, ip?: string) {
  const row = await brandRow(key);
  let version: number | null = null;
  await withTransaction(async (db) => {
    if (row.integration_type === "configurable") {
      const cols = "SELECT id, version, config, test_status FROM brand_integration_versions";
      let v = versionId
        ? (await db.query(`${cols} WHERE id = $1 AND brand_key = $2`, [versionId, key])).rows[0]
        : (await db.query(`${cols} WHERE brand_key = $1 ORDER BY version DESC LIMIT 1`, [key])).rows[0];
      if (!versionId && v?.test_status !== "passed" && row.active_version_id) {
        // Re-enabling with a newer untested draft: fall back to the tested version that was in use.
        const active = (await db.query(`${cols} WHERE id = $1`, [row.active_version_id])).rows[0];
        if (active?.test_status === "passed") v = active;
      }
      if (!v) throw notFound("Configuration version");
      if (v.test_status !== "passed") {
        throw new HttpError(409, "NOT_TESTED", `Version ${v.version} has not passed an API test. Run Test API successfully before enabling it.`);
      }
      if (!integrationConfigSchema.safeParse(v.config).success) throw new HttpError(409, "CONFIG_INVALID", `Version ${v.version} no longer validates and cannot be enabled.`);
      version = v.version;
      await db.query("UPDATE camera_brands SET status = 'enabled', active_version_id = $2, updated_by = $3, updated_at = now() WHERE key = $1", [key, v.id, actor.id]);
    } else {
      await db.query("UPDATE camera_brands SET status = 'enabled', updated_by = $2, updated_at = now() WHERE key = $1", [key, actor.id]);
    }
    await audit({ actor, ip, action: row.status === "enabled" ? "integration.version_activated" : "integration.enabled", entityType: "integration", entityId: key, details: { version } }, db);
  });
  await registry.refresh();
  return getIntegration(key);
}

export async function disableIntegration(key: string, actor: Actor, ip?: string) {
  const row = await brandRow(key);
  const affected = await impact(key);
  await withTransaction(async (db) => {
    await db.query("UPDATE camera_brands SET status = 'disabled', updated_by = $2, updated_at = now() WHERE key = $1", [key, actor.id]);
    await audit({ actor, ip, action: "integration.disabled", entityType: "integration", entityId: key, details: { previousStatus: row.status, ...affected } }, db);
  });
  await registry.refresh();
  return { integration: await getIntegration(key), impact: affected };
}

export async function getImpact(key: string) {
  await brandRow(key);
  return impact(key);
}

export async function reassignCameras(key: string, toKey: string, actor: Actor, ip?: string) {
  await brandRow(key);
  if (toKey === key) throw new HttpError(400, "VALIDATION_ERROR", "Choose a different integration");
  if (!registry.isSupported(toKey)) throw new HttpError(400, "VALIDATION_ERROR", "Cameras can only be moved to an enabled integration");
  if (registry.credentialsOf(key) !== registry.credentialsOf(toKey)) {
    throw new HttpError(
      409, "CREDENTIALS_MISMATCH",
      "The target integration uses a different kind of login, so the cameras' stored credentials would not work. Edit the cameras individually and enter the new credentials.",
    );
  }
  if (registry.requiresHttps(toKey)) {
    const http = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM cameras WHERE brand_key = $1 AND deleted_at IS NULL AND protocol = 'http'", [key])).rows[0]!.n;
    if (http > 0) throw new HttpError(409, "HTTPS_REQUIRED", `${http} camera(s) use HTTP, but the target integration only sends credentials over HTTPS. Switch them to HTTPS first.`);
  }
  const moved = await withTransaction(async (db) => {
    const clash = await db.query(
      `SELECT a.name FROM cameras a JOIN cameras b ON b.host = a.host AND b.port = a.port AND b.brand_key = $2 AND b.deleted_at IS NULL
       WHERE a.brand_key = $1 AND a.deleted_at IS NULL LIMIT 1`,
      [key, toKey],
    );
    if (clash.rowCount) throw conflict(`"${clash.rows[0].name}" already exists under the target integration with the same address and port`);
    const r = await db.query("UPDATE cameras SET brand_key = $2, updated_at = now() WHERE brand_key = $1 AND deleted_at IS NULL RETURNING id", [key, toKey]);
    await db.query("UPDATE camera_status SET next_check_at = now() WHERE camera_id = ANY($1::uuid[])", [r.rows.map((x) => x.id)]);
    await audit({ actor, ip, action: "integration.cameras_reassigned", entityType: "integration", entityId: key, details: { to: toKey, cameras: r.rowCount } }, db);
    return r.rowCount ?? 0;
  });
  return { moved };
}

export async function deleteIntegration(key: string, actor: Actor, ip?: string) {
  const row = await brandRow(key);
  if (row.integration_type === "builtin") {
    throw new HttpError(400, "BUILTIN_INTEGRATION", "Built-in adapters cannot be deleted. Disable the integration instead.");
  }
  const { cameras } = await impact(key);
  if (cameras > 0) {
    throw new HttpError(409, "IN_USE", `${cameras} camera(s) use this integration. Move them to another integration (Reassign cameras) or remove them first.`, { cameras });
  }
  await withTransaction(async (db) => {
    const removed = (await db.query("SELECT 1 FROM cameras WHERE brand_key = $1 LIMIT 1", [key])).rowCount;
    // Removed cameras keep their history, which references the brand: keep the row, hidden.
    if (removed) await db.query("UPDATE camera_brands SET deleted_at = now(), status = 'disabled', updated_by = $2 WHERE key = $1", [key, actor.id]);
    else await db.query("DELETE FROM camera_brands WHERE key = $1", [key]);
    await audit({ actor, ip, action: "integration.deleted", entityType: "integration", entityId: key, details: { displayName: row.display_name } }, db);
  });
  await registry.refresh();
}
