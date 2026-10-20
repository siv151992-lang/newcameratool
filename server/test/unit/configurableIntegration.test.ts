import { describe, expect, it } from "vitest";
import { ConfigurableAdapter } from "../../src/integrations/configurable/adapter.js";
import type { CameraHttpClient, CameraRequest } from "../../src/integrations/http/cameraHttpClient.js";
import { integrationConfigSchema, mappingPathError, type IntegrationConfigInput } from "../../src/integrations/configurable/config.js";
import { assertUsable, mapStorage, MappingError, parseBody, resolvePath } from "../../src/integrations/configurable/mapping.js";

const GiB = 1024 ** 3;

export const jsonConfig = (over: Partial<IntegrationConfigInput> = {}): IntegrationConfigInput => ({
  request: { method: "GET", path: "/api/v1/storage", query: [], headers: [], timeoutMs: 5000 },
  auth: { type: "digest" },
  response: {
    format: "json",
    devicesPath: "data.disks[*]",
    fields: { id: "id", name: "label", total: { path: "capacityMB", unit: "MiB" }, free: { path: "freeMB", unit: "MiB" }, health: "state" },
    healthValues: { healthy: ["ok"], degraded: ["formatting"], unhealthy: ["error"], absent: ["absent"] },
    readWriteValues: { readWrite: [], readOnly: [] },
  },
  ...over,
});

const parse = (c: IntegrationConfigInput) => integrationConfigSchema.parse(c);

describe("integration config validation", () => {
  it("accepts a complete JSON configuration and fills defaults", () => {
    const c = parse(jsonConfig());
    expect(c.pagination).toEqual({ type: "none" });
    expect(c.maxConcurrency).toBe(5);
    expect(c.deviceInfo).toBeNull();
  });

  it("refuses absolute URLs, path tricks, query strings in the path and code-like mapping paths", () => {
    const bad = (path: string) => integrationConfigSchema.safeParse(jsonConfig({ request: { method: "GET", path, query: [], headers: [], timeoutMs: 5000 } })).success;
    for (const p of ["http://evil.example/x", "//evil.example/x", "/a/../b", "/x?y=1", "relative", "/a b"]) expect(bad(p), p).toBe(false);
    expect(bad("/ISAPI/ContentMgmt/Storage")).toBe(true);
    for (const p of ["a.__proto__", "constructor", "a;b", "a.b()", "x[-1]", "$..book"]) expect(mappingPathError(p), p).not.toBeNull();
    for (const p of ["data.disks[*]", "hddList.hdd", "@id", "#text", "a.b[0].c", "$.data.disks[*]"]) expect(mappingPathError(p), p).toBeNull();
  });

  it("refuses credential and framing headers, and requires a key name for API keys", () => {
    const withHeader = (name: string) =>
      integrationConfigSchema.safeParse(jsonConfig({ request: { method: "GET", path: "/x", query: [], headers: [{ name, value: "v" }], timeoutMs: 5000 } })).success;
    for (const h of ["Authorization", "Cookie", "Host", "X-Forwarded-For", "Content-Length", "bad header"]) expect(withHeader(h), h).toBe(false);
    expect(withHeader("X-Requested-With")).toBe(true);
    expect(integrationConfigSchema.safeParse(jsonConfig({ auth: { type: "api_key" } })).success).toBe(false);
    expect(integrationConfigSchema.safeParse(jsonConfig({ auth: { type: "api_key", apiKeyIn: "header", apiKeyName: "X-API-Key" } })).success).toBe(true);
  });

  it("requires total capacity and free or used capacity", () => {
    const c = jsonConfig();
    const r = integrationConfigSchema.safeParse({ ...c, response: { ...c.response, fields: { total: { path: "t", unit: "B" } } } });
    expect(r.success).toBe(false);
  });
});

