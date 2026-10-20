import { describe, expect, it } from "vitest";
import { EMPTY_CONFIG, fromConfig, toConfig } from "./shared";

describe("brand wizard configuration form", () => {
  const form = {
    ...EMPTY_CONFIG,
    path: " /api/v1/storage ",
    query: [{ name: "fmt", value: "json" }, { name: "", value: "ignored" }],
    authType: "api_key" as const,
    apiKeyIn: "header" as const,
    apiKeyName: "X-API-Key",
    devicesPath: "storage.devices",
    totalPath: "sizeMiB",
    totalUnit: "MiB" as const,
    freePath: "freeMiB",
    freeUnit: "MiB" as const,
    healthPath: "state",
    absent: "nocard, absent",
  };

  it("drops empty optional fields and splits status lists", () => {
    const c = toConfig(form);
    expect(c.request).toMatchObject({ path: "/api/v1/storage", query: [{ name: "fmt", value: "json" }], body: null, timeoutMs: 10_000 });
    expect(c.auth).toEqual({ type: "api_key", apiKeyIn: "header", apiKeyName: "X-API-Key" });
    expect(c.response.fields).toEqual({
      id: undefined, name: undefined, total: { path: "sizeMiB", unit: "MiB" }, free: { path: "freeMiB", unit: "MiB" }, used: undefined, health: "state", readWrite: undefined,
    });
    expect(c.response.healthValues.absent).toEqual(["nocard", "absent"]);
    expect(c.pagination).toEqual({ type: "none" });
    expect(c.deviceInfo).toBeNull();
  });

  it("round-trips through the form", () => {
    const c = toConfig({ ...form, pagination: "page", pageParam: "p", maxPages: "3" });
    expect(toConfig(fromConfig(c))).toEqual(c);
  });

  it("never carries credentials: the API key name only, no value", () => {
    expect(JSON.stringify(toConfig(form))).not.toMatch(/password|secret|token/i);
  });
});
