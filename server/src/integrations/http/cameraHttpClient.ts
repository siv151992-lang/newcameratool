import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { HostNotAllowedError } from "../../security/hostGuard.js";
import { CameraApiError, type CameraConfig } from "../types.js";

/**
 * Minimal HTTP client for camera APIs with HTTP Digest (RFC 7616: MD5, SHA-256, -sess)
 * and Basic authentication. Credentials are only ever sent in the Authorization header,
 * never in URLs, and Basic is refused over plain HTTP.
 *
 * - The host is resolved through the HostGuard and the connection is pinned to that address.
 * - Redirects are not followed.
 * - TLS certificates are always verified; a per-camera CA certificate can be supplied instead.
 */

export interface Resolver {
  resolve(host: string): Promise<{ address: string; family: 4 | 6 }>;
}

export interface CameraResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface RawResponse extends CameraResponse {
  challenges: string[];
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class CameraHttpClient {
  constructor(private readonly resolver: Resolver) {}

  async get(camera: CameraConfig, path: string): Promise<CameraResponse> {
    let pinned: { address: string; family: 4 | 6 };
    try {
      pinned = await this.resolver.resolve(camera.host);
    } catch (err) {
      if (err instanceof HostNotAllowedError) throw new CameraApiError(err.code, err.message);
      throw err;
    }
    const deadline = Date.now() + camera.timeoutMs;
    const send = (authorization?: string) => this.send(camera, pinned, path, deadline, authorization);

    let res = await send();
    if (res.status !== 401) return this.finish(res);

    for (let attempt = 0; attempt < 2; attempt++) {
      const authorization = this.buildAuthorization(camera, path, res.challenges);
      res = await send(authorization);
      if (res.status !== 401) return this.finish(res);
      // A stale nonce is not a credential failure: retry once with the fresh challenge.
      const stale = res.challenges.some((c) => /^digest\s/i.test(c) && /stale\s*=\s*"?true"?/i.test(c));
      if (!stale) break;
    }
    throw new CameraApiError("AUTH_FAILED", "The camera rejected the username or password", { httpStatus: 401 });
  }

  private finish(res: RawResponse): CameraResponse {
    if (res.status === 403) {
      throw new CameraApiError("PERMISSION_DENIED", "The camera user does not have permission to use this API", { httpStatus: 403 });
    }
    return { status: res.status, headers: res.headers, body: res.body };
  }

  private buildAuthorization(camera: CameraConfig, path: string, challenges: string[]): string {
    const digests = challenges.filter((c) => /^digest\s/i.test(c)).map(parseChallenge);
    if (digests.length > 0) {
      // Prefer the strongest algorithm offered.
      const rank = (a?: string) => (a?.toUpperCase().startsWith("SHA-256") ? 2 : 1);
      digests.sort((a, b) => rank(b.algorithm) - rank(a.algorithm));
      return digestAuthorization(digests[0]!, camera.username, camera.password, "GET", path);
    }
    if (challenges.some((c) => /^basic/i.test(c))) {
      if (camera.protocol !== "https") {
        throw new CameraApiError(
          "AUTH_METHOD_INSECURE",
          "The camera only offered Basic authentication over HTTP, which would expose the password. Enable Digest authentication on the camera or use HTTPS.",
        );
      }
      return "Basic " + Buffer.from(`${camera.username}:${camera.password}`, "utf8").toString("base64");
    }
    throw new CameraApiError("AUTH_FAILED", "The camera requested an unsupported authentication method", { httpStatus: 401 });
  }

  private send(
    camera: CameraConfig,
    pinned: { address: string; family: 4 | 6 },
    path: string,
    deadline: number,
    authorization?: string,
  ): Promise<RawResponse> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(timeoutError(camera.timeoutMs));
    const isHttps = camera.protocol === "https";
    const hostHeader = (isIP(camera.host) === 6 ? `[${camera.host}]` : camera.host) +
      (camera.port === (isHttps ? 443 : 80) ? "" : `:${camera.port}`);
    const headers: Record<string, string> = { Host: hostHeader, Accept: "application/xml, text/xml, */*", Connection: "close" };
    if (authorization) headers.Authorization = authorization;

    const options: https.RequestOptions = {
      host: pinned.address,
      family: pinned.family,
      port: camera.port,
      path,
      method: "GET",
      headers,
      agent: false,
    };
    if (isHttps) {
      options.rejectUnauthorized = true;
      if (!isIP(camera.host)) options.servername = camera.host;
      if (camera.caCertificate) options.ca = camera.caCertificate;
      // Verify the certificate against the configured host, not the pinned address.
      options.checkServerIdentity = (_h, cert) => checkServerIdentity(camera.host, cert);
    }

    return new Promise<RawResponse>((resolve, reject) => {
      const req = (isHttps ? https : http).request(options, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new CameraApiError("INVALID_RESPONSE", "Camera response exceeded the maximum allowed size"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          clearTimeout(timer);
          const challenges: string[] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            if (res.rawHeaders[i]!.toLowerCase() === "www-authenticate") challenges.push(res.rawHeaders[i + 1]!);
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), challenges });
        });
        res.on("error", (e) => {
          clearTimeout(timer);
          reject(classifyNetworkError(e));
        });
      });
      const timer = setTimeout(() => req.destroy(timeoutError(camera.timeoutMs)), remaining);
      req.on("error", (e) => {
        clearTimeout(timer);
        reject(e instanceof CameraApiError ? e : classifyNetworkError(e));
      });
      req.end();
    });
  }
}

