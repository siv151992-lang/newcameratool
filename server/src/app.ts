import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";
import { ZodError } from "zod";
import { authenticate, requireAuth, requireCsrf } from "./auth/middleware.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { CameraApiError } from "./integrations/types.js";
import { HttpError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { formatZodError } from "./lib/validate.js";
import { auditRouter, brandsRouter, settingsRouter, usersRouter } from "./routes/admin.js";
import { aiRouter } from "./routes/ai.js";
import { alertsRouter } from "./routes/alerts.js";
import { authRouter } from "./routes/auth.js";
import { camerasRouter } from "./routes/cameras.js";
import { integrationsRouter } from "./routes/integrations.js";
import { apiLimiter } from "./routes/limits.js";

const here = dirname(fileURLToPath(import.meta.url));

function trustProxyValue(v: string): boolean | number | string {
  if (v === "true") return true;
  if (v === "false") return false;
  return /^\d+$/.test(v) ? Number(v) : v;
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxyValue(config.TRUST_PROXY));

  // Minimal access log: never bodies, headers or query strings (which could carry secrets).
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      if (req.path === "/api/health") return;
      logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start }, "request");
    });
    next();
  });

  app.get("/api/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  // API docs (OpenAPI 3). Served with a relaxed CSP that only applies to this path.
  const specPath = join(here, "openapi.yaml");
  if (existsSync(specPath)) {
    const spec = YAML.parse(readFileSync(specPath, "utf8"));
    app.get("/api/openapi.json", (_req, res) => res.json(spec));
    app.use("/api/docs", helmet({ contentSecurityPolicy: { directives: { "script-src": ["'self'", "'unsafe-inline'"] } } }), swaggerUi.serve, swaggerUi.setup(spec));
  }

  app.use(helmet({ crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use("/api", apiLimiter, authenticate);

  app.use("/api/auth", authRouter);
  const protectedApi = express.Router();
  protectedApi.use(requireAuth, requireCsrf);
  protectedApi.use("/cameras", camerasRouter);
  protectedApi.use("/alerts", alertsRouter);
  protectedApi.use("/brands", brandsRouter);
  protectedApi.use("/integrations", integrationsRouter);
  protectedApi.use("/settings", settingsRouter);
  protectedApi.use("/users", usersRouter);
  protectedApi.use("/audit", auditRouter);
  protectedApi.use("/ai", aiRouter);
  app.use("/api", protectedApi);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Unknown API endpoint")));

  // Serve the built web app in production (same origin keeps cookies and CSRF simple).
  const webDist = config.WEB_DIST_DIR ? resolve(config.WEB_DIST_DIR) : undefined;
  if (webDist && existsSync(join(webDist, "index.html"))) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid request", details: formatZodError(err) } });
      return;
    }
    if (err instanceof CameraApiError) {
      res.status(422).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e.type === "entity.parse.failed" || e.type === "entity.too.large") {
      res.status(e.status ?? 400).json({ error: { code: "BAD_REQUEST", message: e.type === "entity.too.large" ? "Request too large" : "Malformed JSON" } });
      return;
    }
    logger.error({ err: e.message }, "Unhandled error");
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
  });

  return app;
}
