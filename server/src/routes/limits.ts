import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";

const common = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === "test",
};
const msg = (message: string) => ({ error: { code: "RATE_LIMITED", message } });

export const loginLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 20, message: msg("Too many sign-in attempts. Try again in a few minutes.") });
// Connection tests and manual checks make requests to devices on the network.
export const deviceLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 60, message: msg("Too many device requests. Slow down and try again.") });
export const importLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 30, message: msg("Too many import requests. Try again shortly.") });
export const apiLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 600, message: msg("Too many requests.") });
