// Signs a built Windows package folder for in-app updates: writes update.json (the version and the
// SHA-256 of every file the update installs) and update.sig (Ed25519 signature of update.json).
//
// Usage: node windows/sign-package.mjs <package-folder> <private-key.pem> <version>
// The key is the release signing key (PKCS#8 PEM). Its public half must be in
// server/src/update/trustedKeys.ts of the installed version, or the update is refused.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [dir, keyFile, version] = process.argv.slice(2);
if (!dir || !keyFile || !version) {
  console.error("Usage: node windows/sign-package.mjs <package-folder> <private-key.pem> <version>");
  process.exit(2);
}
const key = createPrivateKey(fs.readFileSync(keyFile));
const TOP_FOLDERS = ["app", "runtime", "service", "licenses"];
const TOP_FILES = ["START.bat", "STOP.bat", "RESTORE.bat", "UNINSTALL.bat", "README-WINDOWS.txt"];

const files = {};
function add(rel) {
  const full = path.join(dir, ...rel.split("/"));
  const st = fs.lstatSync(full);
  if (st.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in a package: ${rel}`);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(full).sort()) add(`${rel}/${name}`);
  } else {
    files[rel] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
  }
}
for (const t of TOP_FOLDERS) if (fs.existsSync(path.join(dir, t))) add(t);
for (const f of TOP_FILES) if (fs.existsSync(path.join(dir, f))) add(f);

const manifest = {
  format: "cctv-monitor/update",
  formatVersion: 1,
  app: "cctv-monitor",
  platform: "windows-x64",
  version,
  createdAt: new Date().toISOString(),
  files,
};
const bytes = Buffer.from(JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(dir, "update.json"), bytes);
fs.writeFileSync(path.join(dir, "update.sig"), sign(null, bytes, key).toString("base64") + "\n");
const pub = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
console.log(`Signed version ${version}: ${Object.keys(files).length} files, key ${pub}`);
