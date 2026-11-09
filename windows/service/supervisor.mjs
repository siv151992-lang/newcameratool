// Runs CCTV Storage Monitor on Windows without Docker: PostgreSQL, the API, the monitoring worker,
// go2rtc (live video) and Caddy (HTTPS), each restarted if it stops. Started at Windows startup by
// the "CCTV Monitor" scheduled task (as NETWORK SERVICE), set up by START.bat. Stopped by STOP.bat,
// which writes data\stop.request. Everything lives in this package folder; data and logs in data\.
//
// Also runs on Linux for testing (CCTV_PG_BIN points at PostgreSQL's bin folder there).

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.CCTV_DATA_DIR ?? path.join(ROOT, "data");
const LOGS = path.join(DATA, "logs");
const RUNTIME = path.join(ROOT, "runtime");
const WIN = process.platform === "win32";
const exe = (name) => (WIN ? `${name}.exe` : name);
const PG_BIN = process.env.CCTV_PG_BIN ?? path.join(RUNTIME, "pgsql", "bin");
const PG_DATA = path.join(DATA, "pgdata");
const PG_PORT = 54329;
const API_PORT = 4000;
const STOP_FILE = path.join(DATA, "stop.request");

fs.mkdirSync(LOGS, { recursive: true });

// -------------------------------------------------------------------------------------- logging
function openLog(name) {
  const file = path.join(LOGS, `${name}.log`);
  try {
    if (fs.statSync(file).size > 20 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
  return fs.openSync(file, "a");
}
const mainLog = openLog("supervisor");
function log(message) {
  fs.writeSync(mainLog, `${new Date().toISOString()} ${message}\n`);
}

// ------------------------------------------------------------------------------------- settings
/** data\.env: KEY=VALUE lines (written by setup.ps1). */
function readEnvFile() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(DATA, ".env"), "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trimStart().startsWith("#")) env[m[1]] = m[2];
    }
  } catch {
    log("No data\\.env yet: run START.bat to set the app up.");
  }
  return env;
}
const settings = readEnvFile();
const site = settings.SITE_ADDRESS || "localhost";
const httpPort = settings.HTTP_PORT || "80";
const httpsPort = settings.HTTPS_PORT || "443";

const passwordFile = path.join(DATA, "db_password");
if (!fs.existsSync(passwordFile)) fs.writeFileSync(passwordFile, randomBytes(24).toString("hex"), { mode: 0o600 });

const go2rtc = path.join(RUNTIME, exe("go2rtc"));
const caddy = path.join(RUNTIME, exe("caddy"));
const hasGo2rtc = fs.existsSync(go2rtc);

/** The environment the API and the worker run with (data\.env first, then what this package needs). */
const appEnv = {
  ...process.env,
  ...settings,
  NODE_ENV: "production",
  PORT: String(API_PORT),
  LISTEN_HOST: "127.0.0.1",
  DATABASE_URL: `postgres://cctv@127.0.0.1:${PG_PORT}/postgres`,
  DATABASE_PASSWORD_FILE: passwordFile,
  CREDENTIAL_KEY_FILE: settings.CREDENTIAL_KEY_FILE || path.join(DATA, "credential.key"),
  WEB_DIST_DIR: path.join(ROOT, "app", "web", "dist"),
  COOKIE_SECURE: "true",
  TRUST_PROXY: "loopback",
  PUBLIC_URL: settings.PUBLIC_URL || (httpsPort === "443" ? `https://${site}` : `https://${site}:${httpsPort}`),
  PLAYBACK_RELAY_URL: "rtsp://127.0.0.1:8554",
  ...(hasGo2rtc ? { LIVE_VIDEO_URL: "http://127.0.0.1:1984" } : {}),
};

// ------------------------------------------------------------------------------------- database
const pgCtl = path.join(PG_BIN, exe("pg_ctl"));
function pgStatusRunning() {
  return spawnSync(pgCtl, ["status", "-D", PG_DATA], { windowsHide: true, stdio: "ignore", timeout: 30_000 }).status === 0;
}

function initDatabase() {
  if (fs.existsSync(path.join(PG_DATA, "PG_VERSION"))) return;
  log("Creating the database (first start)...");
  const r = spawnSync(path.join(PG_BIN, exe("initdb")), ["-D", PG_DATA, "-U", "cctv", "-A", "scram-sha-256", `--pwfile=${passwordFile}`, "-E", "UTF8", "--no-locale"], { windowsHide: true, encoding: "utf8" });
  log(`initdb: ${(r.stdout || "") + (r.stderr || "")}`.trim());
  if (r.status !== 0) throw new Error("initdb failed: see supervisor.log");
  // Only this PC may connect, on a port that does not clash with another PostgreSQL.
  fs.appendFileSync(path.join(PG_DATA, "postgresql.conf"), `\n# CCTV Storage Monitor\nport = ${PG_PORT}\nlisten_addresses = '127.0.0.1'\nmax_connections = 100\n`);
}

