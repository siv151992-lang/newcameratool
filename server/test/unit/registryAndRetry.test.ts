import { describe, expect, it } from "vitest";
import { createRegistry } from "../../src/integrations/registry.js";
import { CameraApiError } from "../../src/integrations/types.js";
import { mapWithConcurrency, sleep } from "../../src/lib/concurrency.js";
import { withRetry } from "../../src/monitoring/checkService.js";

describe("brand registry", () => {
  const registry = createRegistry();

  it("selects the Hikvision adapter", () => {
    expect(registry.get("hikvision").meta.displayName).toBe("Hikvision");
    expect(registry.resolveKey("HIKVISION")).toBe("hikvision");
    expect(registry.resolveKey("Hik")).toBe("hikvision");
  });

  it("refuses planned and unknown brands", () => {
    registry.registerPlanned({
      key: "acme", displayName: "Acme", supportStatus: "planned", authMethods: [], defaultPorts: { http: 80, https: 443 },
      capabilities: [], notes: "",
    });
    expect(registry.isSupported("acme")).toBe(false);
    expect(registry.resolveKey("ACME")).toBe("acme");
    expect(() => registry.get("acme")).toThrow(/planned/);
    expect(() => registry.get("nonexistent")).toThrow(CameraApiError);
  });
});

describe("withRetry", () => {
  const noWait = async () => undefined;

  it("retries transient errors up to the limit", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new CameraApiError("TIMEOUT", "t", { transient: true });
      }, { maxRetries: 2, baseDelayMs: 1, sleep: noWait }),
    ).rejects.toMatchObject({ code: "TIMEOUT", attempts: 3 });
    expect(calls).toBe(3);
  });

  it("does not retry authentication failures", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new CameraApiError("AUTH_FAILED", "no");
      }, { maxRetries: 3, baseDelayMs: 1, sleep: noWait }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(calls).toBe(1);
  });

  it("returns after a transient failure recovers, with backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    const r = await withRetry(async () => {
      if (++calls < 3) throw new CameraApiError("UNREACHABLE", "x", { transient: true });
      return "ok";
    }, { maxRetries: 3, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) });
    expect(r).toEqual({ value: "ok", attempts: 3 });
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and keeps order", async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await sleep(10);
      inFlight--;
      return n * 2;
    });
    expect(max).toBe(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });
});