function timeoutError(ms: number) {
  return new CameraApiError("TIMEOUT", `No response from the camera within ${Math.round(ms / 1000)} seconds`, { transient: true });
}

const TLS_CODES = /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_OSSL|EPROTO)/;

export function classifyNetworkError(err: Error & { code?: string }): CameraApiError {
  const code = err.code ?? "";
  if (err instanceof CameraApiError) return err;
  if (TLS_CODES.test(code) || /certificate|ssl|tls|wrong version number/i.test(err.message)) {
    const hint = /wrong version number|EPROTO/i.test(code + err.message)
      ? " The port may not be serving HTTPS — check the protocol and port."
      : " If the camera uses a self-signed certificate, add its CA certificate to the camera settings.";
    return new CameraApiError("TLS_ERROR", `Secure connection failed (${code || "TLS error"}).${hint}`);
  }
  switch (code) {
    case "ECONNREFUSED":
      return new CameraApiError("UNREACHABLE", "Connection refused: nothing is listening on that port", { transient: true });
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EHOSTDOWN":
      return new CameraApiError("UNREACHABLE", "No network route to the camera", { transient: true });
    case "ECONNRESET":
    case "EPIPE":
    case "ECONNABORTED":
      return new CameraApiError("UNREACHABLE", "The connection to the camera was interrupted", { transient: true });
    case "ETIMEDOUT":
      return new CameraApiError("TIMEOUT", "The connection to the camera timed out", { transient: true });
    case "HPE_INVALID_CONSTANT":
    case "HPE_INVALID_HEADER_TOKEN":
      return new CameraApiError("INVALID_RESPONSE", "The device did not reply with valid HTTP");
    default:
      return new CameraApiError("UNREACHABLE", `Network error contacting the camera${code ? ` (${code})` : ""}`, { transient: true });
  }
}

export function parseChallenge(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const body = header.replace(/^\s*digest\s+/i, "");
  const re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) params[m[1]!.toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]!;
  return params;
}

export function digestAuthorization(
  ch: Record<string, string>,
  username: string,
  password: string,
  method: string,
  uri: string,
  cnonce = randomBytes(16).toString("hex"),
  nc = "00000001",
): string {
  const algorithm = (ch.algorithm ?? "MD5").toUpperCase();
  const hashName = algorithm.startsWith("SHA-256") ? "sha256" : "md5";
  if (!/^(MD5|SHA-256)(-SESS)?$/.test(algorithm)) {
    throw new CameraApiError("AUTH_FAILED", `Unsupported digest algorithm ${algorithm}`);
  }
  const H = (s: string) => createHash(hashName).update(s, "utf8").digest("hex");
  const realm = ch.realm ?? "";
  const nonce = ch.nonce ?? "";
  let ha1 = H(`${username}:${realm}:${password}`);
  if (algorithm.endsWith("-SESS")) ha1 = H(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  const qops = (ch.qop ?? "").split(",").map((q) => q.trim().toLowerCase()).filter(Boolean);
  const quote = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(nonce)}`,
    `uri=${quote(uri)}`,
    `algorithm=${ch.algorithm ?? "MD5"}`,
  ];
  if (qops.length > 0) {
    if (!qops.includes("auth")) throw new CameraApiError("AUTH_FAILED", "Camera requires unsupported digest qop");
    const response = H(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    parts.push(`qop=auth`, `nc=${nc}`, `cnonce=${quote(cnonce)}`, `response=${quote(response)}`);
  } else {
    parts.push(`response=${quote(H(`${ha1}:${nonce}:${ha2}`))}`);
  }
  if (ch.opaque !== undefined) parts.push(`opaque=${quote(ch.opaque)}`);
  return `Digest ${parts.join(", ")}`;
}
