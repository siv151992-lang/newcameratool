import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import type pg from "pg";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { badRequest } from "../lib/errors.js";
import { zonedParts } from "../lib/csv.js";
import { logger } from "../lib/logger.js";

/**
 * Backups of the whole database, made by the app itself (no database tools needed, the same on
 * Docker and Windows): every table's rows, read in one consistent snapshot, written as gzip-
 * compressed JSON lines. A file starts with a header (format, app version, the migrations the
 * schema had) and ends with a footer (rows per table), so a cut-off file is never restored.
 *
 * Restoring rebuilds the schema with the app's own migrations up to the backup's, loads the rows in
 * one transaction (all or nothing), and later migrations then bring it up to date. Sessions and
 * email links are not backed up. Camera and mail passwords are stored encrypted: they are read after
 * a restore only with the same credential.key, which is kept apart from the backups.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "migrations");
const FORMAT = "cctv-monitor-backup";
const FILE = /^cctv-backup-(\d{8})-(\d{6})\.json\.gz$/;
/** Not backed up: sign-in sessions and one-time email links (both must not come back). */
const SKIP = new Set(["sessions", "email_tokens", "schema_migrations"]);
const BATCH = 2000;
const LOCK = 727275;

export const defaultBackupFolder = () => join(dirname(resolve(config.CREDENTIAL_KEY_FILE)), "backups");

// ---------------------------------------------------------------- settings

export const backupSettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** Hour of the day (in timeZone) the daily backup runs. */
    hour: z.number().int().min(0).max(23),
    timeZone: z.string().min(1).max(64),
    keepDays: z.number().int().min(1).max(365),
    /** Absolute path, e.g. a mounted network share; null: the data folder's "backups". */
    folder: z.string().trim().max(400).nullable(),
  })
  .partial()
  .strict()
  .superRefine((v, ctx) => {
    if (v.folder && !isAbsolute(v.folder)) ctx.addIssue({ code: "custom", path: ["folder"], message: "Use a full path, e.g. D:\\Backups\\cctv or /mnt/backups" });
    if (v.timeZone) {
      try {
        zonedParts(Date.now(), v.timeZone);
      } catch {
        ctx.addIssue({ code: "custom", path: ["timeZone"], message: "Unknown time zone" });
      }
    }
  });

export interface BackupSettings {
  enabled: boolean;
  hour: number;
  timeZone: string;
  keepDays: number;
  folder: string | null;
}
const DEFAULTS: BackupSettings = { enabled: true, hour: 2, timeZone: "UTC", keepDays: 14, folder: null };

export interface BackupStatus {
  lastSuccessAt: string | null;
  lastFile: string | null;
  lastSize: number | null;
  lastRows: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
}
const NO_STATUS: BackupStatus = { lastSuccessAt: null, lastFile: null, lastSize: null, lastRows: null, lastDurationMs: null, lastError: null, lastErrorAt: null };

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const { rows } = await pool.query<{ value: T }>("SELECT value FROM app_settings WHERE key = $1", [key]);
  return { ...fallback, ...(rows[0]?.value ?? {}) };
}
async function writeSetting(key: string, value: unknown, userId: string | null = null) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId],
  );
}

export const getBackupSettings = () => readSetting<BackupSettings>("backup", DEFAULTS);
export const getBackupStatus = () => readSetting<BackupStatus>("backup_status", NO_STATUS);

export async function updateBackupSettings(patch: z.infer<typeof backupSettingsSchema>, userId: string) {
  const next = { ...(await getBackupSettings()), ...patch };
  if (next.folder) ensureFolder(next.folder);
  await writeSetting("backup", next, userId);
  return next;
}

export const backupFolder = (s: BackupSettings) => s.folder || defaultBackupFolder();

