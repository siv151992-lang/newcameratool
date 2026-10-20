import { runDiagnostics } from "../diagnostics.js";
import type { CameraHttpClient, CameraRequest } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { aggregate } from "../storageMath.js";
import { CameraApiError, type BrandMeta, type CameraBrandAdapter, type CameraConfig, type ConnectionResult, type DeviceInfo, type StorageReading } from "../types.js";
import { credentialModeFor, type IntegrationConfig } from "./config.js";
import { assertUsable, mapDeviceInfo, mapStorage, MappingError, parseBody, type MappingResult } from "./mapping.js";

/**
 * Mode A: an integration defined entirely by a validated IntegrationConfig. It uses the same
 * hardened CameraHttpClient as the built-in adapters (SSRF guard, pinned DNS, no redirects, size
 * limit, verified TLS), so a configuration can only reach allowed camera addresses.
 */

export interface ConfigurableMeta {
  key: string;
  displayName: string;
  version: string;
  versionNumber: number;
  defaultPorts: { http: number; https: number };
  notes?: string | null;
}

/** The first page's body (redacted later by the caller) and the mapping of all pages. */
export interface StorageProbe {
  body: string;
  status: number;
  pages: number;
  mapping: MappingResult;
  reading?: StorageReading;
}

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export function toCameraError(err: unknown): CameraApiError {
  if (err instanceof CameraApiError) return err;
  if (err instanceof MappingError) {
    return new CameraApiError("INVALID_RESPONSE", err.message, { kind: err.kind });
  }
  return new CameraApiError("API_ERROR", "Unexpected error while reading the camera response");
}

export class ConfigurableAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta;
  private readonly limit: Semaphore;

  constructor(
    private readonly http: CameraHttpClient,
    info: ConfigurableMeta,
    readonly config: IntegrationConfig,
  ) {
    const capabilities = ["storage-status", "connection-test", "multiple-storage-devices"];
    if (config.deviceInfo) capabilities.push("device-info");
    this.meta = {
      key: info.key,
      displayName: info.displayName,
      supportStatus: "unverified",
      authMethods: [config.auth.type === "api_key" ? `api key (${config.auth.apiKeyIn})` : config.auth.type],
      defaultPorts: info.defaultPorts,
      capabilities,
      storageEndpoint: `${config.request.method} ${config.request.path}`,
      defaultTimeoutMs: config.request.timeoutMs,
      notes: info.notes || "Configurable API integration.",
      version: info.version,
      integrationType: "configurable",
      credentials: credentialModeFor(config.auth.type),
    };
    this.limit = new Semaphore(config.maxConcurrency);
  }

  /** Builds the request with authentication applied. Secrets never appear in displayPath. */
  private build(camera: CameraConfig, path: string, query: { name: string; value: string }[], format: "json" | "xml", extra: Partial<CameraRequest> = {}): CameraRequest {
    const { auth } = this.config;
    if (auth.type !== "none" && auth.type !== "digest" && camera.protocol !== "https") {
      throw new CameraApiError(
        "AUTH_METHOD_INSECURE",
        `${auth.type === "basic" ? "Basic authentication" : auth.type === "bearer" ? "A bearer token" : "An API key"} is only sent over HTTPS. Use HTTPS for this camera or an integration with Digest authentication.`,
      );
    }
    const params = query.map((q) => [q.name, q.value] as [string, string]);
    const shown = [...params];
    const headers: Record<string, string> = Object.fromEntries(this.config.request.headers.map((h) => [h.name, h.value]));
    let mode: CameraRequest["auth"] = "none";
    if (auth.type === "digest") mode = "digest";
    else if (auth.type === "basic") mode = { authorization: "Basic " + Buffer.from(`${camera.username}:${camera.password}`, "utf8").toString("base64") };
    else if (auth.type === "bearer") mode = { authorization: `Bearer ${camera.password}` };
    else if (auth.type === "api_key") {
      if (auth.apiKeyIn === "query") {
        params.push([auth.apiKeyName!, camera.password]);
        shown.push([auth.apiKeyName!, "[REDACTED]"]);
      } else headers[auth.apiKeyName!] = camera.password;
    }
    const qs = (p: [string, string][]) => (p.length ? "?" + p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "");
    return {
      path: path + qs(params),
      displayPath: path + qs(shown),
      accept: format === "json" ? "application/json, */*" : "application/xml, text/xml, */*",
      headers,
      auth: mode,
      ...extra,
    };
  }

  private async fetch(camera: CameraConfig, req: CameraRequest): Promise<{ body: string; status: number }> {
    const res = await this.limit.run(() => this.http.request({ ...camera, timeoutMs: Math.min(camera.timeoutMs, this.config.request.timeoutMs) }, req));
    return { body: requireOk(res, req.displayPath ?? req.path), status: res.status };
  }

  /** Runs the storage request (all pages) and maps it, without throwing on mapping problems. */
  async probeStorage(camera: CameraConfig): Promise<StorageProbe> {
    const { request, response, pagination } = this.config;
    const pages = pagination.type === "page" ? pagination.maxPages : 1;
    let firstBody = "";
    let firstStatus = 0;
    const parsedPages: unknown[] = [];
    let mapping: MappingResult | undefined;
    for (let i = 0; i < pages; i++) {
      const query = [...request.query];
      if (pagination.type === "page") {
        query.push({ name: pagination.pageParam, value: String(pagination.firstPage + i) });
        if (pagination.pageSizeParam && pagination.pageSize) query.push({ name: pagination.pageSizeParam, value: String(pagination.pageSize) });
      }
      const req = this.build(camera, request.path, query, response.format, {
        method: request.method,
        body: request.body ?? undefined,
        contentType: request.contentType ?? (request.body ? (response.format === "json" ? "application/json" : "application/xml") : undefined),
      });
      const { body, status } = await this.fetch(camera, req);
      if (i === 0) {
        firstBody = body;
        firstStatus = status;
      }
      const parsed = parseBody(body, response.format);
      const pageMap = mapStorage(parsed, response);
      parsedPages.push(parsed);
      if (i > 0 && pageMap.devices.length === 0) break;
      mapping = mergeMappings(mapping, pageMap);
      if (pagination.type === "page" && pagination.pageSize && pageMap.devices.length < pagination.pageSize) break;
    }
    return { body: firstBody, status: firstStatus, pages: parsedPages.length, mapping: mapping! };
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    try {
      return assertUsable((await this.probeStorage(camera)).mapping);
    } catch (err) {
      throw toCameraError(err);
    }
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    const di = this.config.deviceInfo;
    if (!di) return {};
    try {
      const { body } = await this.fetch(camera, this.build(camera, di.path, di.query, di.format));
      return mapDeviceInfo(parseBody(body, di.format), di.fields);
    } catch (err) {
      throw toCameraError(err);
    }
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}

function mergeMappings(a: MappingResult | undefined, b: MappingResult): MappingResult {
  if (!a) return b;
  const offset = a.devices.length;
  const devices = [...a.devices, ...b.devices.map((d) => ({ ...d, index: d.index + offset }))];
  const real = devices.flatMap((d) => (d.device ? [d.device] : []));
  return {
    devices,
    reading: aggregate(real),
    errors: [...a.errors, ...b.errors],
    warnings: [...a.warnings, ...b.warnings],
    missing: b.missing.length && a.missing.length ? a.missing : [],
  };
}