function startDatabase() {
  if (pgStatusRunning()) return true;
  log("Starting PostgreSQL...");
  // Its output goes straight into supervisor.log, not through a pipe: on Windows the database server
  // inherits pg_ctl's output handles, so a pipe would stay open (and this wait would last) until the
  // database stops.
  const r = spawnSync(pgCtl, ["start", "-D", PG_DATA, "-l", path.join(LOGS, "postgres.log"), "-w", "-t", "120"], {
    windowsHide: true,
    stdio: ["ignore", mainLog, mainLog],
    timeout: 150_000,
  });
  log(r.status === 0 ? "PostgreSQL started." : `PostgreSQL start failed (exit code ${r.status ?? r.error?.message}).`);
  return r.status === 0;
}

function stopDatabase() {
  spawnSync(pgCtl, ["stop", "-D", PG_DATA, "-m", "fast", "-w", "-t", "60"], { windowsHide: true, stdio: ["ignore", mainLog, mainLog], timeout: 90_000 });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
}

// ------------------------------------------------------------------------------------ processes
let stopping = false;
const children = new Map();

/** Runs a program and starts it again if it stops (after 2 s, doubling up to a minute). */
function keepRunning(name, command, args, options) {
  let delay = 2000;
  const start = () => {
    if (stopping) return;
    const out = openLog(name);
    const started = Date.now();
    const child = spawn(command, args, { ...options, stdio: ["ignore", out, out], windowsHide: true });
    children.set(name, child);
    log(`Started ${name} (pid ${child.pid})`);
    child.on("error", (err) => log(`${name} could not start: ${err.message}`));
    child.on("exit", (code) => {
      fs.closeSync(out);
      children.delete(name);
      if (stopping) return;
      if (Date.now() - started > 60_000) delay = 2000;
      log(`${name} stopped (code ${code}); starting it again in ${delay / 1000} s`);
      setTimeout(start, delay);
      delay = Math.min(delay * 2, 60_000);
    });
  };
  start();
}

async function main() {
  log(`Starting CCTV Storage Monitor from ${ROOT} (dashboard https://${site}${httpsPort === "443" ? "" : `:${httpsPort}`})`);
  try { fs.unlinkSync(STOP_FILE); } catch { /* none */ }

  initDatabase();
  if (!startDatabase()) log("PostgreSQL did not start: see logs\\postgres.log");
  for (let i = 0; i < 60 && !(await portOpen(PG_PORT)); i++) await new Promise((r) => setTimeout(r, 1000));

  const node = process.execPath;
  const serverDir = path.join(ROOT, "app", "server");
  keepRunning("api", node, [path.join(serverDir, "dist", "index.js")], { cwd: serverDir, env: appEnv });
  // The API applies database changes first; the worker waits for the same lock, so either order is safe.
  setTimeout(() => keepRunning("worker", node, [path.join(serverDir, "dist", "worker.js")], { cwd: serverDir, env: appEnv }), 5000);
  if (hasGo2rtc) keepRunning("go2rtc", go2rtc, ["-config", path.join(ROOT, "service", "go2rtc.yaml")], { cwd: DATA });
  if (fs.existsSync(caddy)) {
    keepRunning("caddy", caddy, ["run", "--config", path.join(ROOT, "service", "Caddyfile"), "--adapter", "caddyfile"], {
      cwd: DATA,
      env: { ...process.env, SITE_ADDRESS: site, HTTP_PORT: httpPort, HTTPS_PORT: httpsPort, XDG_DATA_HOME: DATA, XDG_CONFIG_HOME: DATA, API_PORT: String(API_PORT) },
    });
  }

  // PostgreSQL is checked every 30 s and started again if it stopped.
  setInterval(() => {
    if (!stopping && !pgStatusRunning()) {
      log("PostgreSQL is not running: starting it again");
      startDatabase();
    }
  }, 30_000);

  // STOP.bat asks for a clean stop through this file.
  setInterval(() => { if (fs.existsSync(STOP_FILE)) void shutdown("stop requested"); }, 2000);
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`Stopping (${reason})...`);
  for (const [name, child] of children) {
    log(`Stopping ${name}`);
    child.kill();
  }
  await new Promise((r) => setTimeout(r, 3000));
  stopDatabase();
  try { fs.unlinkSync(STOP_FILE); } catch { /* none */ }
  log("Stopped.");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
main().catch((err) => {
  log(`Could not start: ${err.message}`);
  process.exit(1);
});
