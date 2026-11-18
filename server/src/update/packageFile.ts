import { createHash, createPublicKey, verify as verifySig } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import yauzl from "yauzl";
import { UPDATE_PUBLIC_KEYS } from "./trustedKeys.js";

/**
 * Update packages: the Windows package zip, signed. Its top folder holds update.json (the version and
 * the SHA-256 of every file the update installs) and update.sig (an Ed25519 signature of update.json
 * by the release key). The app accepts a package only when the signature is made by a key in
 * trustedKeys.ts (compiled into the installed app, so nobody can change it from the web page) and
 * every listed file matches its hash. Files not listed (the guides added to the zip) are never installed.
 */
export const MANIFEST_NAME = "update.json";
export const SIGNATURE_NAME = "update.sig";
export const MANIFEST_FORMAT = "cctv-monitor/update";
export const MAX_PACKAGE_BYTES = 600 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 50_000;

export interface UpdateManifest {
  format: typeof MANIFEST_FORMAT;
  formatVersion: 1;
  app: "cctv-monitor";
  platform: "windows-x64";
  version: string;
  createdAt: string;
  /** Path (forward slashes, under the package folder) -> SHA-256 (hex). */
  files: Record<string, string>;
}

export class UpdatePackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdatePackageError";
  }
}

/** Where an update may write: the app, its runtimes, its service scripts and the start/stop files. Never data\. */
const TOP_FOLDERS = ["app/", "runtime/", "service/", "licenses/"];
const TOP_FILES = new Set(["START.bat", "STOP.bat", "RESTORE.bat", "UNINSTALL.bat", "README-WINDOWS.txt"]);

export function isInstallablePath(p: string): boolean {
  if (!p || p.length > 400 || p.includes("\\") || p.includes("\0") || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
  if (posix.normalize(p) !== p || p.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  return TOP_FILES.has(p) || TOP_FOLDERS.some((t) => p.startsWith(t) && p.length > t.length);
}

/** a > b: 1, a < b: -1, equal: 0. Versions are numbers separated by dots (1.10.0 > 1.9.3). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Checks the signature with the trusted keys and returns the manifest it covers. */
export function verifyManifest(manifestBytes: Buffer, signature: Buffer | string, keys: readonly string[] = UPDATE_PUBLIC_KEYS): UpdateManifest {
  const sig = Buffer.isBuffer(signature) ? Buffer.from(signature.toString("utf8").trim(), "base64") : Buffer.from(signature.trim(), "base64");
  if (sig.length !== 64) throw new UpdatePackageError("The package's signature is missing or damaged.");
  const signedBy = keys.find((k) => {
    try {
      return verifySig(null, manifestBytes, createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }), sig);
    } catch {
      return false;
    }
  });
  if (!signedBy) throw new UpdatePackageError("The package is not signed by the CCTV Monitor release key. It may have been changed or built elsewhere: it was not installed.");
  let m: UpdateManifest;
  try {
    m = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new UpdatePackageError("The package's file list cannot be read.");
  }
  if (m.format !== MANIFEST_FORMAT || m.formatVersion !== 1 || m.app !== "cctv-monitor") throw new UpdatePackageError("This is not a CCTV Monitor update package.");
  if (m.platform !== "windows-x64") throw new UpdatePackageError(`This package is for ${m.platform}, not this server.`);
  if (typeof m.version !== "string" || !/^\d{1,4}(\.\d{1,4}){1,3}$/.test(m.version)) throw new UpdatePackageError("The package has no valid version.");
  const entries = Object.entries(m.files ?? {});
  if (!entries.length || entries.length > MAX_FILES) throw new UpdatePackageError("The package's file list is empty or too long.");
  for (const [p, h] of entries) {
    if (!isInstallablePath(p)) throw new UpdatePackageError(`The package lists a file outside the app folders (${p.slice(0, 80)}).`);
    if (!/^[0-9a-f]{64}$/.test(h)) throw new UpdatePackageError(`The package lists an invalid checksum for ${p}.`);
  }
  return m;
}

const openZip = (file: string) =>
  new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (err, zip) => (err ? reject(err) : resolve(zip!))),
  );

const readStream = (zip: yauzl.ZipFile, entry: yauzl.Entry) =>
  new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s!))));

async function entries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  const list: yauzl.Entry[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (e: yauzl.Entry) => {
      list.push(e);
      if (list.length > MAX_FILES * 2) reject(new UpdatePackageError("The package holds too many files."));
      else zip.readEntry();
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  return list;
}

async function readSmall(zip: yauzl.ZipFile, e: yauzl.Entry, max: number): Promise<Buffer> {
  if (e.uncompressedSize > max) throw new UpdatePackageError(`${e.fileName} is too large.`);
  const chunks: Buffer[] = [];
  for await (const c of (await readStream(zip, e)) as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks);
}

export interface CheckedPackage {
  manifest: UpdateManifest;
  /** Bytes of the files the update installs. */
  installBytes: number;
}

/**
 * Checks a package zip: the signature, then every listed file's checksum. With `stageDir`, the listed
 * files are also written there (only those, only after their path was checked); a file whose checksum
 * differs fails the whole package.
 */
export async function checkPackage(zipFile: string, opts: { stageDir?: string; keys?: readonly string[] } = {}): Promise<CheckedPackage> {
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(zipFile);
  } catch {
    throw new UpdatePackageError("This file is not a zip file, or it is damaged (download it again).");
  }
  try {
    const all = await entries(zip);
    const manifestEntry = all.find((e) => /^[^/]+\/update\.json$/.test(e.fileName) || e.fileName === MANIFEST_NAME);
    if (!manifestEntry) throw new UpdatePackageError("This zip is not a signed CCTV Monitor update package (it has no update.json). Packages from the release page are signed.");
    const prefix = manifestEntry.fileName.slice(0, -MANIFEST_NAME.length);
    const sigEntry = all.find((e) => e.fileName === prefix + SIGNATURE_NAME);
    if (!sigEntry) throw new UpdatePackageError("The package's signature (update.sig) is missing.");
    const manifest = verifyManifest(await readSmall(zip, manifestEntry, MAX_MANIFEST_BYTES), await readSmall(zip, sigEntry, 1024), opts.keys);

    const byName = new Map(all.map((e) => [e.fileName, e]));
    let installBytes = 0;
    for (const [rel, expected] of Object.entries(manifest.files)) {
      const e = byName.get(prefix + rel);
      if (!e) throw new UpdatePackageError(`The package is incomplete: ${rel} is missing.`);
      installBytes += e.uncompressedSize;
      const hash = createHash("sha256");
      const hasher = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      const source = await readStream(zip, e);
      if (opts.stageDir) {
        const out = join(opts.stageDir, ...rel.split("/"));
        mkdirSync(dirname(out), { recursive: true });
        await pipeline(source, hasher, createWriteStream(out));
      } else {
        await pipeline(source, hasher, async function* (src) {
          for await (const _ of src) {
            // Only hashed.
          }
        });
      }
      if (hash.digest("hex") !== expected) throw new UpdatePackageError(`The package was changed after it was signed (${rel} differs): it was not installed.`);
    }
    return { manifest, installBytes };
  } finally {
    zip.close();
  }
}
