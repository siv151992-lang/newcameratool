import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPackage, cleanUpdateFixtures, keyPair, tmp, zipFolder } from "../updateFixtures.js";

// The release key of these tests (the app's real one stays with the release workflow).
const release = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "der" }).toString("base64"), pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
});
vi.mock("../../src/update/trustedKeys.js", () => ({ UPDATE_PUBLIC_KEYS: [release.pub] }));

const { createApp } = await import("../../src/app.js");
const { config } = await import("../../src/config.js");
const { pool } = await import("../../src/db/pool.js");
const { createTestUser, PASSWORD, prepareDb, resetData } = await import("../helpers.js");
const { updatesFolder } = await import("../../src/services/updateService.js");
const installed = (await import("../../src/services/backupService.js")).appVersion();

const app = createApp();
const saved = { file: config.CREDENTIAL_KEY_FILE, pkg: config.CCTV_PACKAGE };
let releaseKeyFile: string;

async function signIn(systemAdmin = true) {
  const { username } = await createTestUser("admin", systemAdmin ? "sysadmin" : "orgadmin", undefined, { systemAdmin });
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  const csrf = res.body.csrfToken as string;
  await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", csrf).send({ password: PASSWORD }).expect(200);
  return { agent, csrf };
}

/** GitHub, as the update check and download see it. */
function fakeGitHub(opts: { tag?: string; zip?: Buffer; status?: number; repo?: string }) {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === `https://api.github.com/repos/${opts.repo ?? "acme/cctv"}/releases/latest`) {
      if (opts.status) return new Response("{}", { status: opts.status });
      return Response.json({
        tag_name: opts.tag ?? "v1.2.0", name: "CCTV Monitor v1.2.0", body: "## What's new\n- Faster <b>checks</b>", published_at: "2026-11-18T10:00:00Z",
        html_url: "https://github.com/acme/cctv/releases/tag/v1.2.0",
        assets: [
          { name: "cctv-monitor-windows.zip", size: opts.zip?.length ?? 1000, url: "https://api.github.com/repos/acme/cctv/releases/assets/7", digest: null },
          { name: "cctv-monitor.zip", size: 10, url: "https://api.github.com/repos/acme/cctv/releases/assets/8" },
        ],
      });
    }
    if (url === "https://api.github.com/repos/acme/cctv/releases/assets/7") {
      expect(headers.get("accept")).toBe("application/octet-stream");
      return new Response(null, { status: 302, headers: { location: "https://objects.example.com/zip?sig=1" } });
    }
    if (url === "https://objects.example.com/zip?sig=1") {
      // The token is never sent to the file storage the download is redirected to.
      expect(headers.get("authorization")).toBeNull();
      return new Response(new Uint8Array(opts.zip!), { status: 200 });
    }
    return real(input, init);
  });
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

beforeAll(async () => {
  await prepareDb();
  releaseKeyFile = join(tmp, "release.pem");
  (await import("node:fs")).writeFileSync(releaseKeyFile, release.pem);
});
afterAll(() => {
  config.CREDENTIAL_KEY_FILE = saved.file;
  config.CCTV_PACKAGE = saved.pkg;
  cleanUpdateFixtures();
});
beforeEach(async () => {
  await resetData();
  await pool.query("DELETE FROM app_settings WHERE key IN ('updates', 'update_check')");
  config.CREDENTIAL_KEY_FILE = join(tmp, `data-${Date.now()}`, "credential.key");
  config.CCTV_PACKAGE = "windows";
});
afterEach(() => vi.restoreAllMocks());

