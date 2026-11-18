import { pool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { registry } from "./integrations/registry.js";
import { logger } from "./lib/logger.js";
import { startupHint } from "./lib/startupHint.js";
import { INSTANCE_ID } from "./monitoring/checkService.js";
import { Scheduler } from "./monitoring/scheduler.js";
import { EventStreams } from "./monitoring/eventStreams.js";
import { config } from "./config.js";
import { notifier } from "./notifications/notifier.js";
import { getCipher } from "./security/cipher.js";
import { syncBrands } from "./services/brandService.js";
import { sendDueWeeklyReports } from "./services/weeklyReportService.js";
import { backupIfDue } from "./services/backupService.js";
import { notifyHealthProblems, recordWorkerHeartbeat } from "./services/healthService.js";
import { autoCheckForUpdates } from "./services/updateService.js";

async function main() {
  getCipher(); // fail fast if the encryption key is missing
  await migrate(pool, (m) => logger.info(m));
  await syncBrands(registry);
  const scheduler = new Scheduler({ registry, notifier });
  scheduler.start();
  const streams = new EventStreams({ registry, notifier }, { max: config.CAMERA_EVENT_STREAMS_MAX });
  streams.start();
  // Weekly email reports: each organization's goes out once on its chosen day and hour.
  const reports = setInterval(() => void sendDueWeeklyReports(), 5 * 60_000);
  // The daily backup, once its hour has come (Settings → Backups).
  const backups = setInterval(() => void backupIfDue(), 5 * 60_000);
  // A heartbeat for Settings → System health: when this worker last ran.
  const beat = () => void recordWorkerHeartbeat(INSTANCE_ID).catch(() => undefined);
  beat();
  const heartbeat = setInterval(beat, 60_000);
  // Emails the system administrators when a part of the installation turns into a problem.
  const health = setInterval(() => void notifyHealthProblems().catch(() => undefined), 15 * 60_000);
  // Settings → Updates: looks for a new release once a day (nothing is downloaded or installed).
  const updates = setInterval(() => void autoCheckForUpdates().catch(() => undefined), 60 * 60_000);
  logger.info({ instance: INSTANCE_ID }, "Monitoring worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Stopping worker, waiting for in-flight checks");
    clearInterval(reports);
    clearInterval(backups);
    clearInterval(heartbeat);
    clearInterval(health);
    clearInterval(updates);
    await Promise.all([scheduler.stop(), streams.stop()]);
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err: err.message, hint: startupHint(err) }, "Worker failed to start");
  process.exit(1);
});
