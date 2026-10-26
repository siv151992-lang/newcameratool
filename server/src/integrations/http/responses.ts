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
  if (res.status >= 300 && res.status < 400) throw redirectError(res, path);
  throw new CameraApiError("API_ERROR", `Camera returned HTTP ${res.status} for ${path}`, {
    httpStatus: res.status,
    transient: res.status >= 500,
  });
}

/**
 * A camera that redirects an API request instead of answering it: usually to HTTPS (the camera
 * accepts only HTTPS, as newer Hikvision and Prama firmware can be set to), or to its web login
 * page. Says which, and what to change.
 */
export function redirectError(res: CameraResponse, path: string): CameraApiError {
  const raw = res.headers.location;
  const location = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  let where = location.split("?")[0]!.slice(0, 120);
  let https = false;
  try {
    const u = new URL(location, "http://camera");
    https = u.protocol === "https:";
    where = location.startsWith("/") ? u.pathname : `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // keep the raw value
  }
  const opts = { httpStatus: res.status };
  if (https) {
    return new CameraApiError(
      "API_ERROR",
      `The camera redirects ${path} to HTTPS (${where}): it accepts only HTTPS. Edit the camera and set Protocol to HTTPS (port 443); ` +
        "if its certificate is self-signed, add it under TLS CA certificate.",
      opts,
    );
  }
  if (/login|logon|signin|doc\/page|index\.(asp|html?)/i.test(where)) {
    return new CameraApiError(
      "API_ERROR",
      `The camera redirected ${path} to its web login page (${where}) instead of answering the API. Check that the camera's ` +
        "API (ISAPI / CGI) is turned on and that the user may use it, and that the address is the camera's own (not a router or web portal).",
      opts,
    );
  }
  return new CameraApiError("API_ERROR", `The camera redirected ${path} to ${where || "another address"} (HTTP ${res.status}) instead of answering it.`, opts);
}
