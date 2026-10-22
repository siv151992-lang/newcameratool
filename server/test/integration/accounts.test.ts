import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { type MailMessage, setMailSender } from "../../src/notifications/mailer.js";
import { createTestOrg, createTestUser, PASSWORD, prepareDb, resetData, testOrgId } from "../helpers.js";

const app = createApp();
let mail: MailMessage[] = [];

const linkIn = (m: MailMessage | undefined, path: string) => {
  const match = m?.text.match(new RegExp(`${path}[?/](?:token=)?([A-Za-z0-9_-]{43})`));
  if (!match) throw new Error(`No ${path} link in: ${m?.text}`);
  return match[1]!;
};
const lastMailTo = (to: string) => mail.filter((m) => m.to === to).at(-1);

function client() {
  const agent = request.agent(app);
  let csrf = "";
  const remember = (res: request.Response) => {
    if (res.body?.csrfToken) csrf = res.body.csrfToken;
    return res;
  };
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => agent.post(url).set("X-CSRF-Token", csrf).send(body).then(remember),
    login: (username: string, password = PASSWORD) => agent.post("/api/auth/login").send({ username, password }).then(remember),
  };
}

async function signedIn(username: string) {
  const c = client();
  await c.login(username).then((r) => expect(r.status).toBe(200));
  return c;
}

const account = (over: Record<string, unknown> = {}) => ({ username: "newbie", displayName: "New Person", email: "new@example.com", password: "Brand-New-Pass-1", ...over });

beforeAll(async () => {
  await prepareDb();
  setMailSender(async (m) => void mail.push(m));
});
afterAll(() => setMailSender(undefined));
beforeEach(async () => {
  await resetData();
  mail = [];
});

describe("first-time setup", () => {
  it("makes the first account the system administrator, with the first organization", async () => {
    await pool.query("TRUNCATE organizations CASCADE");
    const c = client();
    expect((await c.get("/api/auth/options")).body).toMatchObject({ needsSetup: true, signupEnabled: true });
    const res = await c.post("/api/auth/signup", account({ username: "owner", email: "owner@example.com" }));
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ username: "owner", isSystemAdmin: true, role: "admin", organizationName: "My organization" });
    await c.get("/api/cameras").expect(200);
    expect((await c.get("/api/auth/options")).body.needsSetup).toBe(false);
  });
});

describe("creating an account", () => {
  beforeEach(() => createTestUser("admin", "alice"));

  it("needs the email address confirmed before signing in, and then has no organization until invited", async () => {
    const c = client();
    expect((await c.post("/api/auth/signup", account())).status).toBe(202);
    expect((await c.login("newbie", "Brand-New-Pass-1")).body.error.code).toBe("EMAIL_NOT_VERIFIED");
    // A wrong password does not reveal that the account is waiting for confirmation.
    expect((await c.login("new@example.com", "wrong-password-1")).body.error.code).toBe("INVALID_CREDENTIALS");

    const token = linkIn(lastMailTo("new@example.com"), "/verify-email");
    const verified = await c.post("/api/auth/verify-email", { token });
    expect(verified.status).toBe(200);
    const me = (await c.get("/api/auth/me").expect(200)).body;
    expect(me).toMatchObject({ user: { username: "newbie", organizationId: null, permissions: [] }, organizations: [], invitations: [] });
    await c.get("/api/cameras").expect(403);
    // Links work once.
    expect((await client().post("/api/auth/verify-email", { token })).body.error.code).toBe("LINK_INVALID");
    expect((await client().login("new@example.com", "Brand-New-Pass-1")).status).toBe(200);
  });

  it("answers the same when the address already has an account, and tells its owner by email", async () => {
    await pool.query("UPDATE users SET email = 'alice@example.com', email_verified_at = now() WHERE username = 'alice'");
    const res = await client().post("/api/auth/signup", account({ email: "Alice@Example.com" }));
    expect(res.status).toBe(202);
    expect((await pool.query("SELECT 1 FROM users WHERE username = 'newbie'")).rowCount).toBe(0);
    expect(lastMailTo("alice@example.com")?.subject).toMatch(/already|tried/i);
    expect((await client().post("/api/auth/signup", account({ email: "other@example.com", username: "alice" }))).status).toBe(409);
  });

  it("validates input and is unavailable without email on the server", async () => {
    const bad = await client().post("/api/auth/signup", account({ email: "not-an-email", password: "short" }));
    expect(bad.status).toBe(400);
    setMailSender(undefined);
    try {
      expect((await client().get("/api/auth/options")).body).toMatchObject({ signupEnabled: false, passwordResetEnabled: false });
      expect((await client().post("/api/auth/signup", account())).body.error.code).toBe("EMAIL_UNAVAILABLE");
    } finally {
      setMailSender(async (m) => void mail.push(m));
    }
  });
});

