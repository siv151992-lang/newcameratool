import { z, ZodError } from "zod";
import { HttpError } from "./errors.js";

// A field left out says so plainly, as before ("Required" rather than "Invalid input: expected string, received undefined").
z.config({ customError: (issue) => (issue.code === "invalid_type" && issue.input === undefined ? "Required" : undefined) });

export function formatZodError(err: ZodError) {
  return err.issues.map((i) => ({ field: i.path.join(".") || "body", message: i.message }));
}

/** Parses input against a schema, throwing a 400 with field-level details on failure. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = formatZodError(result.error);
    throw new HttpError(400, "VALIDATION_ERROR", details[0] ? `${details[0].field}: ${details[0].message}` : "Invalid request", details);
  }
  return result.data;
}

type Undefaulted<T> = T extends z.ZodOptional<infer I> ? Undefaulted<I> : T extends z.ZodDefault<infer I> ? I : T;
type PatchShape<S extends z.ZodRawShape> = { [K in keyof S]: z.ZodOptional<Undefaulted<S[K]>> };

/**
 * The schema of an update (PATCH): every field optional and without its default, so a field left
 * out stays as it is. (Zod's own .partial() keeps the defaults: a camera saved with only a new
 * certificate would have its protocol reset to the default, for one.) Unknown keys are treated as
 * the schema treats them (refused when it is strict).
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>): z.ZodObject<PatchShape<S>> {
  const undefaulted = (t: z.ZodType): z.ZodType => (t instanceof z.ZodOptional ? undefaulted(t.unwrap() as z.ZodType) : t instanceof z.ZodDefault ? (t.unwrap() as z.ZodType) : t);
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, undefaulted(v as z.ZodType).optional()]));
  const out = z.object(shape);
  const catchall = schema.def.catchall;
  return (catchall ? out.catchall(catchall) : out) as unknown as z.ZodObject<PatchShape<S>>;
}

/** Route parameter as a single string (Express 5 types allow arrays for wildcard params). */
export function param(req: { params: Record<string, string | string[] | undefined> }, name = "id"): string {
  const v = req.params[name];
  return Array.isArray(v) ? v.join("/") : (v ?? "");
}
