import { getAiSettings } from "./ai/aiSettings.js";
import { getFleetInsights } from "./ai/insightsService.js";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { registry } from "./integrations/registry.js";
import { logger } from "./lib/logger.js";
import { startupHint } from "./lib/startupHint.js";
import { getCipher } from "./security/cipher.js";
import { syncBrands } from "./services/brandService.js";
import { bootstrapAdmin } from "./services/bootstrap.js";

async function main() {
  getCipher(); // fail fast if the encryption key is missing or malformed
  await migrate(pool, (m) => logger.info(m));
  await syncBrands(registry);
  await bootstrapAdmin();
  if (config.CAMERA_ALLOW_LOOPBACK) logger.warn("CAMERA_ALLOW_LOOPBACK is enabled: loopback camera addresses are allowed (development only)");
  if (!config.COOKIE_SECURE) logger.warn("COOKIE_SECURE=false: session cookies will be sent over plain HTTP. Use HTTPS in production.");
  // Other API instances or the worker may change integrations: reload them periodically too.
  setInterval(() => void registry.refresh().catch((err) => logger.warn({ err: (err as Error).message }, "Could not reload brand integrations")), 30_000).unref();
  const server = createApp().listen(config.PORT, () => logger.info({ port: config.PORT }, "API listening"));
  // With thousands of cameras the first AI analysis takes a while: start it now, not on the first visit.
  setTimeout(() => {
    void getAiSettings()
      .then((s) => (s.enabled ? getFleetInsights() : undefined))
      .catch((err) => logger.warn({ err: (err as Error).message }, "Could not prepare AI insights"));
  }, 10_000).unref();
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal({ err: err.message, hint: startupHint(err) }, "API failed to start");
  process.exit(1);
});
