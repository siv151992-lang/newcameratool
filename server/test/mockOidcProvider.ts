import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

export interface MockUser {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
}

/**
 * A simulated OpenID Connect provider (Google or a Zoho data centre): issues codes for a chosen
 * user, checks the PKCE verifier and client credentials at the token endpoint, and returns RS256 ID
 * tokens whose keys it publishes. Options let tests forge bad tokens.
 */
export class MockOidcProvider {
  private server?: Server;
  private key!: { privateKey: CryptoKey; publicKey: CryptoKey };
  private codes = new Map<string, { user: MockUser; nonce: string; challenge: string; clientId: string; redirectUri: string }>();
  url = "";
  clientId = "test-client-id";
  clientSecret = "test-client-secret";
  /** Forgeries for negative tests. */
  forge: { wrongKey?: boolean; nonce?: string; audience?: string; issuer?: string } = {};

  async start() {
    this.key = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(this.key.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    this.server = createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/keys" || path === "/oauth/v2/keys") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (path === "/token" || path === "/oauth/v2/token") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => void this.token(new URLSearchParams(body)).then(([status, json]) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(json));
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise((r) => this.server?.close(r));
  }

  /** What the provider does when the person signs in at the authorize URL: returns the code. */
  authorize(authorizeUrl: string, user: MockUser): { code: string; state: string } {
    const q = new URL(authorizeUrl).searchParams;
    if (q.get("client_id") !== this.clientId || q.get("code_challenge_method") !== "S256") throw new Error("bad authorize request");
    const code = randomBytes(16).toString("hex");
    this.codes.set(code, { user, nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, clientId: q.get("client_id")!, redirectUri: q.get("redirect_uri")! });
    return { code, state: q.get("state")! };
  }

  private async token(p: URLSearchParams): Promise<[number, object]> {
    const grant = this.codes.get(p.get("code") ?? "");
    if (!grant) return [400, { error: "invalid_grant" }];
    this.codes.delete(p.get("code")!);
    const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
    if (challenge !== grant.challenge) return [400, { error: "invalid_grant", error_description: "PKCE" }];
    if (p.get("client_id") !== this.clientId || p.get("client_secret") !== this.clientSecret) return [401, { error: "invalid_client" }];
    if (p.get("redirect_uri") !== grant.redirectUri) return [400, { error: "redirect_uri_mismatch" }];
    const signer = this.forge.wrongKey ? (await generateKeyPair("RS256")).privateKey : this.key.privateKey;
    const idToken = await new SignJWT({
      email: grant.user.email,
      email_verified: grant.user.email_verified ?? true,
      name: grant.user.name,
      nonce: this.forge.nonce ?? grant.nonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject(grant.user.sub)
      .setIssuer(this.forge.issuer ?? this.url)
      .setAudience(this.forge.audience ?? grant.clientId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signer);
    return [200, { access_token: "at", token_type: "Bearer", id_token: idToken }];
  }
}
