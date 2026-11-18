// Installs an update the system administrator asked for in Settings > Updates (Windows package).
// Run by the "CCTV Monitor Updater" task as SYSTEM, every minute and at Windows startup, with its own
// copy of Node (updater\node.exe, outside the folders an update replaces). Exits at once when nothing
// is asked. Otherwise:
//   1. copies the package into update-work\ (only SYSTEM and administrators can change it there),
//   2. checks it again with the INSTALLED app's trusted keys: signed by the release key, newer, every
//      file intact (only the listed files are extracted; never anything in data\),
//   3. stops the app (service\stop.ps1), moves the current app, runtime and scripts to update-backup\
//      and the new ones into place (renames on the same disk: quick, nothing half-copied),
//   4. starts the app and waits for it to answer; if it does not within 5 minutes, puts the previous
//      version back and starts that.
// An update interrupted by a power cut is finished or undone on the next start (update-work\state.json).
// The outcome is in data\updates\install.status.json (shown on the Updates page) and data\logs\updater.log.
//
// Also runs on Linux for testing: CCTV_UPDATER_STOP_CMD and CCTV_UPDATER_START_CMD replace the tasks.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.CCTV_DATA_DIR ?? path.join(ROOT, "data");
const UPDATES = path.join(DATA, "updates");
const REQUEST = path.join(UPDATES, "install.request.json");
const STATUS = path.join(UPDATES, "install.status.json");
const PACKAGES = path.join(UPDATES, "packages");
const WORK = path.join(ROOT, "update-work");
const BACKUP = path.join(ROOT, "update-backup");
const STATE = path.join(WORK, "state.json");
const HEALTH_URL = process.env.CCTV_UPDATER_HEALTH_URL ?? "http://127.0.0.1:4000/api/health";
const HEALTH_WAIT_MS = Number(process.env.CCTV_UPDATER_HEALTH_WAIT_MS ?? 5 * 60_000);
const WIN = process.platform === "win32";
const TASK = "CCTV Monitor";
/** What an update replaces (the same list the package signature allows); data\ is never touched. */
const ENTRIES = ["app", "runtime", "service", "licenses", "START.bat", "STOP.bat", "RESTORE.bat", "UNINSTALL.bat", "README-WINDOWS.txt"];

fs.mkdirSync(path.join(DATA, "logs"), { recursive: true });
const logFile = path.join(DATA, "logs", "updater.log");
function log(message) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
}
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
function writeStatus(status) {
  fs.mkdirSync(UPDATES, { recursive: true });
  fs.writeFileSync(STATUS, JSON.stringify({ ...status, at: new Date().toISOString() }));
}
const writeState = (state) => fs.writeFileSync(STATE, JSON.stringify(state));
const installedVersion = () => readJson(path.join(ROOT, "app", "server", "package.json"))?.version ?? "0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------- the app
function stopApp() {
  log("Stopping the app");
  if (WIN) {
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "service", "stop.ps1"), "-Quiet"], { stdio: "ignore", timeout: 180_000, windowsHide: true });
  } else if (process.env.CCTV_UPDATER_STOP_CMD) {
    execSync(process.env.CCTV_UPDATER_STOP_CMD, { stdio: "ignore", timeout: 180_000 });
  }
}
function startApp() {
  log("Starting the app");
  if (WIN) execFileSync("schtasks.exe", ["/Run", "/TN", TASK], { stdio: "ignore", timeout: 60_000, windowsHide: true });
  else if (process.env.CCTV_UPDATER_START_CMD) execSync(process.env.CCTV_UPDATER_START_CMD, { stdio: "ignore", timeout: 60_000 });
}
async function waitHealthy() {
  const end = Date.now() + HEALTH_WAIT_MS;
  // A moment for the old process to be gone, so its answer is not taken for the new one's.
  await sleep(3000);
  while (Date.now() < end) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await sleep(3000);
  }
  return false;
}

/** Renames, retrying for a while: a file can stay open for a moment after its program stopped. */
async function move(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= 30) throw new Error(`Could not move ${path.relative(ROOT, from)}: ${err.code ?? err.message}`);
      await sleep(2000);
    }
  }
}

// ------------------------------------------------------------------------------- swap and undo
/** Moves the current files to update-backup\ and the new ones (update-work\new) into place. */
async function swapIn(entries) {
  fs.rmSync(BACKUP, { recursive: true, force: true });
  fs.mkdirSync(BACKUP, { recursive: true });
  for (const e of ENTRIES) if (fs.existsSync(path.join(ROOT, e))) await move(path.join(ROOT, e), path.join(BACKUP, e));
  fs.writeFileSync(path.join(BACKUP, ".complete"), "");
  for (const e of entries) await move(path.join(WORK, "new", e), path.join(ROOT, e));
}

/** Puts update-backup\ back (after a failed start, or an update interrupted part-way). */
async function restoreBackup() {
  if (!fs.existsSync(BACKUP)) return false;
  const failed = path.join(WORK, "failed");
  fs.rmSync(failed, { recursive: true, force: true });
  fs.mkdirSync(failed, { recursive: true });
  for (const e of ENTRIES) {
    const saved = path.join(BACKUP, e);
    if (!fs.existsSync(saved)) continue;
    if (fs.existsSync(path.join(ROOT, e))) await move(path.join(ROOT, e), path.join(failed, e));
    await move(saved, path.join(ROOT, e));
  }
  fs.rmSync(failed, { recursive: true, force: true });
  return true;
}

