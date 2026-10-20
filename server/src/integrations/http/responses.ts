import { CameraApiError } from "../types.js";
import type { CameraResponse } from "./cameraHttpClient.js";

/**
 * Returns the body of a successful response, or throws a classified error for a failed one.
 * `describe` lets a brand turn its own error body (CGI "Error ...", SOAP Fault, ...) into a more
 * precise error; a missing endpoint (404/405/501) is always API_UNAVAILABLE and 5xx is transient.
 */
export function requireOk(
  res: CameraResponse,
  path: string,
  describe?: (body: string) => CameraApiError | undefined,
): string {
  if (res.status >= 200 && res.status < 300) return res.body;
  const notFound = res.status === 404 || res.status === 405 || res.status === 501;
  const described = describe?.(res.body);
  if (described) {
    // SOAP sends every fault as HTTP 400/500, so an authentication fault stays one whatever the
    // status, and only a generic device error is worth retrying.
    const isAuth = described.code === "AUTH_FAILED" || described.code === "PERMISSION_DENIED";
    const code = notFound && !isAuth ? "API_UNAVAILABLE" : described.code;
    throw new CameraApiError(code, described.message, { httpStatus: res.status, transient: res.status >= 500 && code === "API_ERROR" });
  }
  if (notFound) {
    throw new CameraApiError("API_UNAVAILABLE", `The camera does not provide ${path} (HTTP ${res.status})`, { httpStatus: res.status });
  }
  throw new CameraApiError("API_ERROR", `Camera returned HTTP ${res.status} for ${path}`, {
    httpStatus: res.status,
    transient: res.status >= 500,
  });
}
