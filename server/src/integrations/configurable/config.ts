import { z } from "zod";

/**
 * Declarative configuration of a "configurable API" integration (Mode A). It describes one HTTP
 * request, how it authenticates, and how fields of the XML or JSON reply map onto the normalised
 * storage model. Everything is data: paths are plain dotted paths, never code, and the config
 * holds no secrets (a camera's password, API key or token is stored encrypted with the camera).
 */

export const AUTH_TYPES = ["none", "basic", "digest", "api_key", "bearer"] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

/** What a camera using the integration must store: username + password, one secret, or nothing. */
export type CredentialMode = "user_password" | "secret" | "none";
export function credentialModeFor(auth: AuthType): CredentialMode {
  if (auth === "basic" || auth === "digest") return "user_password";
  if (auth === "api_key" || auth === "bearer") return "secret";
  return "none";
}

export const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 } as const;
export type Unit = keyof typeof UNITS;

/** Headers the integration may never set: they carry credentials, framing or routing. */
const FORBIDDEN_HEADERS = new Set([
  "host", "authorization", "proxy-authorization", "cookie", "set-cookie", "content-length", "transfer-encoding",
  "connection", "upgrade", "te", "trailer", "expect", "keep-alive", "forwarded", "via",
]);
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const SAFE_VALUE = /^[\x20-\x7E]{0,256}$/;

const PATH_SEGMENT = /^[A-Za-z_@#$][A-Za-z0-9_\-@#:$]*(\[(\d{1,4}|\*)\])?$/;
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** A JSONPath-style "$." or "$" prefix means the root and is accepted for familiarity. */
export const stripRoot = (path: string) => (path === "$" ? "" : path.startsWith("$.") ? path.slice(2) : path);

/** Validates a mapping path such as `data.disks[*]`, `hddList.hdd` or `@id`. "" means the element itself. */
export function mappingPathError(input: string): string | null {
  const path = stripRoot(input);
  if (path === "") return null;
  if (path.length > 200) return "Path is too long";
  const segments = path.split(".");
  if (segments.length > 12) return "Path has too many levels (12 at most)";
  for (const s of segments) {
    if (!PATH_SEGMENT.test(s)) return `"${s}" is not a valid path segment (use names, [0] or [*])`;
    if (BLOCKED_KEYS.has(s.replace(/\[.*$/, ""))) return `"${s}" is not allowed in a path`;
  }
  return null;
}

const mappingPath = z
  .string()
  .trim()
  .superRefine((v, ctx) => {
    const e = mappingPathError(v);
    if (e) ctx.addIssue({ code: "custom", message: e });
  });

const optionalPath = mappingPath.optional().transform((v) => (v ? v : undefined));

const numericField = z
  .object({ path: mappingPath.refine((v) => v !== "", "Path is required"), unit: z.enum(Object.keys(UNITS) as [Unit, ...Unit[]]).default("B") })
  .strict();

const stringList = z.array(z.string().trim().min(1).max(64)).max(40).default([]);

const nameValue = z.object({ name: z.string().trim(), value: z.string() }).strict();

const requestPath = z
  .string()
  .trim()
  .min(1, "Endpoint path is required")
  .max(512)
  .superRefine((v, ctx) => {
    if (!v.startsWith("/") || v.startsWith("//")) ctx.addIssue({ code: "custom", message: "Path must start with a single / (only the path: the camera's address is added for each camera)" });
    else if (/[?#]/.test(v)) ctx.addIssue({ code: "custom", message: "Put query parameters in the query list, not in the path" });
    else if (!/^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(v)) ctx.addIssue({ code: "custom", message: "Path contains characters that are not allowed" });
    else if (v.split("/").some((s) => s === ".." || s === ".")) ctx.addIssue({ code: "custom", message: "Path must not contain . or .. segments" });
  });

const queryList = z
  .array(nameValue)
  .max(20)
  .default([])
  .superRefine((list, ctx) => {
    list.forEach((q, i) => {
      if (!/^[A-Za-z0-9_.\-[\]]{1,64}$/.test(q.name)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `Query parameter name "${q.name}" is not valid` });
      if (!SAFE_VALUE.test(q.value)) ctx.addIssue({ code: "custom", path: [i, "value"], message: "Query values must be printable text (256 characters at most)" });
    });
  });

const requestSchema = z
  .object({
    method: z.enum(["GET", "POST"]).default("GET"),
    path: requestPath,
    query: queryList,
    headers: z
      .array(nameValue)
      .max(20)
      .default([])
      .superRefine((list, ctx) => {
        list.forEach((h, i) => {
          if (!TOKEN.test(h.name)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `Header name "${h.name}" is not valid` });
          else if (FORBIDDEN_HEADERS.has(h.name.toLowerCase()) || /^(proxy-|x-forwarded-)/i.test(h.name)) {
            ctx.addIssue({ code: "custom", path: [i, "name"], message: `The ${h.name} header cannot be configured (credentials come from the camera, framing from the client)` });
          }
          if (!SAFE_VALUE.test(h.value)) ctx.addIssue({ code: "custom", path: [i, "value"], message: "Header values must be printable text (256 characters at most)" });
        });
      }),
    body: z.string().max(16_384).optional().nullable().transform((v) => (v ? v : null)),
    contentType: z.string().trim().max(100).regex(/^[\w.+-]+\/[\w.+-]+(;\s*[\w-]+=[\w.-]+)?$/, "Not a valid content type").optional().nullable(),
    timeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.body && r.method !== "POST") ctx.addIssue({ code: "custom", path: ["body"], message: "A request body needs the POST method" });
  });

const authSchema = z
  .object({
    type: z.enum(AUTH_TYPES),
    apiKeyIn: z.enum(["header", "query"]).optional(),
    apiKeyName: z.string().trim().optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.type !== "api_key") return;
    if (!a.apiKeyIn) ctx.addIssue({ code: "custom", path: ["apiKeyIn"], message: "Choose whether the API key is sent in a header or a query parameter" });
    const name = a.apiKeyName ?? "";
    const valid = a.apiKeyIn === "query" ? /^[A-Za-z0-9_.-]{1,64}$/.test(name) : TOKEN.test(name) && !FORBIDDEN_HEADERS.has(name.toLowerCase());
    if (!valid) ctx.addIssue({ code: "custom", path: ["apiKeyName"], message: "Enter a valid header or parameter name for the API key, e.g. X-API-Key" });
  });

const paginationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("page"),
      pageParam: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,64}$/, "Not a valid parameter name"),
      firstPage: z.union([z.literal(0), z.literal(1)]).default(1),
      pageSizeParam: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
      maxPages: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
]);

const responseSchema = z
  .object({
    format: z.enum(["json", "xml"]),
    devicesPath: mappingPath,
    fields: z
      .object({
        id: optionalPath,
        name: optionalPath,
        total: numericField,
        free: numericField.optional(),
        used: numericField.optional(),
        health: optionalPath,
        readWrite: optionalPath,
      })
      .strict()
      .superRefine((f, ctx) => {
        if (!f.free && !f.used) ctx.addIssue({ code: "custom", path: ["free"], message: "Map free capacity or used capacity (or both)" });
      }),
    healthValues: z.object({ healthy: stringList, degraded: stringList, unhealthy: stringList, absent: stringList }).strict(),
    readWriteValues: z.object({ readWrite: stringList, readOnly: stringList }).strict().default({ readWrite: [], readOnly: [] }),
  })
  .strict();

const deviceInfoSchema = z
  .object({
    path: requestPath,
    query: queryList,
    format: z.enum(["json", "xml"]),
    fields: z.object({ deviceName: optionalPath, model: optionalPath, serialNumber: optionalPath, firmwareVersion: optionalPath }).strict(),
  })
  .strict();

export const integrationConfigSchema = z
  .object({
    request: requestSchema,
    auth: authSchema,
    pagination: paginationSchema.default({ type: "none" }),
    response: responseSchema,
    deviceInfo: deviceInfoSchema.optional().nullable().transform((v) => v ?? null),
    maxConcurrency: z.number().int().min(1).max(20).default(5),
  })
  .strict();

export type IntegrationConfig = z.infer<typeof integrationConfigSchema>;
export type IntegrationConfigInput = z.input<typeof integrationConfigSchema>;
