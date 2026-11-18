import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";
import yazl from "yazl";
import { afterAll, describe, expect, it } from "vitest";
import { checkPackage, compareVersions, isInstallablePath, UpdatePackageError } from "../../src/update/packageFile.js";

const SIGN = resolve(__dirname, "../../../windows/sign-package.mjs");
const tmp = mkdtempSync(join(tmpdir(), "cctv-update-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyFile = join(tmp, `key-${Math.random().toString(36).slice(2)}.pem`);
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  return { keyFile, privateKey, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

let n = 0;
/** A package folder like the Windows build's, signed with the real signing script. */
function buildPackage(keyFile: string, version = "1.2.0") {
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

async function zipFolder(dir: string, edit?: (rel: string, data: Buffer) => Buffer): Promise<string> {
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

describe("signed update packages", () => {
  const release = keyPair();

  it("accepts a package signed by a trusted key and stages exactly the listed files", async () => {
    const zip = await zipFolder(buildPackage(release.keyFile, "1.2.0"));
    const stage = join(tmp, "stage-ok");
    const r = await checkPackage(zip, { keys: [release.pub], stageDir: stage });
    expect(r.manifest).toMatchObject({ version: "1.2.0", platform: "windows-x64", app: "cctv-monitor" });
    expect(Object.keys(r.manifest.files).sort()).toEqual(["START.bat", "app/server/dist/index.js", "app/web/dist/index.html", "runtime/node/node.exe", "service/supervisor.mjs"]);
    expect(readFileSync(join(stage, "app/server/dist/index.js"), "utf8")).toBe("console.log('v1.2.0');");
    expect(existsSync(join(stage, "Guide.pdf"))).toBe(false);
  });

  it("refuses a package signed by another key", async () => {
    const other = keyPair();
    const zip = await zipFolder(buildPackage(other.keyFile));
    await expect(checkPackage(zip, { keys: [release.pub] })).rejects.toThrow(/not signed by the CCTV Monitor release key/);
  });

  it("refuses a package changed after signing, and stages nothing usable", async () => {
    const zip = await zipFolder(buildPackage(release.keyFile), (rel, data) => (rel.endsWith("index.js") ? Buffer.from("evil()") : data));
    await expect(checkPackage(zip, { keys: [release.pub], stageDir: join(tmp, "stage-bad") })).rejects.toThrow(/changed after it was signed \(app\/server\/dist\/index\.js/);
  });

  it("refuses a signed list that would write outside the app folders (data, absolute, ..)", async () => {
    for (const bad of ["data/credential.key", "../evil.exe", "app/../../x", "C:/Windows/x.dll", "/etc/x", "app\\x"]) {
      const manifest = Buffer.from(JSON.stringify({ format: "cctv-monitor/update", formatVersion: 1, app: "cctv-monitor", platform: "windows-x64", version: "9.0.0", createdAt: "x", files: { [bad]: "a".repeat(64) } }));
      const dir = join(tmp, `forged-${++n}`, "cctv-monitor");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "update.json"), manifest);
      writeFileSync(join(dir, "update.sig"), sign(null, manifest, release.privateKey).toString("base64"));
      await expect(checkPackage(await zipFolder(dir), { keys: [release.pub] })).rejects.toThrow(/outside the app folders/);
    }
  });

  it("explains files that are not update packages", async () => {
    const notZip = join(tmp, "not.zip");
    writeFileSync(notZip, "hello");
    await expect(checkPackage(notZip, { keys: [release.pub] })).rejects.toThrow(/not a zip file/);
    const dir = join(tmp, `plain-${++n}`, "cctv-monitor");
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "x.txt"), "x");
    await expect(checkPackage(await zipFolder(dir), { keys: [release.pub] })).rejects.toBeInstanceOf(UpdatePackageError);
  });

  it("compares versions numerically and knows where an update may write", () => {
    expect(compareVersions("1.10.0", "1.9.3")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.2.1")).toBe(-1);
    expect(["app/server/dist/a.js", "runtime/pgsql/bin/pg_ctl.exe", "service/setup.ps1", "START.bat"].every(isInstallablePath)).toBe(true);
    expect(["data/.env", "app", "app/", "app//x", "./app/x", "x.bat", "app/./x"].some(isInstallablePath)).toBe(false);
  });
});
