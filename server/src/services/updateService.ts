import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { conflict, HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getCipher } from "../security/cipher.js";
import { checkPackage, compareVersions, MAX_PACKAGE_BYTES, UpdatePackageError } from "../update/packageFile.js";
import { appVersion } from "./backupService.js";

/**
 * Settings > Updates (system administrator). Finds new releases on GitHub (the repository set here,
 * with a read-only token for a private one), downloads the Windows package or takes one uploaded
 * from a PC, and checks it: signed by the release key, every file intact. Installing is done by the
 * "CCTV Monitor Updater" Windows task (service\apply-update.mjs, as SYSTEM), which this service only
 * asks to (data\updates\install.request.json); it checks the package again, backs up, swaps the files,
 * restarts the app and puts the previous version back if the new one does not start.
 */

export const WINDOWS_ASSET = "cctv-monitor-windows.zip";
export const DOCKER_ASSET = "cctv-monitor.zip";
export const updatesFolder = () => join(dirname(resolve(config.CREDENTIAL_KEY_FILE)), "updates");
const packagesFolder = () => join(updatesFolder(), "packages");
export const INSTALL_REQUEST = "install.request.json";
export const INSTALL_STATUS = "install.status.json";
const GITHUB = "https://api.github.com";
const REPO = /^[\w.-]+\/[\w.-]+$/;

// ------------------------------------------------------------------------------- settings

interface Stored {
  repository?: string | null;
  tokenEncrypted?: string | null;
  autoCheck?: boolean;
}

export const updateSettingsSchema = z
  .object({
    repository: z
      .string()
      .trim()
      .transform((v) => v.replace(/^https:\/\/github\.com\//i, "").replace(/\.git$|\/$/g, ""))
      .refine((v) => v === "" || REPO.test(v), "Enter the GitHub repository as owner/name, e.g. my-company/cctv-monitor")
      .transform((v) => v || null)
      .optional(),
    /** Write-only: omit to keep, empty to remove. */
    token: z.string().trim().max(400).optional(),
    autoCheck: z.boolean().optional(),
  })
  .strict();

async function readSetting<T>(key: string): Promise<T | undefined> {
  return (await pool.query<{ value: T }>("SELECT value FROM app_settings WHERE key = $1", [key])).rows[0]?.value;
}
async function writeSetting(key: string, value: unknown, userId: string | null) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId],
  );
}

async function settings() {
  const s = (await readSetting<Stored>("updates")) ?? {};
  let token: string | null = null;
  if (s.tokenEncrypted) {
    try {
      token = getCipher().decrypt(s.tokenEncrypted);
    } catch {
      token = null;
    }
  }
  return { repository: s.repository === undefined ? (config.UPDATE_REPOSITORY ?? null) : s.repository, token, autoCheck: s.autoCheck ?? true, stored: s };
}

export async function saveUpdateSettings(patch: z.infer<typeof updateSettingsSchema>, userId: string) {
  const { stored } = await settings();
  const next: Stored = { ...stored };
  if (patch.repository !== undefined) next.repository = patch.repository;
  if (patch.autoCheck !== undefined) next.autoCheck = patch.autoCheck;
  if (patch.token !== undefined) next.tokenEncrypted = patch.token ? getCipher().encrypt(patch.token) : null;
  await writeSetting("updates", next, userId);
  // Another repository: the last check no longer applies.
  if (patch.repository !== undefined && patch.repository !== stored.repository) await writeSetting("update_check", {}, userId);
}

// ------------------------------------------------------------------------------- checking

export interface ReleaseInfo {
  version: string;
  tag: string;
  name: string;
  notes: string;
  publishedAt: string | null;
  pageUrl: string;
  windows: { size: number; apiUrl: string; sha256: string | null } | null;
  hasDocker: boolean;
}
interface CheckResult {
  at?: string;
  ok?: boolean;
  error?: string;
  latest?: ReleaseInfo | null;
}

