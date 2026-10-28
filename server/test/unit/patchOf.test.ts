import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parse, patchOf } from "../../src/lib/validate.js";
import { cameraUpdateSchema } from "../../src/services/cameraService.js";
import { channelUpdateSchema } from "../../src/services/notificationChannelService.js";

describe("update (PATCH) schemas", () => {
  const base = z.object({ protocol: z.enum(["http", "https"]).default("http"), port: z.number().optional(), enabled: z.boolean().default(true).optional() });

  it("leave out what was not sent: no defaults filled in", () => {
    expect(patchOf(base).parse({})).toEqual({});
    expect(patchOf(base).parse({ port: 80 })).toEqual({ port: 80 });
    expect(patchOf(base).parse({ protocol: "https" })).toEqual({ protocol: "https" });
    // Still checked.
    expect(patchOf(base).safeParse({ protocol: "ftp" }).success).toBe(false);
  });

  it("keep the schema's strictness", () => {
    expect(patchOf(base).parse({ other: 1 })).toEqual({});
    expect(patchOf(base.strict()).safeParse({ other: 1 }).success).toBe(false);
  });

  it("a camera saved with only a new certificate keeps its protocol, port and the rest", () => {
    expect(parse(cameraUpdateSchema, { caCertificate: null })).toEqual({ caCertificate: null });
    expect(parse(cameraUpdateSchema, { name: "Gate" })).toEqual({ name: "Gate" });
  });

  it("a notification channel renamed keeps its severity, cooldown and enabled state", () => {
    expect(parse(channelUpdateSchema, { name: "Ops" })).toEqual({ name: "Ops" });
  });

  it("a missing field says Required", () => {
    expect(() => parse(z.object({ name: z.string() }), {})).toThrow("name: Required");
  });
});