describe("Settings > Updates", () => {
  it("keeps the source settings; the token is write-only and stored encrypted", async () => {
    const { agent, csrf } = await signIn();
    await agent.patch("/api/settings/updates").set("X-CSRF-Token", csrf).send({ repository: "not a repo" }).expect(400);
    const r = await agent.patch("/api/settings/updates").set("X-CSRF-Token", csrf).send({ repository: "https://github.com/acme/cctv", token: "github_pat_SECRET123" }).expect(200);
    expect(r.body.settings).toEqual({ repository: "acme/cctv", hasToken: true, autoCheck: true });
    expect(JSON.stringify(r.body)).not.toContain("SECRET123");
    const stored = (await pool.query("SELECT value FROM app_settings WHERE key = 'updates'")).rows[0].value;
    expect(JSON.stringify(stored)).not.toContain("SECRET123");
    const audit = (await pool.query("SELECT details FROM audit_logs WHERE action = 'settings.updates_updated'")).rows[0].details;
    expect(audit.token).toBe("set");
  });

  it("finds a new release, downloads and checks it, then asks the Windows updater to install it", async () => {
    const zip = readFileSync(await zipFolder(buildPackage(releaseKeyFile, "1.2.0")));
    const { agent, csrf } = await signIn();
    await agent.patch("/api/settings/updates").set("X-CSRF-Token", csrf).send({ repository: "acme/cctv", token: "github_pat_x" }).expect(200);
    const gh = fakeGitHub({ zip });

    const checked = await agent.post("/api/settings/updates/check").set("X-CSRF-Token", csrf).expect(200);
    expect(checked.body.latest).toMatchObject({ version: "1.2.0", newer: true, notes: expect.stringContaining("<b>checks</b>"), hasDocker: true });
    expect(gh.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: "Bearer github_pat_x" });

    await agent.post("/api/settings/updates/download").set("X-CSRF-Token", csrf).expect(202);
    const ready = await waitFor(() => agent.get("/api/settings/updates").then((r) => r.body), (b) => b.ready.length > 0 || b.download?.state === "failed");
    expect(ready.download).toBeNull();
    expect(ready.ready).toEqual([expect.objectContaining({ version: "1.2.0", source: "download" })]);

    const inst = await agent.post("/api/settings/updates/install").set("X-CSRF-Token", csrf).send({ version: "1.2.0" }).expect(202);
    expect(inst.body.install).toMatchObject({ state: "requested", version: "1.2.0", fromVersion: installed });
    const req = JSON.parse(readFileSync(join(updatesFolder(), "install.request.json"), "utf8"));
    expect(req).toMatchObject({ version: "1.2.0", fromVersion: installed });
    expect(existsSync(req.zip)).toBe(true);
    await agent.post("/api/settings/updates/install").set("X-CSRF-Token", csrf).send({ version: "1.2.0" }).expect(409);
    await agent.delete("/api/settings/updates/install").set("X-CSRF-Token", csrf).expect(200);
    expect(existsSync(join(updatesFolder(), "install.request.json"))).toBe(false);
    const actions = (await pool.query("SELECT action FROM audit_logs WHERE action LIKE 'update.%' ORDER BY created_at")).rows.map((r) => r.action);
    expect(actions).toEqual(["update.download_started", "update.install_requested", "update.install_cancelled"]);
  });

  it("refuses a downloaded package that is not signed by the release key", async () => {
    const other = keyPair();
    const zip = readFileSync(await zipFolder(buildPackage(other.keyFile, "1.3.0")));
    const { agent, csrf } = await signIn();
    await agent.patch("/api/settings/updates").set("X-CSRF-Token", csrf).send({ repository: "acme/cctv" }).expect(200);
    fakeGitHub({ zip, tag: "v1.3.0" });
    await agent.post("/api/settings/updates/check").set("X-CSRF-Token", csrf).expect(200);
    await agent.post("/api/settings/updates/download").set("X-CSRF-Token", csrf).expect(202);
    const b = await waitFor(() => agent.get("/api/settings/updates").then((r) => r.body), (x) => x.download?.state === "failed" || x.ready.length > 0);
    expect(b.download.error).toMatch(/not signed by the CCTV Monitor release key/);
    expect(b.ready).toEqual([]);
  });

  it("explains GitHub problems instead of failing", async () => {
    const { agent, csrf } = await signIn();
    await agent.post("/api/settings/updates/check").set("X-CSRF-Token", csrf).expect(400);
    await agent.patch("/api/settings/updates").set("X-CSRF-Token", csrf).send({ repository: "acme/cctv" }).expect(200);
    fakeGitHub({ status: 404 });
    const r = await agent.post("/api/settings/updates/check").set("X-CSRF-Token", csrf).expect(200);
    expect(r.body.lastCheck).toMatchObject({ ok: false, error: expect.stringMatching(/private, add an access token/) });
  });

  it("takes a package uploaded from a PC: signed and newer only", async () => {
    const { agent, csrf } = await signIn();
    const good = readFileSync(await zipFolder(buildPackage(releaseKeyFile, "1.4.0")));
    const up = await agent.post("/api/settings/updates/upload").set("X-CSRF-Token", csrf).set("Content-Type", "application/zip").send(good).expect(201);
    expect(up.body.ready).toEqual([expect.objectContaining({ version: "1.4.0", source: "upload" })]);

    const old = readFileSync(await zipFolder(buildPackage(releaseKeyFile, "0.9.0")));
    const r = await agent.post("/api/settings/updates/upload").set("X-CSRF-Token", csrf).set("Content-Type", "application/zip").send(old).expect(409);
    expect(r.body.error.message).toMatch(/Only a newer version/);
    const notZip = await agent.post("/api/settings/updates/upload").set("X-CSRF-Token", csrf).set("Content-Type", "application/zip").send(Buffer.from("hello")).expect(422);
    expect(notZip.body.error.message).toMatch(/not a zip file/);
    await agent.post("/api/settings/updates/upload").set("X-CSRF-Token", csrf).set("Content-Type", "text/plain").send("x").expect(415);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'update.refused'")).rows[0].n).toBe(2);
  });

  it("does not install on Docker, and only the system administrator manages updates", async () => {
    const { agent, csrf } = await signIn();
    const good = readFileSync(await zipFolder(buildPackage(releaseKeyFile, "1.5.0")));
    await agent.post("/api/settings/updates/upload").set("X-CSRF-Token", csrf).set("Content-Type", "application/zip").send(good).expect(201);
    config.CCTV_PACKAGE = "docker";
    const r = await agent.post("/api/settings/updates/install").set("X-CSRF-Token", csrf).send({ version: "1.5.0" }).expect(409);
    expect(r.body.error.message).toMatch(/docker compose up -d --build/);

    const org = await signIn(false);
    await org.agent.get("/api/settings/updates").expect(403);
    await org.agent.post("/api/settings/updates/upload").set("X-CSRF-Token", org.csrf).set("Content-Type", "application/zip").send(good).expect(403);
  });
});