const releaseSchema = z.object({
  tag_name: z.string().max(100),
  name: z.string().max(300).nullable().optional(),
  body: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  html_url: z.string().url(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z.array(z.object({ name: z.string(), size: z.number(), url: z.string().url(), digest: z.string().nullable().optional() })).default([]),
});

function githubHeaders(token: string | null, accept = "application/vnd.github+json"): Record<string, string> {
  return { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cctv-monitor-updater", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function githubError(status: number, hasToken: boolean, repo: string): string {
  if (status === 401) return "GitHub refused the access token (wrong or expired). Enter a new one.";
  if (status === 403 || status === 429) return "GitHub refused the request or its limit was reached. Try again later" + (hasToken ? "." : ", or add an access token.");
  if (status === 404) return hasToken
    ? `No release found in ${repo}: check the repository name, that a release is published, and that the token can read it.`
    : `No release found in ${repo}. If the repository is private, add an access token that can read it.`;
  return `GitHub answered ${status}. Try again later.`;
}

export async function checkForUpdates(userId: string | null = null): Promise<CheckResult> {
  const s = await settings();
  if (!s.repository) throw new HttpError(400, "UPDATE_SOURCE_MISSING", "Enter the GitHub repository releases are published in first.");
  const at = new Date().toISOString();
  let result: CheckResult;
  try {
    const res = await fetch(`${GITHUB}/repos/${s.repository}/releases/latest`, { headers: githubHeaders(s.token), signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!res.ok) {
      result = { at, ok: false, error: githubError(res.status, Boolean(s.token), s.repository) };
    } else {
      const r = releaseSchema.parse(await res.json());
      const version = r.tag_name.replace(/^v/i, "");
      if (!/^\d{1,4}(\.\d{1,4}){1,3}$/.test(version)) {
        result = { at, ok: false, error: `The latest release's tag (${r.tag_name.slice(0, 40)}) is not a version such as v1.2.0.` };
      } else {
        const win = r.assets.find((a) => a.name === WINDOWS_ASSET);
        const digest = win?.digest?.startsWith("sha256:") ? win.digest.slice(7) : null;
        result = {
          at, ok: true,
          latest: {
            version, tag: r.tag_name, name: r.name ?? r.tag_name, notes: (r.body ?? "").slice(0, 20_000), publishedAt: r.published_at ?? null, pageUrl: r.html_url,
            windows: win ? { size: win.size, apiUrl: win.url, sha256: digest && /^[0-9a-f]{64}$/.test(digest) ? digest : null } : null,
            hasDocker: r.assets.some((a) => a.name === DOCKER_ASSET),
          },
        };
      }
    }
  } catch (err) {
    const e = err as Error;
    result = { at, ok: false, error: e.name === "TimeoutError" ? "GitHub did not answer in time. Check this server's internet access." : `Could not reach GitHub (${e.message.slice(0, 120)}). Check this server's internet access.` };
  }
  await writeSetting("update_check", result, userId);
  return result;
}

// ------------------------------------------------------------------------------- packages

interface PackageInfo {
  version: string;
  file: string;
  size: number;
  source: "download" | "upload";
  checkedAt: string;
}

function readPackages(): PackageInfo[] {
  const dir = packagesFolder();
  if (!existsSync(dir)) return [];
  const out: PackageInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir, f), "utf8")) as PackageInfo;
      if (existsSync(join(dir, p.file))) out.push(p);
    } catch {
      // Not ours.
    }
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/** Checks a received zip; keeps it as the ready package (only one is kept), or deletes it. */
async function acceptPackage(tmpFile: string, source: PackageInfo["source"]): Promise<PackageInfo> {
  let version: string;
  try {
    version = (await checkPackage(tmpFile)).manifest.version;
  } catch (err) {
    rmSync(tmpFile, { force: true });
    if (err instanceof UpdatePackageError) throw new HttpError(422, "UPDATE_PACKAGE_REFUSED", err.message);
    throw err;
  }
  if (compareVersions(version, appVersion()) <= 0) {
    rmSync(tmpFile, { force: true });
    throw new HttpError(409, "UPDATE_NOT_NEWER", `This package is version ${version}; version ${appVersion()} is installed. Only a newer version can be installed.`);
  }
  const dir = packagesFolder();
  for (const f of readdirSync(dir)) if (!f.endsWith(".part")) rmSync(join(dir, f), { force: true });
  const file = `cctv-monitor-windows-${version}.zip`;
  renameSync(tmpFile, join(dir, file));
  const info: PackageInfo = { version, file, size: statSync(join(dir, file)).size, source, checkedAt: new Date().toISOString() };
  writeFileSync(join(dir, `cctv-monitor-windows-${version}.json`), JSON.stringify(info));
  return info;
}

