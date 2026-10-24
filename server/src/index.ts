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
import { refreshPasswordIssues } from "./services/cameraPasswordPolicy.js";
import { detectDashboardAddress } from "./services/dashboardAddress.js";
import { attachLiveVideo } from "./services/liveVideoProxy.js";
import { startReplayRelay } from "./services/rtspReplayRelay.js";

async function main() {
  getCipher(); // fail fast if the encryption key is missing or malformed
  await migrate(pool, (m) => logger.info(m));
  await syncBrands(registry);
  await bootstrapAdmin();
  await refreshPasswordIssues().catch((err) => logger.warn({ err: (err as Error).message }, "Could not check camera passwords against the policy"));
  await detectDashboardAddress().catch((err) => logger.warn({ err: (err as Error).message }, "Could not fill in the dashboard address"));
  if (config.CAMERA_ALLOW_LOOPBACK) logger.warn("CAMERA_ALLOW_LOOPBACK is enabled: loopback camera addresses are allowed (development only)");
  if (!config.COOKIE_SECURE) logger.warn("COOKIE_SECURE=false: session cookies will be sent over plain HTTP. Use HTTPS in production.");
  // Other API instances or the worker may change integrations: reload them periodically too.
  setInterval(() => void registry.refresh().catch((err) => logger.warn({ err: (err as Error).message }, "Could not reload brand integrations")), 30_000).unref();
  const server = createApp().listen(config.PORT, () => logger.info({ port: config.PORT }, "API listening"));
  attachLiveVideo(server);
  if (config.LIVE_VIDEO_URL) {
    await startReplayRelay(Number(new URL(config.PLAYBACK_RELAY_URL).port)).catch((err) =>
      logger.warn({ err: (err as Error).message }, "Could not start the recording playback relay: ONVIF recordings will not play"),
    );
  }
  // With thousands of cameras the first AI analysis takes a while: start it now, not on the first visit.
  setTimeout(() => {
    void (async () => {
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM organizations WHERE is_active");
      for (const { id } of rows) if ((await getAiSettings(id)).enabled) await getFleetInsights(id);
    })().catch((err) => logger.warn({ err: (err as Error).message }, "Could not prepare AI insights"));
  }, 10_000).unref();
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal({ err: err.message, hint: startupHint(err) }, "API failed to start");
  process.exit(1);
});
