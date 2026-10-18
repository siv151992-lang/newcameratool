export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new HttpError(404, "NOT_FOUND", `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "VALIDATION_ERROR", message, details);
export const conflict = (message: string, details?: unknown) => new HttpError(409, "CONFLICT", message, details);