describe("JSON response mapping", () => {
  const body = JSON.stringify({
    data: {
      disks: [
        { id: "sd1", label: "SD card", capacityMB: 122_000, freeMB: 22_000, state: "ok" },
        { id: "sd2", label: "Slot 2", capacityMB: 0, freeMB: 0, state: "absent" },
        { id: "nas", label: "NAS", capacityMB: "1000000", freeMB: "900000", state: "formatting" },
      ],
    },
  });

  it("normalises devices to bytes, skips empty slots and aggregates", () => {
    const c = parse(jsonConfig());
    const m = mapStorage(parseBody(body, "json"), c.response);
    expect(m.errors).toEqual([]);
    expect(m.missing).toEqual([]);
    expect(m.devices[1]!.skipped).toMatch(/no disk/);
    const devices = m.devices.flatMap((d) => (d.device ? [d.device] : []));
    expect(devices.map((d) => [d.id, d.healthStatus])).toEqual([["sd1", "healthy"], ["nas", "degraded"]]);
    expect(m.reading.devices[0]).toMatchObject({ totalBytes: 122_000 * 1024 ** 2, freeBytes: 22_000 * 1024 ** 2, usedBytes: 100_000 * 1024 ** 2 });
    expect(m.reading.totalBytes).toBe(1_122_000 * 1024 ** 2);
    expect(assertUsable(m).usedPercentage).toBeCloseTo((200_000 / 1_122_000) * 100, 1);
  });

  it("reports invalid, negative and inconsistent numbers instead of guessing", () => {
    const c = parse(jsonConfig());
    const bad = JSON.stringify({ data: { disks: [{ id: "a", capacityMB: "-5", freeMB: 1, state: "ok" }, { id: "b", capacityMB: 10, freeMB: 20, state: "ok" }, { id: "c", capacityMB: "1e9", freeMB: 1, state: "ok" }] } });
    const m = mapStorage(parseBody(bad, "json"), c.response);
    expect(m.errors).toEqual([
      'Device 1: Total capacity "-5" is not a non-negative number',
      "Device 2: free capacity is larger than total capacity",
      'Device 3: Total capacity "1e9" is not a non-negative number',
    ]);
    expect(() => assertUsable(m)).toThrow(MappingError);
  });

  it("derives free from used only when total and used are both reported", () => {
    const c = jsonConfig();
    const cfg = parse({ ...c, response: { ...c.response, fields: { total: { path: "t", unit: "GiB" }, used: { path: "u", unit: "GiB" } } } });
    const m = mapStorage({ data: { disks: { t: "64", u: "16" } } }, cfg.response);
    expect(m.reading).toMatchObject({ totalBytes: 64 * GiB, freeBytes: 48 * GiB, usedBytes: 16 * GiB, usedPercentage: 25 });
  });

  it("names the missing fields and the empty device path", () => {
    const c = parse(jsonConfig());
    expect(mapStorage({ data: {} }, c.response).missing).toEqual(['No storage devices found at "data.disks[*]"']);
    const m = mapStorage({ data: { disks: [{ id: "x", state: "ok" }] } }, c.response);
    expect(m.missing).toEqual(["Total capacity", "Free capacity"]);
    expect(m.devices[0]!.fields.find((f) => f.field === "Total capacity")!.error).toBe("Not found");
  });

  it("rejects malformed JSON", () => {
    expect(() => parseBody("{oops", "json")).toThrow(/not valid JSON/);
    expect(() => parseBody("", "json")).toThrow(/empty/);
  });
});

describe("XML response mapping", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <ns:StorageInfo xmlns:ns="urn:vendor">
    <Disks>
      <Disk index="1"><Name>SD</Name><TotalGB>119.2</TotalGB><FreeGB>20.5</FreeGB><Status>Normal</Status><Mode>RW</Mode></Disk>
      <Disk index="2"><Name>NAS</Name><TotalGB>500</TotalGB><FreeGB>100</FreeGB><Status>Error</Status><Mode>RO</Mode></Disk>
    </Disks>
  </ns:StorageInfo>`;
  const cfg = parse(
    jsonConfig({
      response: {
        format: "xml",
        devicesPath: "StorageInfo.Disks.Disk",
        fields: { id: "@index", name: "Name", total: { path: "TotalGB", unit: "GB" }, free: { path: "FreeGB", unit: "GB" }, health: "Status", readWrite: "Mode" },
        healthValues: { healthy: ["normal"], degraded: [], unhealthy: ["error"], absent: [] },
        readWriteValues: { readWrite: ["RW"], readOnly: ["RO"] },
      },
    }),
  );

  it("maps elements and attributes, ignoring namespace prefixes", () => {
    const m = mapStorage(parseBody(xml, "xml"), cfg.response);
    expect(m.errors).toEqual([]);
    const d = m.devices.map((x) => x.device!);
    expect(d.map((x) => [x.id, x.name, x.totalBytes, x.healthStatus, x.writable])).toEqual([
      ["1", "SD", 119_200_000_000, "healthy", true],
      ["2", "NAS", 500_000_000_000, "unhealthy", false],
    ]);
  });

  it("treats a single element as a one-device list", () => {
    const one = xml.replace(/<Disk index="2">[\s\S]*?<\/Disk>/, "");
    expect(mapStorage(parseBody(one, "xml"), cfg.response).devices).toHaveLength(1);
  });

  it("refuses DOCTYPE/entity declarations and malformed XML", () => {
    expect(() => parseBody(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>`, "xml")).toThrow(/DOCTYPE/);
    expect(() => parseBody("<a><b></a>", "xml")).toThrow(/not well-formed/);
  });
});

