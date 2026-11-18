import { sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkPackage, compareVersions, isInstallablePath, UpdatePackageError } from "../../src/update/packageFile.js";
import { buildPackage, cleanUpdateFixtures, keyPair, nextId, tmp, zipFolder } from "../updateFixtures.js";

afterAll(cleanUpdateFixtures);

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
      const dir = join(tmp, `forged-${nextId()}`, "cctv-monitor");
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
    const dir = join(tmp, `plain-${nextId()}`, "cctv-monitor");
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
