import pino from "pino";
import { config } from "../config.js";

// Request bodies are never logged. These paths are redacted defensively in case
// an object containing secrets is passed to the logger by mistake.
export const logger = pino({
  level: config.NODE_ENV === "test" ? "silent" : config.LOG_LEVEL,
  redact: {
    paths: [
      "password", "*.password", "*.*.password", "newPassword", "currentPassword",
      "authorization", "*.authorization", "headers.authorization", "headers.cookie",
      "cookie", "*.cookie", "rows", "*.rows", "passwordEncrypted", "*.passwordEncrypted",
    ],
    censor: "[REDACTED]",
  },
});
