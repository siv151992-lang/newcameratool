import { z } from "zod";
import { config } from "../config.js";
import { pool, type Queryable } from "../db/pool.js";
import { HttpError } from "../lib/errors.js";

/** AI Mode on/off, stored like the monitoring settings. Monitoring never reads this. */
export const aiSettingsSchema = z.object({ enabled: z.boolean() }).strict();
export type AiSettings = z.infer<typeof aiSettingsSchema>;
const DEFAULTS: AiSettings = { enabled: true };

export async function getAiSettings(db: Queryable = pool): Promise<AiSettings> {
  const { rows } = await db.query<{ value: Partial<AiSettings> }>("SELECT value FROM app_settings WHERE key = 'ai'");
  const parsed = aiSettingsSchema.safeParse({ ...DEFAULTS, ...(rows[0]?.value ?? {}) });
  return parsed.success ? parsed.data : DEFAULTS;
}

export async function updateAiSettings(patch: Partial<AiSettings>, userId: string | null, db: Queryable = pool): Promise<AiSettings> {
  const next = aiSettingsSchema.parse({ ...(await getAiSettings(db)), ...patch });
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ('ai', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(next), userId],
  );
  return next;
}

/** Whether the language-model features (assistant, report summaries) can run, and why not. */
export function assistantAvailability(): { available: boolean; model: string; reason?: string } {
  if (!config.ANTHROPIC_API_KEY) {
    return { available: false, model: config.AI_MODEL, reason: "Set ANTHROPIC_API_KEY on the server to enable the assistant." };
  }
  return { available: true, model: config.AI_MODEL };
}

export async function requireAiEnabled() {
  if (!(await getAiSettings()).enabled) {
    throw new HttpError(403, "AI_DISABLED", "AI Mode is turned off. An administrator can enable it in Settings → AI Mode.");
  }
}
