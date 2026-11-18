import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";

/** Signed Windows-like update packages for tests, made with the real signing script. */
const SIGN = resolve(dirname(fileURLToPath(import.meta.url)), "../../windows/sign-package.mjs");
export const tmp = mkdtempSync(join(tmpdir(), "cctv-update-test-"));
export const cleanUpdateFixtures = () => rmSync(tmp, { recursive: true, force: true });

export function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyFile = join(tmp, `key-${Math.random().toString(36).slice(2)}.pem`);
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  return { keyFile, privateKey, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

let n = 0;
export const nextId = () => ++n;
/** A package folder like the Windows build's, signed with the real signing script. */
export function buildPackage(keyFile: string, version = "1.2.0") {
  const dir = join(tmp, `pkg-${++n}`, "cctv-monitor");
  const files: Record<string, string> = {
    "app/server/dist/index.js": "console.log('v" + version + "');",
    "app/web/dist/index.html": "<html></html>",
    "runtime/node/node.exe": "MZ fake node",
    "service/supervisor.mjs": "// supervisor",
    "START.bat": "@echo off\r\n",
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  execFileSync(process.execPath, [SIGN, dir, keyFile, version], { stdio: "pipe" });
  // The guides are added after signing: they travel in the zip but are never installed.
  writeFileSync(join(dir, "Guide.pdf"), "%PDF");
  return dir;
}

export async function zipFolder(dir: string, edit?: (rel: string, data: Buffer) => Buffer): Promise<string> {
  const zip = new yazl.ZipFile();
  const top = join(dir, "..");
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(top, full).split("\\").join("/");
        zip.addBuffer(edit ? edit(rel, readFileSync(full)) : readFileSync(full), rel);
      }
    }
  };
  walk(dir);
  const out = `${dir}.zip`;
  await new Promise<void>((res, rej) => {
    zip.outputStream.pipe(createWriteStream(out)).on("close", () => res()).on("error", rej);
    zip.end();
  });
  return out;
}

