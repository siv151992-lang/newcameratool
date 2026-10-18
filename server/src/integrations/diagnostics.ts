import { formatBytes } from "../lib/format.js";
import {
  AUTH_ERROR_CODES,
  CameraApiError,
  NETWORK_ERROR_CODES,
  type CameraBrandAdapter,
  type CameraConfig,
  type ConnectionResult,
  type DeviceInfo,
  type DiagnosticStep,
  type StorageReading,
} from "./types.js";

const LABELS = {
  reachability: "Network reachability",
  authentication: "Authentication",
  api: "Device API",
  storage: "Storage query",
} as const;

function asCameraError(err: unknown): CameraApiError {
  return err instanceof CameraApiError ? err : new CameraApiError("API_ERROR", "Unexpected error while contacting the camera");
}

/**
 * Generic step-by-step connection test built on an adapter's device-info and storage calls.
 * Reports reachability, authentication, API availability and storage separately so the
 * user can tell an unreachable device from bad credentials or a missing storage API.
 */
export async function runDiagnostics(adapter: CameraBrandAdapter, camera: CameraConfig): Promise<ConnectionResult> {
  const steps: DiagnosticStep[] = [];
  const step = (key: DiagnosticStep["key"], status: DiagnosticStep["status"], message: string) =>
    steps.push({ key, label: LABELS[key], status, message });

  let deviceInfo: DeviceInfo | undefined;
  let infoError: CameraApiError | undefined;
  try {
    deviceInfo = await adapter.getDeviceInfo(camera);
  } catch (err) {
    infoError = asCameraError(err);
  }

  if (infoError && (NETWORK_ERROR_CODES.has(infoError.code) || ["INVALID_HOST", "HOST_NOT_ALLOWED"].includes(infoError.code))) {
    step("reachability", "failed", infoError.message);
    step("authentication", "skipped", "Not attempted because the camera could not be reached");
    step("api", "skipped", "Not attempted");
    step("storage", "skipped", "Not attempted");
    return { ok: false, reachable: false, steps, error: { code: infoError.code, message: infoError.message } };
  }
  step("reachability", "passed", `Connected to ${camera.host}:${camera.port} over ${camera.protocol.toUpperCase()}`);

  if (infoError && AUTH_ERROR_CODES.has(infoError.code)) {
    step("authentication", "failed", infoError.message);
    step("api", "skipped", "Not attempted because authentication failed");
    step("storage", "skipped", "Not attempted");
    return { ok: false, reachable: true, steps, error: { code: infoError.code, message: infoError.message } };
  }

  if (infoError) {
    // Device info is optional; carry on to the storage query, which also proves authentication.
    step("api", "warning", `Device information unavailable: ${infoError.message}`);
  } else {
    step("authentication", "passed", "Credentials accepted");
    const desc = [deviceInfo?.model, deviceInfo?.firmwareVersion && `firmware ${deviceInfo.firmwareVersion}`].filter(Boolean).join(", ");
    step("api", "passed", desc ? `Device API responded (${desc})` : "Device API responded");
  }

  let storage: StorageReading | undefined;
  try {
    storage = await adapter.getStorageStatus(camera);
  } catch (err) {
    const e = asCameraError(err);
    if (AUTH_ERROR_CODES.has(e.code) && !steps.some((s) => s.key === "authentication")) {
      step("authentication", "failed", e.message);
    }
    step("storage", "failed", e.message);
    return { ok: false, reachable: true, steps: order(steps), deviceInfo, error: { code: e.code, message: e.message } };
  }
  if (!steps.some((s) => s.key === "authentication")) step("authentication", "passed", "Credentials accepted");

  if (storage.devices.length === 0) {
    step("storage", "warning", "Storage API responded but the camera reports no storage device (is an SD card inserted?)");
  } else if (storage.totalBytes !== undefined) {
    step(
      "storage",
      "passed",
      `${storage.devices.length} storage device(s): ${formatBytes(storage.usedBytes)} used of ${formatBytes(storage.totalBytes)} (${storage.usedPercentage ?? "?"}%)`,
    );
  } else {
    step("storage", "warning", `${storage.devices.length} storage device(s) reported, but capacity figures were missing`);
  }
  return { ok: true, reachable: true, steps: order(steps), deviceInfo, storage };
}

const ORDER = ["reachability", "authentication", "api", "storage"];
const order = (steps: DiagnosticStep[]) => [...steps].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
