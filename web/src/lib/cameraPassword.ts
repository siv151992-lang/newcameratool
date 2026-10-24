import type { CameraPasswordIssue, CameraPasswordPolicy } from "../api/types";

/** Plain-language reasons; the server decides, this only explains (and previews while typing). */
export function issueLabel(issue: CameraPasswordIssue, p: CameraPasswordPolicy): string {
  switch (issue) {
    case "too_short":
      return `Shorter than ${p.minLength} characters`;
    case "few_char_types":
      return `Uses fewer than ${p.minCharTypes} of: uppercase, lowercase, numbers, symbols`;
    case "common":
      return "A default or commonly used password";
    case "contains_username":
      return "Contains the username";
    case "repetitive":
      return "Repeated or sequential characters (like 1111 or 12345)";
  }
}

const COMMON = ["12345", "123456", "12345678", "123456789", "111111", "888888", "666666", "000000", "admin", "admin123", "admin1234", "admin@123", "password", "password1", "p@ssw0rd", "hik12345", "hikvision", "dahua", "root", "user", "guest", "camera", "ipcam", "qwerty", "abc123", "welcome"];
const SEQUENCES = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

export const charTypes = (pw: string) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;

/** A preview of the server's check for the form; the server's list of common passwords is longer. */
export function previewChecks(pw: string, username: string, p: CameraPasswordPolicy): { label: string; ok: boolean }[] {
  const lower = pw.toLowerCase();
  const repetitive = /(.)\1{3,}/.test(lower) || SEQUENCES.some((a) => [a, [...a].reverse().join("")].some((s) => [...Array(s.length - 4).keys()].some((i) => lower.includes(s.slice(i, i + 5)))));
  const checks = [
    { label: `At least ${p.minLength} characters`, ok: pw.length >= p.minLength },
    { label: `At least ${p.minCharTypes} of: uppercase, lowercase, numbers, symbols`, ok: charTypes(pw) >= p.minCharTypes },
  ];
  if (p.blockCommon) {
    checks.push(
      { label: "Not a default or common password", ok: !COMMON.includes(lower) },
      { label: "Does not contain the username", ok: !(username.length >= 3 && lower.includes(username.toLowerCase())) },
      { label: "No repeated or sequential characters", ok: !repetitive },
    );
  }
  return checks;
}
