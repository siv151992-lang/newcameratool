import { describe, expect, it } from "vitest";
import { startupHint } from "../../src/lib/startupHint.js";

describe("startupHint", () => {
  it("explains a database password mismatch and how to fix it", () => {
    const err = Object.assign(new Error('password authentication failed for user "cctv"'), { code: "28P01" });
    expect(startupHint(err)).toMatch(/put the original value back in \.env/);
    expect(startupHint(err)).toMatch(/docker compose down -v/);
  });

  it("covers a missing or unreachable database, and stays quiet otherwise", () => {
    expect(startupHint({ code: "3D000" })).toMatch(/does not exist/);
    expect(startupHint({ code: "ECONNREFUSED" })).toMatch(/could not be reached/);
    expect(startupHint(new Error("something else"))).toBeUndefined();
    expect(startupHint(null)).toBeUndefined();
  });
});