function counting(limit: number, onBytes: (n: number) => void, hash?: ReturnType<typeof createHash>) {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > limit) return cb(new HttpError(413, "UPDATE_TOO_LARGE", "The package is larger than an update package can be."));
      hash?.update(chunk);
      onBytes(total);
      cb(null, chunk);
    },
  });
}

/** A download in progress (one at a time; the API is a single process). */
let download: { state: "downloading" | "checking" | "failed"; version: string; received: number; total: number; error?: string; startedAt: string } | null = null;

export async function startDownload(): Promise<typeof download> {
  if (download && download.state !== "failed") throw conflict("A download is already running.");
  const s = await settings();
  const latest = (await readSetting<CheckResult>("update_check"))?.latest;
  if (!latest) throw new HttpError(400, "UPDATE_NOT_CHECKED", "Check for updates first.");
  if (compareVersions(latest.version, appVersion()) <= 0) throw conflict(`Version ${appVersion()} is the latest: there is nothing to download.`);
  if (!latest.windows) throw new HttpError(400, "UPDATE_NO_WINDOWS_PACKAGE", `Release ${latest.tag} has no ${WINDOWS_ASSET} to download.`);
  if (latest.windows.size > MAX_PACKAGE_BYTES) throw new HttpError(413, "UPDATE_TOO_LARGE", "The release's package is larger than an update package can be.");
  if (readPackages().some((p) => p.version === latest.version)) throw conflict(`Version ${latest.version} is already downloaded and checked.`);
  download = { state: "downloading", version: latest.version, received: 0, total: latest.windows.size, startedAt: new Date().toISOString() };
  const job = download;
  void (async () => {
    mkdirSync(packagesFolder(), { recursive: true });
    const tmp = join(packagesFolder(), `download-${Date.now()}.part`);
    try {
      // GitHub answers with a redirect to its file storage: followed without the token.
      const first = await fetch(latest.windows!.apiUrl, { headers: githubHeaders(s.token, "application/octet-stream"), redirect: "manual", signal: AbortSignal.timeout(30_000) });
      let res = first;
      if (first.status >= 300 && first.status < 400) {
        const to = first.headers.get("location");
        if (!to || !to.startsWith("https://")) throw new Error("GitHub sent the download to an unexpected address.");
        res = await fetch(to, { headers: { "User-Agent": "cctv-monitor-updater" }, redirect: "follow" });
      }
      if (!res.ok || !res.body) throw new Error(githubError(res.status, Boolean(s.token), s.repository ?? ""));
      const hash = createHash("sha256");
      let lastByte = Date.now();
      const controller = new AbortController();
      const stall = setInterval(() => {
        if (Date.now() - lastByte > 60_000) controller.abort(new Error("The download stopped (no data for a minute)."));
      }, 5_000);
      try {
        await pipeline(Readable.fromWeb(res.body as never), counting(MAX_PACKAGE_BYTES, (n) => ((job.received = n), (lastByte = Date.now())), hash), createWriteStream(tmp), { signal: controller.signal });
      } finally {
        clearInterval(stall);
      }
      if (latest.windows!.sha256 && hash.digest("hex") !== latest.windows!.sha256) throw new Error("The downloaded file is damaged (its checksum differs from GitHub's). Download it again.");
      job.state = "checking";
      const info = await acceptPackage(tmp, "download");
      logger.info({ version: info.version }, "Update downloaded and checked");
      download = null;
    } catch (err) {
      rmSync(tmp, { force: true });
      job.state = "failed";
      job.error = (err as Error).message.slice(0, 300);
      logger.warn({ err: job.error }, "Update download failed");
    }
  })();
  return download;
}

