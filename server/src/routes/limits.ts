import { rateLimit } from "express-rate-limit";
import { config } from "../config.js";

const common = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === "test",
};
const msg = (message: string) => ({ error: { code: "RATE_LIMITED", message } });

// Account creation and email links: each may send an email or try a token.
export const accountLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 30, message: msg("Too many requests. Try again in a few minutes.") });
export const loginLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 20, message: msg("Too many sign-in attempts. Try again in a few minutes.") });
// Connection tests and manual checks make requests to devices on the network.
export const deviceLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 60, message: msg("Too many device requests. Slow down and try again.") });
// Live view asks for a picture about once a second per open camera.
export const liveViewLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 300, message: msg("Too many live view requests. Close some live views and try again.") });
export const importLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 30, message: msg("Too many import requests. Try again shortly.") });
// Each AI question or summary calls an external, paid API.
export const aiLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 20, message: msg("Too many AI requests. Wait a minute and try again.") });
// Integration tests contact a camera with an administrator-supplied configuration.
export const integrationLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 20, message: msg("Too many integration tests. Wait a minute and try again.") });
export const apiLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 600, message: msg("Too many requests.") });