function ensureFolder(folder: string) {
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw badRequest(`The backup folder ${folder} cannot be created: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- listing and pruning

export interface BackupFile {
  name: string;
  size: number;
  createdAt: string;
}

export function listBackupFiles(folder: string): BackupFile[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((n) => FILE.test(n))
    .map((name) => {
      const st = statSync(join(folder, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Deletes this app's backups older than keepDays (only files it named; the newest is always kept). */
export function pruneBackups(folder: string, keepDays: number, now = Date.now()): string[] {
  const files = listBackupFiles(folder);
  const removed: string[] = [];
  for (const f of files.slice(1)) {
    if (now - new Date(f.createdAt).getTime() > keepDays * 86_400_000) {
      unlinkSync(join(folder, f.name));
      removed.push(f.name);
    }
  }
  return removed;
}

// ---------------------------------------------------------------- making a backup

const appliedMigrations = async (db: pg.ClientBase) =>
  (await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name);

/** The tables backed up (the restore sets their links aside while loading, then checks them all). */
async function backupTables(db: pg.ClientBase): Promise<string[]> {
  return (await db.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows
    .map((r) => r.name)
    .filter((t) => !SKIP.has(t));
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** Writes a backup into `folder` and returns what it contains. */
export async function writeBackup(folder: string, db: pg.Pool = pool) {
  ensureFolder(folder);
  const started = Date.now();
  const name = `cctv-backup-${stamp(new Date())}.json.gz`;
  const tmp = join(folder, `${name}.part`);
  const client = await db.connect();
  const counts: Record<string, number> = {};
  try {
    // One snapshot for every table, so the backup is consistent.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await backupTables(client);
    const header = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), appVersion: appVersion(), migrations: await appliedMigrations(client), tables };
    async function* lines() {
      yield `${JSON.stringify(header)}\n`;
      for (const t of tables) {
        counts[t] = 0;
        await client.query(`DECLARE rows_c NO SCROLL CURSOR FOR SELECT to_jsonb(x) AS j FROM ${ident(t)} x`);
        for (;;) {
          const { rows } = await client.query<{ j: unknown }>(`FETCH ${BATCH} FROM rows_c`);
          if (!rows.length) break;
          counts[t] = (counts[t] ?? 0) + rows.length;
          yield rows.map((r) => `${JSON.stringify({ t, r: r.j })}\n`).join("");
        }
        await client.query("CLOSE rows_c");
      }
      yield `${JSON.stringify({ end: true, counts })}\n`;
    }
    await pipeline(Readable.from(lines()), createGzip({ level: 6 }), createWriteStream(tmp, { mode: 0o600 }));
    await client.query("COMMIT");
    renameSync(tmp, join(folder, name));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    try {
      unlinkSync(tmp);
    } catch {
      // nothing written
    }
    throw err;
  } finally {
    client.release();
  }
  const rows = Object.values(counts).reduce((a, b) => a + b, 0);
  return { file: name, folder, size: statSync(join(folder, name)).size, rows, tables: Object.keys(counts).length, durationMs: Date.now() - started };
}

export function appVersion(): string {
  try {
    return JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Makes a backup now (Back up now, or the daily one) and records the outcome; prunes old ones.
 * Only one runs at a time across API and worker.
 */
export async function runBackup(trigger: "manual" | "scheduled") {
  const lock = await pool.connect();
  try {
    const { rows } = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK]);
    if (!rows[0]!.ok) throw badRequest("A backup is already running. Try again in a minute.");
    const settings = await getBackupSettings();
    const folder = backupFolder(settings);
    try {
      const r = await writeBackup(folder);
      const removed = pruneBackups(folder, settings.keepDays);
      await writeSetting("backup_status", { ...(await getBackupStatus()), lastSuccessAt: new Date().toISOString(), lastFile: r.file, lastSize: r.size, lastRows: r.rows, lastDurationMs: r.durationMs, lastError: null, lastErrorAt: null });
      logger.info({ trigger, file: r.file, size: r.size, rows: r.rows, removed: removed.length }, "Backup written");
      return { ...r, removed };
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      await writeSetting("backup_status", { ...(await getBackupStatus()), lastError: message, lastErrorAt: new Date().toISOString() });
      logger.error({ trigger, err: message }, "Backup failed");
      throw badRequest(`The backup failed: ${message}`);
    } finally {
      await lock.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => undefined);
    }
  } finally {
    lock.release();
  }
}

/** Worker tick: runs the daily backup once the chosen hour has come, if today's has not been made. */
export async function backupIfDue(now = new Date()) {
  const s = await getBackupSettings();
  if (!s.enabled) return null;
  const local = zonedParts(now.getTime(), s.timeZone);
  if (Number(local.text.slice(11, 13)) < s.hour) return null;
  const status = await getBackupStatus();
  const today = local.text.slice(0, 10);
  const lastDay = status.lastSuccessAt ? zonedParts(new Date(status.lastSuccessAt).getTime(), s.timeZone).text.slice(0, 10) : null;
  // A failure is tried again an hour later, not on every tick.
  if (lastDay === today) return null;
  if (status.lastErrorAt && now.getTime() - new Date(status.lastErrorAt).getTime() < 3_600_000) return null;
  return runBackup("scheduled").catch(() => null);
}

// ---------------------------------------------------------------- restoring

export interface BackupHeader {
  format: string;
  version: number;
  createdAt: string;
  appVersion: string;
  migrations: string[];
  tables: string[];
}

/** Reads a backup's header and footer; throws if it is not a complete backup of this app. */
export async function inspectBackup(file: string): Promise<{ header: BackupHeader; counts: Record<string, number> }> {
  let header: BackupHeader | undefined;
  let counts: Record<string, number> | undefined;
  for await (const line of readLines(file)) {
    const o = JSON.parse(line);
    if (!header) {
      if (o.format !== FORMAT) throw new Error("This is not a CCTV Monitor backup");
      header = o;
    } else if (o.end) counts = o.counts;
  }
  if (!header) throw new Error("The backup is empty");
  if (!counts) throw new Error("The backup is incomplete (it was cut off while being written or copied)");
  return { header, counts };
}

function readLines(file: string) {
  return createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
}

/**
 * Replaces the whole database with the backup, in one transaction: the schema is rebuilt with this
 * app's migrations up to the backup's, the rows loaded, counters reset. Run with the app stopped.
 */
export async function restoreBackup(file: string, db: pg.Pool, log: (m: string) => void = () => undefined) {
  const { header, counts } = await inspectBackup(file);
  const known = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const unknown = header.migrations.filter((m) => !known.includes(m));
  if (unknown.length) throw new Error(`The backup is from a newer version of the app (${header.appVersion}). Install that version or newer, then restore.`);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of known.filter((k) => header.migrations.includes(k))) {
      await client.query(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [m]);
    }
    log(`Schema rebuilt (${header.migrations.length} migrations)`);
    // Migrations add starting rows (roles, brands...): the backup's rows replace them.
    const tables = header.tables.filter((t) => !SKIP.has(t));
    if (tables.length) await client.query(`TRUNCATE ${tables.map(ident).join(", ")} RESTART IDENTITY CASCADE`);
    // Tables refer to each other (some in a circle): the links are set aside while loading and put
    // back afterwards, which checks every row against them.
    const links = (await client.query<{ t: string; name: string; def: string }>(
      `SELECT conrelid::regclass::text AS t, conname AS name, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
    )).rows;
    for (const l of links) await client.query(`ALTER TABLE ${l.t} DROP CONSTRAINT ${ident(l.name)}`);
    let batch: unknown[] = [];
    let table: string | null = null;
    const flush = async () => {
      if (!batch.length || !table) return;
      await client.query(`INSERT INTO ${ident(table)} SELECT * FROM jsonb_populate_recordset(NULL::${ident(table)}, $1::jsonb)`, [JSON.stringify(batch)]);
      batch = [];
    };
    const loaded: Record<string, number> = {};
    let first = true;
    for await (const line of readLines(file)) {
      if (first) {
        first = false;
        continue;
      }
      const o = JSON.parse(line);
      if (o.end) break;
      if (o.t !== table) {
        await flush();
        table = o.t;
        if (!tables.includes(table!)) throw new Error(`Unexpected table ${table} in the backup`);
      }
      batch.push(o.r);
      loaded[table!] = (loaded[table!] ?? 0) + 1;
      if (batch.length >= 500) await flush();
    }
    await flush();
    for (const [t, n] of Object.entries(counts)) {
      if ((loaded[t] ?? 0) !== n) throw new Error(`Table ${t}: ${loaded[t] ?? 0} rows read, ${n} expected`);
    }
    for (const l of links) await client.query(`ALTER TABLE ${l.t} ADD CONSTRAINT ${ident(l.name)} ${l.def}`);
    // Counters (serial ids) continue after the restored rows.
    const seqs = (await client.query<{ t: string; c: string }>(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`,
    )).rows;
    for (const { t, c } of seqs) {
      await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), coalesce((SELECT max(${ident(c)}) FROM ${ident(t)}), 1), (SELECT max(${ident(c)}) FROM ${ident(t)}) IS NOT NULL)`, [`public.${t}`, c]);
    }
    await client.query("COMMIT");
    const rows = Object.values(loaded).reduce((a, b) => a + b, 0);
    log(`Restored ${rows} rows in ${Object.keys(loaded).length} tables from the backup of ${header.createdAt}`);
    return { header, rows };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
