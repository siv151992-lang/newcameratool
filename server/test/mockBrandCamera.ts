import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { passwordDigest } from "../src/integrations/onvif/soap.js";

/**
 * A scriptable camera for adapter tests: answers fixed routes behind HTTP Digest authentication,
 * or (for ONVIF) checks the WS-Security UsernameToken inside the SOAP body instead.
 */

export interface MockReply {
  status?: number;
  body: string;
  contentType?: string;
}

export interface MockRequest {
  method: string;
  path: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

type Route = (req: MockRequest) => MockReply;

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

export class MockBrandCamera {
  routes = new Map<string, Route>();
  requests: MockRequest[] = [];
  /** "digest": HTTP Digest on every request; "ws-security": token in the SOAP body is checked by the route. */
  auth: "digest" | "ws-security" = "digest";
  private server?: http.Server;
  private readonly nonces = new Set<string>();
  private readonly realm = "Mock Camera";

  constructor(public username = "admin", public password = "S3cret-pass") {}

  route(path: string, reply: MockReply | Route) {
    this.routes.set(path, typeof reply === "function" ? reply : () => reply);
    return this;
  }

  private verifyDigest(header: string | undefined, method: string): boolean {
    if (!header?.startsWith("Digest ")) return false;
    const p: Record<string, string> = {};
    for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1]!] = m[2] ?? m[3]!;
    if (!p.nonce || !this.nonces.has(p.nonce) || p.username !== this.username) return false;
    const ha1 = md5(`${this.username}:${this.realm}:${this.password}`);
    const ha2 = md5(`${method}:${p.uri}`);
    return md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) === p.response;
  }

  /**
   * Checks a WS-Security UsernameToken against this camera's credentials and clock.
   * `deviceNow` is the camera's idea of the current time; tokens more than 5 s away are refused.
   */
  verifyToken(body: string, deviceNow = Date.now()): boolean {
    const get = (tag: string) => new RegExp(`<wsse:${tag}[^>]*>([^<]*)</wsse:${tag}>`).exec(body)?.[1];
    const created = /<wsu:Created>([^<]*)<\/wsu:Created>/.exec(body)?.[1];
    const username = get("Username");
    const digest = get("Password");
    const nonce = get("Nonce");
    if (!created || !username || !digest || !nonce || username !== this.username) return false;
    if (Math.abs(Date.parse(created) - deviceNow) > 5000) return false;
    return passwordDigest(Buffer.from(nonce, "base64"), created, this.password) === digest;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string) {
    const path = req.url ?? "/";
    const method = req.method ?? "GET";
    this.requests.push({ method, path, body, headers: req.headers });
    if (this.auth === "digest" && !this.verifyDigest(req.headers.authorization, method)) {
      const nonce = randomBytes(16).toString("hex");
      this.nonces.add(nonce);
      res.setHeader("WWW-Authenticate", `Digest qop="auth", realm="${this.realm}", nonce="${nonce}"`);
      res.statusCode = 401;
      return res.end("Unauthorized");
    }
    const route = this.routes.get(path);
    if (!route) {
      res.statusCode = 404;
      return res.end("Not Found");
    }
    const reply = route({ method, path, body, headers: req.headers });
    res.statusCode = reply.status ?? 200;
    res.setHeader("Content-Type", reply.contentType ?? "text/plain");
    res.end(reply.body);
  }

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => this.handle(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
