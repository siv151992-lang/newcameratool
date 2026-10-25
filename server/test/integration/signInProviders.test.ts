import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { PROVIDER_ENDPOINTS, ZOHO_ACCOUNT_SERVERS } from "../../src/auth/oauth.js";
import { pool } from "../../src/db/pool.js";
import { setMailSender } from "../../src/notifications/mailer.js";
import { updateEmailSettings } from "../../src/services/emailSettings.js";
import { invite } from "../../src/services/invitationService.js";
import { updateProviderSettings } from "../../src/services/providerSettings.js";
import { MockOidcProvider, type MockUser } from "../mockOidcProvider.js";
import { createTestOrg, createTestUser, PASSWORD, prepareDb, resetData, testOrgId } from "../helpers.js";

const app = createApp();
const google = new MockOidcProvider();
const zoho = new MockOidcProvider();
const original = structuredClone(PROVIDER_ENDPOINTS);
const mail: { to: string; text: string }[] = [];

/** Runs the whole redirect dance in one browser (cookie jar) and returns it with the final page. */
async function signInWith(
  provider: "google" | "zoho",
  user: MockUser,
  opts: { agent?: ReturnType<typeof request.agent>; query?: string; tamper?: (q: URLSearchParams) => void } = {},
) {
  const agent = opts.agent ?? request.agent(app);
  const start = await agent.get(`/api/auth/oauth/${provider}/start${opts.query ?? ""}`);
  expect(start.status).toBe(302);
  const mock = provider === "google" ? google : zoho;
  const { code, state } = mock.authorize(start.headers.location!, user);
  const q = new URLSearchParams({ code, state });
  if (provider === "zoho") q.set("accounts-server", zoho.url);
  opts.tamper?.(q);
  const callback = await agent.get(`/api/auth/oauth/${provider}/callback?${q}`);
  expect(callback.status).toBe(200);
  const next = decodeURIComponent(callback.text.match(/url=([^"]+)"/)![1]!.replace(/&amp;/g, "&"));
  return { agent, next, start };
}

const alice: MockUser = { sub: "g-alice", email: "alice@example.com", name: "Alice Smith" };

beforeAll(async () => {
  await prepareDb();
  await google.start();
  await zoho.start();
  Object.assign(PROVIDER_ENDPOINTS.google, { authorize: `${google.url}/authorize`, token: `${google.url}/token`, jwks: `${google.url}/keys`, issuers: [google.url] });
  Object.assign(PROVIDER_ENDPOINTS.zoho, { authorize: `${zoho.url}/oauth/v2/auth` });
  ZOHO_ACCOUNT_SERVERS.push(zoho.url);
  setMailSender(async (m) => void mail.push(m));
});
afterAll(async () => {
  Object.assign(PROVIDER_ENDPOINTS.google, original.google);
  Object.assign(PROVIDER_ENDPOINTS.zoho, original.zoho);
  ZOHO_ACCOUNT_SERVERS.pop();
  setMailSender(undefined);
  await google.stop();
  await zoho.stop();
});
beforeEach(async () => {
  await resetData();
  google.forge = {};
  zoho.forge = {};
  await updateEmailSettings({ publicUrl: "https://cctv.example.com", allowSignup: true }, null);
  await updateProviderSettings(
    { google: { clientId: google.clientId, clientSecret: google.clientSecret }, zoho: { clientId: zoho.clientId, clientSecret: zoho.clientSecret } },
    null,
  );
  await createTestUser("admin", "boss");
});

describe("sign in with Google and Zoho", () => {
  it("offers only providers that are set up, and sends people there with PKCE, state and nonce", async () => {
    expect((await request(app).get("/api/auth/options")).body.providers).toEqual(["google", "zoho"]);
    const { start } = await signInWith("google", alice);
    const q = new URL(start.headers.location!).searchParams;
    expect(q.get("redirect_uri")).toBe("https://cctv.example.com/api/auth/oauth/google/callback");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")).toMatch(/^[\w-]{43}$/);
    expect(q.get("nonce")).toBeTruthy();
    expect(start.headers["set-cookie"]![0]).toMatch(/cctv_oauth_state=.*HttpOnly.*SameSite=Lax/i);

    await updateProviderSettings({ zoho: { enabled: false } }, null);
    expect((await request(app).get("/api/auth/options")).body.providers).toEqual(["google"]);
    expect((await request(app).get("/api/auth/oauth/zoho/start")).status).toBe(404);
  });

  it("creates an account with the confirmed address, without a password, in no organization until invited", async () => {
    const { agent, next } = await signInWith("google", alice);
    expect(next).toBe("/");
    const me = (await agent.get("/api/auth/me").expect(200)).body;
    expect(me.user).toMatchObject({ username: "alice", displayName: "Alice Smith", email: "alice@example.com", organizationId: null });
    const row = (await pool.query("SELECT password_hash, email_verified_at FROM users WHERE username = 'alice'")).rows[0];
    expect(row.password_hash).toBeNull();
    expect(row.email_verified_at).not.toBeNull();
    // The same Google account signs in to the same user next time, even after its address changes.
    const again = await signInWith("google", { ...alice, email: "alice.smith@example.com" });
    expect((await again.agent.get("/api/auth/me")).body.user.username).toBe("alice");
  });

  it("signs in to the existing account with that address and links it", async () => {
    await pool.query("UPDATE users SET email = 'alice@example.com', email_verified_at = now() WHERE username = 'boss'");
    const { agent } = await signInWith("google", alice);
    expect((await agent.get("/api/auth/me")).body.user).toMatchObject({ username: "boss", organizationId: testOrgId, role: "admin" });
    expect((await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(1);
  });

  it("joins the organization from an invitation link", async () => {
    const bossActor = { id: (await pool.query("SELECT id FROM users WHERE username = 'boss'")).rows[0].id, username: "boss" };
    const sent = await invite(testOrgId, { email: "alice@example.com", role: "operator" }, bossActor);
    const token = sent.link.split("/").pop()!;
    const { agent } = await signInWith("zoho", { ...alice, sub: "z-alice" }, { query: `?invitation=${token}` });
    expect((await agent.get("/api/auth/me")).body.user).toMatchObject({ organizationId: testOrgId, role: "operator" });
    expect((await pool.query("SELECT accepted_at FROM invitations")).rows[0].accepted_at).not.toBeNull();
  });

  it("refuses new accounts when creating accounts is off, unless the address was invited", async () => {
    await updateEmailSettings({ allowSignup: false }, null);
    const refused = await signInWith("google", alice);
    expect(refused.next).toMatch(/^\/\?signin_error=There is no account for alice@example.com/);
    expect((await refused.agent.get("/api/auth/me")).status).toBe(401);

    const bossActor = { id: (await pool.query("SELECT id FROM users WHERE username = 'boss'")).rows[0].id, username: "boss" };
    await invite(testOrgId, { email: "alice@example.com", role: "viewer" }, bossActor);
    const { agent } = await signInWith("google", alice);
    // Signed in, and the invitation waits in the app.
    expect((await agent.get("/api/auth/me")).body.invitations).toHaveLength(1);
  });

  it("makes the first account on a new installation the system administrator", async () => {
    // A new installation (settings were saved by nobody: TRUNCATE users also empties them).
    await pool.query("TRUNCATE users, organizations CASCADE");
    await updateEmailSettings({ publicUrl: "https://cctv.example.com" }, null);
    await updateProviderSettings({ zoho: { clientId: zoho.clientId, clientSecret: zoho.clientSecret } }, null);
    const { agent } = await signInWith("zoho", { sub: "z-owner", email: "owner@example.in", name: "Owner" });
    expect((await agent.get("/api/auth/me")).body.user).toMatchObject({ isSystemAdmin: true, role: "admin", organizationName: "My organization" });
  });

  it("accepts Zoho accounts from known data centres only", async () => {
    const res = await signInWith("zoho", alice, { tamper: (q) => q.set("accounts-server", "https://accounts.evil.example") });
    expect(res.next).toMatch(/signin_error=Zoho answered from an unknown data centre/);
  });

  it("rejects a callback from another browser, a replayed one, and forged or unconfirmed tokens", async () => {
    // State not bound to this browser.
    const a = request.agent(app);
    const start = await a.get("/api/auth/oauth/google/start");
    const { code, state } = google.authorize(start.headers.location!, alice);
    const other = await request(app).get(`/api/auth/oauth/google/callback?code=${code}&state=${state}`);
    expect(decodeURIComponent(other.text)).toMatch(/started in another browser/);
    // Replayed: the state is used once.
    await a.get(`/api/auth/oauth/google/callback?code=${code}&state=${state}`);
    const replay = await a.get(`/api/auth/oauth/google/callback?code=${code}&state=${state}`);
    expect(replay.text).toMatch(/signin_error/);

    for (const forge of [{ wrongKey: true }, { nonce: "other" }, { audience: "someone-else" }, { issuer: "https://evil.example" }]) {
      google.forge = forge;
      const r = await signInWith("google", { ...alice, sub: `g-${Object.keys(forge)[0]}` });
      expect(r.next).toMatch(/signin_error=The Google sign-in could not be verified/);
    }
    google.forge = {};
    const unverified = await signInWith("google", { ...alice, sub: "g-unverified", email_verified: false });
    expect(unverified.next).toMatch(/signin_error=Your Google account has no confirmed email address/);
    expect((await pool.query("SELECT count(*)::int AS n FROM user_identities")).rows[0].n).toBe(1);
  });

  it("connects and disconnects providers from Settings, keeping a way to sign in", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({ username: "boss", password: PASSWORD }).expect(200);
    await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", login.body.csrfToken).send({ password: PASSWORD }).expect(200);
    const linked = await signInWith("google", { sub: "g-boss", email: "boss@gmail.example" }, { agent, query: "?link=1" });
    expect(linked.next).toBe("/settings/account?connected=google");
    const ids = (await agent.get("/api/auth/identities")).body;
    expect(ids).toMatchObject({ hasPassword: true, identities: [{ provider: "google", email: "boss@gmail.example" }] });

    // The Google account now signs in as boss.
    const viaGoogle = await signInWith("google", { sub: "g-boss", email: "boss@gmail.example" });
    expect((await viaGoogle.agent.get("/api/auth/me")).body.user.username).toBe("boss");

    // Someone else's account cannot take it over.
    await createTestUser("viewer", "eve", await createTestOrg("Elsewhere"));
    const eve = request.agent(app);
    await eve.post("/api/auth/login").send({ username: "eve", password: PASSWORD }).expect(200);
    expect((await signInWith("google", { sub: "g-boss", email: "boss@gmail.example" }, { agent: eve, query: "?link=1" })).next).toMatch(/already connected to another user/);

    await agent.delete("/api/auth/identities/google").set("X-CSRF-Token", login.body.csrfToken).expect(204);
    // A Google-only account keeps its last way in.
    const only = await signInWith("google", alice);
    const csrf = (await only.agent.get("/api/auth/me")).body.csrfToken;
    expect((await only.agent.delete("/api/auth/identities/google").set("X-CSRF-Token", csrf)).body.error.code).toBe("LAST_SIGN_IN_METHOD");
    // It can set a password without knowing one.
    await only.agent.post("/api/auth/password").set("X-CSRF-Token", csrf).send({ currentPassword: "-", newPassword: "Fresh-Password-12" }).expect(204);
    await only.agent.delete("/api/auth/identities/google").set("X-CSRF-Token", csrf).expect(204);

    const actions = (await pool.query("SELECT action FROM audit_logs WHERE action LIKE 'auth.identity%' ORDER BY id")).rows.map((r) => r.action);
    expect(actions).toEqual(["auth.identity_linked", "auth.identity_unlinked", "auth.identity_unlinked"]);
  });

  it("keeps client secrets out of the settings answers, for the system administrator only", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({ username: "boss", password: PASSWORD }).expect(200);
    await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", login.body.csrfToken).send({ password: PASSWORD }).expect(200);
    await agent.get("/api/settings/sign-in-providers").expect(403);
    await pool.query("UPDATE users SET is_system_admin = true WHERE username = 'boss'");
    const view = (await agent.get("/api/settings/sign-in-providers").expect(200)).body;
    expect(view).toMatchObject({
      providers: { google: { clientId: google.clientId, clientSecretSet: true, enabled: true } },
      redirectUris: { zoho: "https://cctv.example.com/api/auth/oauth/zoho/callback" },
    });
    expect(JSON.stringify(view)).not.toContain(google.clientSecret);
    await agent.patch("/api/settings/sign-in-providers").set("X-CSRF-Token", login.body.csrfToken).send({ google: { clientSecret: "" } }).expect(200);
    expect((await request(app).get("/api/auth/options")).body.providers).toEqual(["zoho"]);
  });
});