describe("invitations", () => {
  let alice: Awaited<ReturnType<typeof signedIn>>;
  beforeEach(async () => {
    await createTestUser("admin", "alice");
    alice = await signedIn("alice");
  });
  const inviteLink = (to: string) => linkIn(lastMailTo(to), "/invite");

  it("adds someone only when they accept, with an account created for the invited address", async () => {
    const sent = await alice.post("/api/invitations", { email: "Ravi@Example.com", role: "operator" });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ outcome: "created", emailSent: true, link: expect.stringMatching(/^\/invite\//) });
    const token = inviteLink("ravi@example.com");
    expect(lastMailTo("ravi@example.com")!.text).toMatch(/Test organization as Operator[\s\S]*expires in 72 hours/);

    // Not a member yet.
    expect((await alice.get("/api/users")).body.map((u: { username: string }) => u.username)).toEqual(["alice"]);
    const preview = (await client().get(`/api/auth/invitations/${token}`).expect(200)).body;
    expect(preview).toMatchObject({ organizationName: "Test organization", role: "operator", email: "ravi@example.com", status: "pending", accountExists: false });

    const ravi = client();
    const wrong = await ravi.post("/api/auth/signup", account({ username: "ravi", email: "someone@example.com", invitationToken: token }));
    expect(wrong.body.error.code).toBe("EMAIL_MISMATCH");
    const joined = await ravi.post("/api/auth/signup", account({ username: "ravi", email: "ravi@example.com", invitationToken: token }));
    expect(joined.status).toBe(201);
    expect(joined.body.user).toMatchObject({ username: "ravi", role: "operator", organizationId: testOrgId });
    await ravi.get("/api/cameras").expect(200);

    // Used once only; the organization now lists them.
    expect((await client().post("/api/auth/signup", account({ username: "ravi2", email: "ravi@example.com", invitationToken: token }))).body.error.code).toBe("INVITATION_ACCEPTED");
    expect((await alice.get("/api/users")).body.map((u: { username: string }) => u.username)).toEqual(["alice", "ravi"]);
    expect((await alice.get("/api/invitations")).body[0]).toMatchObject({ status: "accepted", acceptedBy: "ravi" });
    const actions = (await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'invitation' ORDER BY id")).rows.map((r) => r.action);
    expect(actions).toEqual(["invitation.created", "invitation.accepted"]);
  });

  it("re-sends instead of duplicating, and the older link stops working", async () => {
    await alice.post("/api/invitations", { email: "ravi@example.com", role: "viewer" });
    const first = inviteLink("ravi@example.com");
    const again = await alice.post("/api/invitations", { email: "ravi@example.com", role: "operator" });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe("resent");
    const second = inviteLink("ravi@example.com");
    expect(second).not.toBe(first);
    await client().get(`/api/auth/invitations/${first}`).expect(404);
    expect((await client().get(`/api/auth/invitations/${second}`)).body).toMatchObject({ role: "operator", status: "pending" });
    expect((await alice.get("/api/invitations")).body).toHaveLength(1);
  });

  it("refuses to invite an existing member", async () => {
    await pool.query("UPDATE users SET email = 'alice@example.com' WHERE username = 'alice'");
    expect((await alice.post("/api/invitations", { email: "alice@example.com", role: "viewer" })).body.error.code).toBe("ALREADY_MEMBER");
  });

  it("does not accept revoked or expired invitations; expired ones can be sent again", async () => {
    const r = await alice.post("/api/invitations", { email: "ravi@example.com", role: "viewer" });
    const token = inviteLink("ravi@example.com");
    await alice.post(`/api/invitations/${r.body.id}/revoke`).then((x) => expect(x.status).toBe(204));
    expect((await client().get(`/api/auth/invitations/${token}`)).body.status).toBe("revoked");
    expect((await client().post("/api/auth/signup", account({ email: "ravi@example.com", invitationToken: token }))).body.error.code).toBe("INVITATION_REVOKED");
    expect((await alice.post(`/api/invitations/${r.body.id}/resend`)).body.error.code).toBe("INVITATION_REVOKED");

    const e = await alice.post("/api/invitations", { email: "sam@example.com", role: "viewer" });
    const expired = inviteLink("sam@example.com");
    await pool.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [e.body.id]);
    expect((await client().post("/api/auth/signup", account({ username: "sam", email: "sam@example.com", invitationToken: expired }))).body.error.code).toBe("INVITATION_EXPIRED");
    await alice.post(`/api/invitations/${e.body.id}/resend`).then((x) => expect(x.status).toBe(200));
    const fresh = inviteLink("sam@example.com");
    expect((await client().post("/api/auth/signup", account({ username: "sam", email: "sam@example.com", invitationToken: fresh }))).status).toBe(201);
  });

  it("lets an existing account join another organization, and refuses a different signed-in address", async () => {
    // A username-only account (as before organizations) takes the invited address when it accepts.
    const bob = await createTestUser("admin", "bob", await createTestOrg("Other organization"));
    await alice.post("/api/invitations", { email: "bob@example.com", role: "viewer" });
    const token = inviteLink("bob@example.com");
    const b = await signedIn("bob");
    const accepted = await b.post("/api/auth/invitations/accept", { token });
    expect(accepted.status).toBe(200);
    const me = (await b.get("/api/auth/me")).body;
    expect(me.user).toMatchObject({ organizationId: testOrgId, role: "viewer", email: "bob@example.com" });
    expect(me.organizations).toHaveLength(2);
    expect((await pool.query("SELECT email_verified_at IS NOT NULL AS v FROM users WHERE id = $1", [bob.id])).rows[0].v).toBe(true);

    // Someone signed in with another address cannot use it.
    await alice.post("/api/invitations", { email: "carol@example.com", role: "viewer" });
    const carolToken = inviteLink("carol@example.com");
    expect((await b.post("/api/auth/invitations/accept", { token: carolToken })).body.error.code).toBe("EMAIL_MISMATCH");
  });

  it("lists open invitations to a confirmed address in the app, to accept without the link", async () => {
    await alice.post("/api/invitations", { email: "new@example.com", role: "operator" });
    const c = client();
    await c.post("/api/auth/signup", account());
    // Not confirmed yet: cannot sign in, so nothing to list.
    await c.post("/api/auth/verify-email", { token: linkIn(lastMailTo("new@example.com"), "/verify-email") });
    const me = (await c.get("/api/auth/me")).body;
    expect(me.invitations).toEqual([expect.objectContaining({ organizationName: "Test organization", role: "operator" })]);
    expect((await c.post("/api/auth/invitations/accept", { id: me.invitations[0].id })).status).toBe(200);
    expect((await c.get("/api/auth/me")).body.user).toMatchObject({ organizationId: testOrgId, role: "operator" });
  });

  it("keeps invitations within their organization and Org Admins", async () => {
    const r = await alice.post("/api/invitations", { email: "ravi@example.com", role: "viewer" });
    await createTestUser("admin", "bob", await createTestOrg("Other organization"));
    const bob = await signedIn("bob");
    expect((await bob.get("/api/invitations")).body).toEqual([]);
    expect((await bob.post(`/api/invitations/${r.body.id}/revoke`)).status).toBe(404);
    expect((await bob.post(`/api/invitations/${r.body.id}/resend`)).status).toBe(404);

    await createTestUser("operator", "olga");
    const olga = await signedIn("olga");
    expect((await olga.post("/api/invitations", { email: "x@example.com", role: "admin" })).status).toBe(403);
    // Members are no longer created directly.
    expect((await alice.post("/api/users", { username: "direct", password: "Direct-Pass-123", role: "viewer" })).status).toBe(404);
  });
});

describe("password reset", () => {
  it("emails a single-use link that sets a new password and signs out other sessions", async () => {
    await createTestUser("admin", "alice");
    await pool.query("UPDATE users SET email = 'alice@example.com', email_verified_at = now() WHERE username = 'alice'");
    const old = await signedIn("alice");

    expect((await client().post("/api/auth/forgot-password", { email: "nobody@example.com" })).status).toBe(202);
    expect(mail).toHaveLength(0);
    expect((await client().post("/api/auth/forgot-password", { email: "ALICE@example.com" })).status).toBe(202);
    const token = linkIn(lastMailTo("alice@example.com"), "/reset-password");

    expect((await client().post("/api/auth/reset-password", { token, password: "short" })).status).toBe(400);
    expect((await client().post("/api/auth/reset-password", { token, password: "A-Whole-New-Pass-9" })).status).toBe(204);
    expect((await client().post("/api/auth/reset-password", { token, password: "Another-New-Pass-9" })).body.error.code).toBe("LINK_INVALID");
    await old.get("/api/auth/me").expect(401);
    expect((await client().login("alice", "A-Whole-New-Pass-9")).status).toBe(200);
  });
});
