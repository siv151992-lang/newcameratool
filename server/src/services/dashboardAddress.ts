import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { getEmailSettings, updateEmailSettings } from "./emailSettings.js";

/**
 * Fills in the dashboard address (the start of every emailed and copied link) when it is not set,
 * so links carry the server's network address instead of nothing or localhost.
 */

const LOCAL = /^(localhost|127\.|\[::1\]$|0\.0\.0\.0$)/;
const isLocal = (url: string) => {
  try {
    return LOCAL.test(new URL(url).hostname);
  } catch {
    return true;
  }
};

/** Unset, or a localhost address nobody else can open. */
export async function needsDashboardAddress(): Promise<boolean> {
  const { publicUrl } = await getEmailSettings();
  return !publicUrl || isLocal(publicUrl);
}

/** From the Caddy site address in Docker Compose (SITE_ADDRESS, HTTPS_PORT). */
export function fromSiteAddress(site: string | undefined, httpsPort: number | undefined): string | null {
  const host = site?.trim().replace(/^https?:\/\//, "").split(/[\s,/]/)[0];
  if (!host || host.startsWith(":") || LOCAL.test(host)) return null;
  return `https://${host}${httpsPort && httpsPort !== 443 && !host.includes(":") ? `:${httpsPort}` : ""}`;
}

/** The server's own network address, when it runs directly on the machine (not in a container). */
export function fromInterfaces(port: number, interfaces = networkInterfaces()): string | null {
  for (const list of Object.values(interfaces)) {
    const found = list?.find((a) => a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."));
    if (found) return `http://${found.address}${port === 80 ? "" : `:${port}`}`;
  }
  return null;
}

async function save(url: string, how: string) {
  await updateEmailSettings({ publicUrl: url }, null);
  logger.info({ publicUrl: url }, `Dashboard address set ${how} (change it in Settings → Email & sign-in)`);
}

/** At startup: from SITE_ADDRESS, else the machine's network address. Inside a container the
 * machine's address is the container's own, which nobody can open, so that is left to sign-in. */
export async function detectDashboardAddress() {
  if (!(await needsDashboardAddress())) return;
  const inContainer = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
  const url = fromSiteAddress(config.SITE_ADDRESS, config.HTTPS_PORT) ?? (inContainer ? null : fromInterfaces(config.PORT));
  if (url) await save(url, "from this server's address");
}

/** At a system administrator's sign-in: the address their browser opened the dashboard at. */
export async function learnDashboardAddress(origin: string | undefined, isSystemAdmin: boolean) {
  if (!isSystemAdmin || !origin || !/^https?:\/\/[^/]+$/.test(origin) || isLocal(origin)) return;
  if (!(await needsDashboardAddress())) return;
  await save(origin, "from the address the dashboard was opened at");
}