/** A package uploaded from a PC (the zip from the release page), streamed to disk and checked. */
export async function receiveUpload(body: NodeJS.ReadableStream, declaredLength: number | undefined): Promise<PackageInfo> {
  if (declaredLength !== undefined && declaredLength > MAX_PACKAGE_BYTES) throw new HttpError(413, "UPDATE_TOO_LARGE", "The file is larger than an update package can be.");
  mkdirSync(packagesFolder(), { recursive: true });
  const tmp = join(packagesFolder(), `upload-${Date.now()}.part`);
  try {
    await pipeline(body, counting(MAX_PACKAGE_BYTES, () => undefined), createWriteStream(tmp));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  if (statSync(tmp).size === 0) {
    rmSync(tmp, { force: true });
    throw new HttpError(400, "UPDATE_EMPTY", "No file was received.");
  }
  return acceptPackage(tmp, "upload");
}

// ------------------------------------------------------------------------------- installing

interface InstallStatus {
  state: "requested" | "installing" | "installed" | "failed" | "rolled_back";
  version: string;
  fromVersion?: string;
  message?: string;
  at: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const canInstall = () => config.CCTV_PACKAGE === "windows";

export async function requestInstall(version: string, username: string) {
  if (!canInstall()) {
    throw new HttpError(409, "UPDATE_INSTALL_UNAVAILABLE", config.CCTV_PACKAGE === "docker"
      ? "Docker installations are updated from the release's cctv-monitor.zip: extract it over the old folder, then docker compose up -d --build."
      : "Only the Windows package installs updates from this page.");
  }
  const pkg = readPackages().find((p) => p.version === version);
  if (!pkg) throw new HttpError(404, "UPDATE_NOT_READY", `Version ${version} is not downloaded and checked yet.`);
  if (compareVersions(version, appVersion()) <= 0) throw conflict(`Version ${appVersion()} is installed: ${version} is not newer.`);
  const requestFile = join(updatesFolder(), INSTALL_REQUEST);
  const status = readJson<InstallStatus>(join(updatesFolder(), INSTALL_STATUS));
  if (existsSync(requestFile) || status?.state === "installing") throw conflict("An installation is already waiting or running.");
  const request = { version, zip: join(packagesFolder(), pkg.file), fromVersion: appVersion(), requestedBy: username, requestedAt: new Date().toISOString() };
  writeFileSync(requestFile, JSON.stringify(request));
  writeFileSync(join(updatesFolder(), INSTALL_STATUS), JSON.stringify({ state: "requested", version, fromVersion: appVersion(), at: request.requestedAt } satisfies InstallStatus));
  return request;
}

/** Withdraws an installation the updater has not started. */
export function cancelInstall() {
  const status = readJson<InstallStatus>(join(updatesFolder(), INSTALL_STATUS));
  if (status?.state === "installing") throw conflict("The installation has started and can no longer be cancelled.");
  rmSync(join(updatesFolder(), INSTALL_REQUEST), { force: true });
  if (status?.state === "requested") rmSync(join(updatesFolder(), INSTALL_STATUS), { force: true });
}

// ------------------------------------------------------------------------------- overview

export async function getUpdateState() {
  const s = await settings();
  const check = (await readSetting<CheckResult>("update_check")) ?? {};
  const current = appVersion();
  const latest = check.latest ?? null;
  const status = readJson<InstallStatus>(join(updatesFolder(), INSTALL_STATUS));
  return {
    currentVersion: current,
    package: config.CCTV_PACKAGE ?? null,
    canInstall: canInstall(),
    settings: { repository: s.repository, hasToken: Boolean(s.stored.tokenEncrypted), autoCheck: s.autoCheck },
    lastCheck: check.at ? { at: check.at, ok: Boolean(check.ok), error: check.error ?? null } : null,
    latest: latest ? { ...latest, windows: latest.windows ? { size: latest.windows.size } : null, newer: compareVersions(latest.version, current) > 0 } : null,
    download,
    ready: readPackages().filter((p) => compareVersions(p.version, current) > 0).map(({ version, size, source, checkedAt }) => ({ version, size, source, checkedAt })),
    install: status && !(status.state === "installed" && compareVersions(status.version, current) < 0) ? status : null,
  };
}

/** Daily, from the worker: checks for a new release when a repository is set and checking is on. */
export async function autoCheckForUpdates() {
  const s = await settings();
  if (!s.repository || !s.autoCheck) return;
  const last = (await readSetting<CheckResult>("update_check"))?.at;
  if (last && Date.now() - Date.parse(last) < 20 * 3600_000) return;
  await checkForUpdates(null);
}
