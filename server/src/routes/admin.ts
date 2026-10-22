import { Router } from "express";
import { z } from "zod";
import { actorOf, requirePermission } from "../auth/middleware.js";
import { pool } from "../db/pool.js";
import { registry } from "../integrations/registry.js";
import { hostGuard } from "../security/hostGuardInstance.js";
import { param, parse } from "../lib/validate.js";
import { notifier } from "../notifications/notifier.js";
import { audit, exportAuditCsv, listAudit } from "../services/auditService.js";
import {
  channelInputSchema,
  channelUpdateSchema,
  createChannel,
  deleteChannel,
  listChannels,
  testChannel,
  updateChannel,
} from "../services/notificationChannelService.js";
import { camerasOutside, getNetworkSettings, networkSettingsSchema, updateNetworkSettings } from "../services/networkSettings.js";
import { getMonitoringSettings, monitoringSettingsSchema, updateMonitoringSettings } from "../services/settingsService.js";
import { createUser, createUserSchema, listUsers, updateUser, updateUserSchema } from "../services/userService.js";

export const brandsRouter = Router();
brandsRouter.get("/", requirePermission("cameras:read"), async (_req, res) => {
  const { rows } = await pool.query<{ brand_key: string; n: number }>(
    "SELECT brand_key, count(*)::int AS n FROM cameras WHERE deleted_at IS NULL GROUP BY brand_key",
  );
  const counts = new Map(rows.map((r) => [r.brand_key, r.n]));
  res.json(registry.list().map((b) => ({ ...b, cameraCount: counts.get(b.key) ?? 0 })));
});

export const settingsRouter = Router();
settingsRouter.get("/monitoring", requirePermission("settings:read"), async (_req, res) => {
  res.json(await getMonitoringSettings());
});
settingsRouter.patch("/monitoring", requirePermission("settings:write"), async (req, res) => {
  const patch = parse(monitoringSettingsSchema.partial(), req.body);
  const updated = await updateMonitoringSettings(patch, req.auth!.user.id);
  await audit({ actor: actorOf(req), ip: req.ip, action: "settings.monitoring_updated", entityType: "settings", entityId: "monitoring", details: patch });
  res.json(updated);
});
settingsRouter.get("/networks", requirePermission("settings:read"), async (_req, res) => {
  const s = await getNetworkSettings();
  res.json({ ...s, camerasOutside: await camerasOutside(s.allowedNetworks) });
});
settingsRouter.patch("/networks", requirePermission("settings:write"), async (req, res) => {
  const before = await getNetworkSettings();
  const updated = await updateNetworkSettings(parse(networkSettingsSchema, req.body), req.auth!.user.id);
  hostGuard.invalidate();
  await audit({
    actor: actorOf(req), ip: req.ip, action: "settings.networks_updated", entityType: "settings", entityId: "networks",
    details: { from: before.allowedNetworks, to: updated.allowedNetworks },
  });
  res.json({ ...updated, camerasOutside: await camerasOutside(updated.allowedNetworks) });
});
settingsRouter.get("/notifications", requirePermission("settings:read"), async (_req, res) => {
  res.json(await listChannels());
});
settingsRouter.post("/notifications", requirePermission("settings:write"), async (req, res) => {
  res.status(201).json(await createChannel(notifier, parse(channelInputSchema, req.body), actorOf(req), req.ip));
});
settingsRouter.patch("/notifications/:id", requirePermission("settings:write"), async (req, res) => {
  res.json(await updateChannel(notifier, param(req), parse(channelUpdateSchema, req.body), actorOf(req), req.ip));
});
settingsRouter.delete("/notifications/:id", requirePermission("settings:write"), async (req, res) => {
  await deleteChannel(param(req), actorOf(req), req.ip);
  res.status(204).end();
});
settingsRouter.post("/notifications/:id/test", requirePermission("settings:write"), async (req, res) => {
  res.json(await testChannel(notifier, param(req)));
});

export const usersRouter = Router();
usersRouter.use(requirePermission("users:manage"));
usersRouter.get("/", async (_req, res) => {
  res.json(await listUsers());
});
usersRouter.post("/", async (req, res) => {
  const id = await createUser(parse(createUserSchema, req.body), actorOf(req), req.ip);
  res.status(201).json({ id });
});
usersRouter.patch("/:id", async (req, res) => {
  await updateUser(param(req), parse(updateUserSchema, req.body), actorOf(req), req.ip);
  res.status(204).end();
});

export const auditRouter = Router();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
auditRouter.get("/export", requirePermission("audit:read"), async (req, res) => {
  const q = parse(
    z.object({ from: day.optional(), to: day.optional(), timeZone: z.string().min(1).max(64).default("UTC") })
      .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "From must not be after To", path: ["from"] }),
    req.query,
  );
  const { csv, rows, truncated } = await exportAuditCsv(q);
  await audit({ actor: actorOf(req), ip: req.ip, action: "audit.exported", entityType: "audit", details: { from: q.from ?? "start", to: q.to ?? "now", rows } });
  const name = `audit-log${q.from ? `-${q.from}` : ""}${q.to ? `-to-${q.to}` : ""}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  if (truncated) res.setHeader("X-Export-Truncated", "true");
  res.send(csv);
});
auditRouter.get("/", requirePermission("audit:read"), async (req, res) => {
  const q = parse(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
      entityType: z.string().max(40).optional(),
      entityId: z.string().max(80).optional(),
    }),
    req.query,
  );
  res.json(await listAudit(q));
});
