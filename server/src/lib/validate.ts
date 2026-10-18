import { z, ZodError } from "zod";
import { HttpError } from "./errors.js";

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

/** Route parameter as a single string (Express 5 types allow arrays for wildcard params). */
export function param(req: { params: Record<string, string | string[] | undefined> }, name = "id"): string {
  const v = req.params[name];
  return Array.isArray(v) ? v.join("/") : (v ?? "");
}