describe("resolvePath", () => {
  it("only follows own properties", () => {
    expect(resolvePath({}, "toString")).toEqual([]);
    expect(resolvePath({ a: [{ b: 1 }, { b: 2 }] }, "a[*].b")).toEqual([1, 2]);
    expect(resolvePath({ a: [{ b: 1 }, { b: 2 }] }, "a[1].b")).toEqual([2]);
  });
});

describe("configurable adapter authentication", () => {
  const camera = (protocol: "http" | "https") => ({ host: "10.10.15.5", port: 443, protocol, username: "svc", password: "s3cret-key-123", timeoutMs: 5000 });
  const body = JSON.stringify({ data: { disks: [{ id: "a", capacityMB: 100, freeMB: 50, state: "ok" }] } });
  const fakeHttp = (status = 200) => {
    const calls: CameraRequest[] = [];
    const http = { request: async (_c: unknown, req: CameraRequest) => (calls.push(req), { status, headers: {}, body }) } as unknown as CameraHttpClient;
    return { http, calls };
  };
  const adapter = (http: CameraHttpClient, auth: IntegrationConfigInput["auth"]) =>
    new ConfigurableAdapter(http, { key: "x", displayName: "X", version: "1", versionNumber: 1, defaultPorts: { http: 80, https: 443 } }, parse(jsonConfig({ auth })));

  it("sends an API key in a header or query parameter, never in error messages", async () => {
    const h = fakeHttp();
    await adapter(h.http, { type: "api_key", apiKeyIn: "header", apiKeyName: "X-API-Key" }).getStorageStatus(camera("https"));
    expect(h.calls[0]!.headers).toMatchObject({ "X-API-Key": "s3cret-key-123" });
    expect(h.calls[0]!.auth).toBe("none");

    const q = fakeHttp(500);
    const err = await adapter(q.http, { type: "api_key", apiKeyIn: "query", apiKeyName: "token" }).getStorageStatus(camera("https")).catch((e) => e);
    expect(q.calls[0]!.path).toBe("/api/v1/storage?token=s3cret-key-123");
    expect(err.message).toContain("token=%5BREDACTED%5D");
    expect(err.message).not.toContain("s3cret");
  });

  it("sends bearer and Basic credentials up front, only over HTTPS; Digest answers challenges", async () => {
    const b = fakeHttp();
    await adapter(b.http, { type: "bearer" }).getStorageStatus(camera("https"));
    expect(b.calls[0]!.auth).toEqual({ authorization: "Bearer s3cret-key-123" });
    for (const type of ["bearer", "basic", "api_key"] as const) {
      const auth = type === "api_key" ? { type, apiKeyIn: "header" as const, apiKeyName: "X-Key" } : { type };
      await expect(adapter(fakeHttp().http, auth).getStorageStatus(camera("http"))).rejects.toMatchObject({ code: "AUTH_METHOD_INSECURE" });
    }
    const d = fakeHttp();
    await adapter(d.http, { type: "digest" }).getStorageStatus(camera("http"));
    expect(d.calls[0]!.auth).toBe("digest");
  });

  it("classifies unparseable replies and mapping failures for the test report", async () => {
    const http = { request: async () => ({ status: 200, headers: {}, body: "not json" }) } as unknown as CameraHttpClient;
    await expect(adapter(http, { type: "digest" }).getStorageStatus(camera("http"))).rejects.toMatchObject({ code: "INVALID_RESPONSE", options: { kind: "format" } });
    const empty = { request: async () => ({ status: 200, headers: {}, body: "{}" }) } as unknown as CameraHttpClient;
    await expect(adapter(empty, { type: "digest" }).getStorageStatus(camera("http"))).rejects.toMatchObject({ options: { kind: "no_storage" } });
  });
});
