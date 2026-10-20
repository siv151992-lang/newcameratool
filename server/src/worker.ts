import { pool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { registry } from "./integrations/registry.js";
import { logger } from "./lib/logger.js";
import { startupHint } from "./lib/startupHint.js";
import { INSTANCE_ID } from "./monitoring/checkService.js";
import { Scheduler } from "./monitoring/scheduler.js";
import { notifier } from "./notifications/notifier.js";
import { getCipher } from "./security/cipher.js";
import { syncBrands } from "./services/brandService.js";

async function main() {
  getCipher(); // fail fast if the encryption key is missing
  await migrate(pool, (m) => logger.info(m));
  await syncBrands(registry);
  const scheduler = new Scheduler({ registry, notifier });
  scheduler.start();
  logger.info({ instance: INSTANCE_ID }, "Monitoring worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Stopping worker, waiting for in-flight checks");
    await scheduler.stop();
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
