import { registry } from "../integrations/registry.js";
import {
  CameraApiError,
  type CameraBrandAdapter,
  type CameraConfig,
  type ConnectionResult,
} from "../integrations/types.js";
import { redactSecrets } from "../security/redact.js";
import { type CameraUpdate, defaultPort, getCameraConfig, getCameraRow } from "./cameraService.js";
import { getMonitoringSettings } from "./settingsService.js";

interface TestableInput {
  host: string;
  port?: number | null;
  protocol: "http" | "https";
  brand: string;
  username: string;
  password: string;
  caCertificate?: string | null;
}

function redactResult(result: ConnectionResult, secrets: string[]): ConnectionResult {
  return {
    ...result,
    steps: result.steps.map((s) => ({ ...s, message: redactSecrets(s.message, secrets) })),
    error: result.error && { ...result.error, message: redactSecrets(result.error.message, secrets) },
  };
}

async function run(adapter: CameraBrandAdapter, cfg: CameraConfig): Promise<ConnectionResult> {
  try {
    return redactResult(await adapter.testConnection(cfg), [cfg.password]);
  } catch (err) {
    const e = err instanceof CameraApiError ? err : new CameraApiError("API_ERROR", "Unexpected error during connection test");
    return {
      ok: false,
      reachable: false,
      steps: [{ key: "reachability", label: "Network reachability", status: "failed", message: redactSecrets(e.message, [cfg.password]) }],
      error: { code: e.code, message: redactSecrets(e.message, [cfg.password]) },
    };
  }
}

/** Tests an unsaved camera configuration (Add Camera form, import). Nothing is stored. */
export async function testCameraConfig(adapter: CameraBrandAdapter, input: TestableInput): Promise<ConnectionResult> {
  const settings = await getMonitoringSettings();
  return run(adapter, {
    host: input.host,
    port: input.port ?? defaultPort(input.brand, input.protocol),
    protocol: input.protocol,
    username: input.username,
    password: input.password,
    caCertificate: input.caCertificate ?? null,
    timeoutMs: settings.requestTimeoutMs,
  });
}

/** Tests a saved camera, optionally with edits from the form applied (blank password = keep stored). */
export async function testSavedCamera(id: string, overrides: CameraUpdate = {}): Promise<ConnectionResult> {
  const settings = await getMonitoringSettings();
  const row = await getCameraRow(id);
  const brand = overrides.brand ?? row.brand_key;
  let stored: CameraConfig;
  try {
    stored = await getCameraConfig(id, settings.requestTimeoutMs);
  } catch (err) {
    if (!(err instanceof CameraApiError) || overrides.password === undefined) {
      const e = err instanceof CameraApiError ? err : new CameraApiError("API_ERROR", "Could not load camera configuration");
      return { ok: false, reachable: false, steps: [], error: { code: e.code, message: e.message } };
    }
    stored = { host: row.host, port: row.port, protocol: row.protocol, username: row.username ?? "", password: "", timeoutMs: settings.requestTimeoutMs };
  }
  const protocol = overrides.protocol ?? stored.protocol;
  const port =
    overrides.port ?? (overrides.protocol && overrides.protocol !== row.protocol ? defaultPort(brand, protocol) : stored.port);
  return run(registry.get(brand), {
    ...stored,
    host: overrides.host ?? stored.host,
    port,
    protocol,
    username: overrides.username ?? stored.username,
    password: overrides.password ?? stored.password,
    caCertificate: overrides.caCertificate === undefined ? stored.caCertificate : overrides.caCertificate,
  });
}
