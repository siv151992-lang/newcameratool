import { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { aiSettingsSchema, assistantAvailability, getAiSettings, requireAiEnabled, updateAiSettings } from "../ai/aiSettings.js";
import { chatSchema, runAssistant } from "../ai/assistant.js";
import { getCameraForecast, getFleetInsights, insightsForClient } from "../ai/insightsService.js";
import { buildReport, REPORT_PERIODS, summarizeReport, type ReportPeriod } from "../ai/report.js";
import { actorOf, orgOf, requirePermission } from "../auth/middleware.js";
import { param, parse } from "../lib/validate.js";
import { audit } from "../services/auditService.js";
import { aiLimiter } from "./limits.js";

/**
 * AI Mode endpoints. All are read-only views over monitoring data, so turning AI Mode off (or the
 * AI service being unreachable) never affects checks, alerts or camera management.
 */
export const aiRouter = Router();

const whenEnabled = (req: Request, _res: Response, next: NextFunction) => {
  Promise.resolve().then(() => requireAiEnabled(orgOf(req))).then(() => next(), next);
};
const periodSchema = z.object({ period: z.enum(Object.keys(REPORT_PERIODS) as [ReportPeriod, ...ReportPeriod[]]).default("24h") });

aiRouter.get("/status", requirePermission("cameras:read"), async (req, res) => {
  const settings = await getAiSettings(orgOf(req));
  res.json({ enabled: settings.enabled, assistant: assistantAvailability() });
});

aiRouter.patch("/settings", requirePermission("settings:write"), async (req, res) => {
  const patch = parse(aiSettingsSchema.partial(), req.body);
  const updated = await updateAiSettings(orgOf(req), patch, req.auth!.user.id);
  await audit({ actor: actorOf(req), ip: req.ip, action: "settings.ai_updated", entityType: "settings", entityId: "ai", details: patch });
  res.json(updated);
});

aiRouter.get("/insights", requirePermission("cameras:read"), whenEnabled, async (req, res) => {
  res.json(insightsForClient(await getFleetInsights(orgOf(req))));
});

aiRouter.get("/cameras/:id/forecast", requirePermission("cameras:read"), whenEnabled, async (req, res) => {
  const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(30).default(14) }), req.query);
  res.json(await getCameraForecast(orgOf(req), param(req), days));
});

aiRouter.post("/assistant", requirePermission("cameras:read"), whenEnabled, aiLimiter, async (req, res) => {
  const input = parse(chatSchema, req.body);
  const result = await runAssistant(input, { permissions: req.auth!.user.permissions, organizationId: orgOf(req) });
  await audit({
    actor: actorOf(req), ip: req.ip, action: "ai.assistant_question", entityType: "ai", entityId: "assistant",
    details: { tools: result.toolCalls.map((t) => t.name), stopReason: result.stopReason },
  });
  res.json(result);
});

aiRouter.get("/report", requirePermission("cameras:read"), whenEnabled, async (req, res) => {
  const { period } = parse(periodSchema, req.query);
  res.json(await buildReport(orgOf(req), period));
});

aiRouter.post("/report/summary", requirePermission("cameras:read"), whenEnabled, aiLimiter, async (req, res) => {
  const { period } = parse(periodSchema, req.body ?? {});
  const report = await buildReport(orgOf(req), period);
  res.json({ ...report, aiSummary: await summarizeReport(report) });
});
