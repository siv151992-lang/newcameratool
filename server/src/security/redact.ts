/** Removes credentials from strings that may end up in errors, logs or API responses. */
export function redactSecrets(text: string, secrets: (string | undefined)[] = []): string {
  let out = text
    .replace(/(authorization:\s*)(digest|basic)\s+[^\r\n]*/gi, "$1$2 [REDACTED]")
    .replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, "//[REDACTED]@");
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join("[REDACTED]");
  }
  return out;
}