async function rollBack(state, reason) {
  log(`Rolling back to ${state.fromVersion}: ${reason}`);
  writeStatus({ state: "installing", version: state.version, fromVersion: state.fromVersion, message: "The new version did not start: putting the previous one back" });
  try {
    stopApp();
  } catch (err) {
    log(`Stop before rollback: ${err.message}`);
  }
  const restored = await restoreBackup();
  startApp();
  const up = await waitHealthy();
  fs.rmSync(STATE, { force: true });
  writeStatus({
    state: "rolled_back", version: state.version, fromVersion: state.fromVersion,
    message: `${reason} Version ${state.fromVersion} was put back${restored ? "" : " (no backup found)"}${up ? " and runs again" : ", but it does not answer either: see data\\logs"}.`,
  });
}

// ------------------------------------------------------------------------------- one run
async function finishInterrupted() {
  const state = readJson(STATE);
  if (!state) return;
  log(`Found an update interrupted while ${state.phase} (version ${state.version})`);
  if (state.phase === "swapping") {
    // The files may be half moved: put the previous version back.
    await rollBack(state, "The update was interrupted (the server restarted while files were being replaced).");
  } else if (state.phase === "starting") {
    startApp();
    if (await waitHealthy()) {
      fs.rmSync(STATE, { force: true });
      writeStatus({ state: "installed", version: state.version, fromVersion: state.fromVersion, message: "Installed (finished after a restart)." });
    } else {
      await rollBack(state, "The new version did not start.");
    }
  } else {
    fs.rmSync(STATE, { force: true });
  }
}

async function install(request) {
  const fromVersion = installedVersion();
  const version = String(request.version ?? "");
  const fail = (message) => {
    log(`Not installed: ${message}`);
    writeStatus({ state: "failed", version, fromVersion, message });
  };
  // The request is written by the app (as NETWORK SERVICE): only a package in data\updates\packages is taken.
  const zip = path.resolve(String(request.zip ?? ""));
  if (path.dirname(zip) !== path.resolve(PACKAGES) || !zip.endsWith(".zip") || !fs.existsSync(zip)) return fail("The package to install is missing. Download or upload it again.");
  writeStatus({ state: "installing", version, fromVersion, message: "Checking the package" });
  log(`Installing ${version} over ${fromVersion} (asked by ${String(request.requestedBy ?? "?").slice(0, 80)})`);

  // The checks come from the INSTALLED app (its trusted keys), never from the package being installed.
  const { checkPackage, compareVersions } = await import(pathToFileURL(path.join(ROOT, "app", "server", "dist", "update", "packageFile.js")).href);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const copy = path.join(WORK, "package.zip");
  fs.copyFileSync(zip, copy);
  let manifest;
  try {
    ({ manifest } = await checkPackage(copy, { stageDir: path.join(WORK, "new") }));
  } catch (err) {
    fs.rmSync(WORK, { recursive: true, force: true });
    return fail(err.message);
  }
  if (manifest.version !== version) return fail(`The package is version ${manifest.version}, not ${version}.`);
  if (compareVersions(manifest.version, fromVersion) <= 0) return fail(`Version ${fromVersion} is installed: ${manifest.version} is not newer.`);
  const entries = [...new Set(Object.keys(manifest.files).map((f) => f.split("/")[0]))];
  if (!entries.includes("app") || !entries.includes("service")) return fail("The package is incomplete (no app or service folder).");
  fs.rmSync(copy, { force: true });

  const state = { version, fromVersion, phase: "swapping" };
  writeStatus({ state: "installing", version, fromVersion, message: "Stopping the app and replacing its files" });
  try {
    stopApp();
  } catch (err) {
    // Files still in use make the moves below fail, which puts everything back and restarts the app.
    log(`Stopping the app reported a problem (${err.message}); replacing the files anyway`);
  }
  writeState(state);
  try {
    await swapIn(entries);
  } catch (err) {
    return rollBack(state, `Replacing the files failed (${err.message}).`);
  }
  writeState({ ...state, phase: "starting" });
  writeStatus({ state: "installing", version, fromVersion, message: "Starting the new version" });
  startApp();
  if (!(await waitHealthy())) return rollBack(state, "The new version did not answer within 5 minutes.");
  fs.rmSync(STATE, { force: true });
  fs.rmSync(path.join(WORK, "new"), { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  fs.rmSync(zip.replace(/\.zip$/, ".json"), { force: true });
  log(`Installed ${version}`);
  writeStatus({ state: "installed", version, fromVersion, message: `Version ${fromVersion} is kept in update-backup until the next update.` });
}

async function main() {
  // Only one run at a time (the task starts every minute; an installation takes a few).
  // The lock is beside update-work\ (which an installation empties), not in it.
  const lock = path.join(ROOT, "update-work.lock");
  let fd;
  try {
    fd = fs.openSync(lock, "wx");
  } catch {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < 30 * 60_000) return;
    fs.rmSync(lock, { force: true });
    fd = fs.openSync(lock, "wx");
  }
  try {
    await finishInterrupted();
    const request = readJson(REQUEST);
    if (!request) {
      if (fs.existsSync(REQUEST)) fs.rmSync(REQUEST, { force: true });
      return;
    }
    fs.rmSync(REQUEST, { force: true });
    await install(request);
  } catch (err) {
    log(`Updater error: ${err.stack ?? err.message}`);
    const s = readJson(STATUS);
    if (s?.state === "installing") writeStatus({ ...s, state: "failed", message: `The updater stopped: ${err.message}` });
    // Never leave the app stopped.
    try {
      startApp();
    } catch (e) {
      log(`Could not start the app: ${e.message}`);
    }
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

await main();
