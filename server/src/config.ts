import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";

// Reads server/.env or the repository-root .env (real environment variables take precedence).
dotenv.config({ path: [".env", "../.env"], quiet: true });

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? def : v === "true" || v === "1"));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // File holding the database password (Docker Compose generates one); added to DATABASE_URL.
  DATABASE_PASSWORD_FILE: z.string().optional(),
  // Connections per process. The worker needs more with many concurrent checks (see operations.md).
  DATABASE_POOL_SIZE: z.coerce.number().int().min(2).max(200).default(15),
  // base64-encoded 32-byte keys. CREDENTIAL_ENCRYPTION_KEYS allows rotation: "2:<key>,1:<oldkey>".
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  CREDENTIAL_ENCRYPTION_KEYS: z.string().optional(),
  CREDENTIAL_KEY_VERSION: z.coerce.number().int().positive().default(1),
  // Used when no key is set above: read from here, or generated here on first start.
  CREDENTIAL_KEY_FILE: z.string().default("data/credential.key"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: bool(true),
  TRUST_PROXY: z.string().default("loopback"),
  // Networks cameras may live on. Requests to any other address are refused (SSRF protection).
  CAMERA_ALLOWED_NETWORKS: z.string().default("10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"),
  // Development only: lets the mock camera on 127.0.0.1 be registered.
  CAMERA_ALLOW_LOOPBACK: bool(false),
  WEB_DIST_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default("cctv-monitor@localhost"),
  PUBLIC_URL: z.string().optional(),
  // AI Mode assistant and report summaries (optional). Without a key, AI Mode still shows the
  // statistical forecasts, anomalies and recommendations; only the assistant is unavailable.
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("claude-opus-5-5"),
  AI_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  BOOTSTRAP_ADMIN_USERNAME: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

/** Returns `url` with the password replaced by the (trimmed) contents of `file`. */
export function withPasswordFromFile(url: string, file: string): string {
  const password = readFileSync(file, "utf8").trim();
  if (!password) throw new Error(`DATABASE_PASSWORD_FILE ${file} is empty`);
  const parsed = new URL(url);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

function load(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  if (parsed.data.CAMERA_ALLOW_LOOPBACK && parsed.data.NODE_ENV === "production") {
    throw new Error("CAMERA_ALLOW_LOOPBACK must not be enabled in production");
  }
  if (parsed.data.DATABASE_PASSWORD_FILE) {
    parsed.data.DATABASE_URL = withPasswordFromFile(parsed.data.DATABASE_URL, parsed.data.DATABASE_PASSWORD_FILE);
  }
  return parsed.data;
}

export const config = load();
