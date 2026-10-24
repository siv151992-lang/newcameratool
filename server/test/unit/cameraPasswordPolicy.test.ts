import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA_PASSWORD_POLICY as policy, passwordIssues } from "../../src/services/cameraPasswordPolicy.js";

describe("camera password policy", () => {
  it("accepts a strong password", () => {
    expect(passwordIssues("Lobby#Cam2026", "admin", policy)).toEqual([]);
    expect(passwordIssues("t7Q!mz4Rw", "operator", policy)).toEqual([]);
  });

  it("flags default, short, simple and guessable passwords", () => {
    expect(passwordIssues("12345", "admin", policy)).toEqual(["too_short", "few_char_types", "common", "repetitive"]);
    expect(passwordIssues("admin123", "admin", policy)).toEqual(["few_char_types", "common", "contains_username"]);
    expect(passwordIssues("Hik12345", "admin", policy)).toEqual(expect.arrayContaining(["common", "repetitive"]));
    expect(passwordIssues("camerapass", "admin", policy)).toEqual(["few_char_types"]);
    expect(passwordIssues("Aaaa#9xyzQ", "admin", policy)).toEqual(["repetitive"]);
    expect(passwordIssues("Qwerty#2026", "admin", policy)).toEqual(["repetitive"]);
  });

  it("follows the organization's choices", () => {
    const relaxed = { ...policy, minLength: 6, minCharTypes: 2, blockCommon: false };
    expect(passwordIssues("admin123", "admin", relaxed)).toEqual([]);
    expect(passwordIssues("abcdef", "admin", relaxed)).toEqual(["few_char_types"]);
  });
});
